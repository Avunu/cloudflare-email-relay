import { z } from "zod";

// ---------------------------------------------------------------------------
// The tenant model: what the fleet commits, and what it keeps as a secret.
//
// A tenant is one ERP instance (an Odoo database or a Frappe site). Its public
// half — slug, platform, the domains routed to it, retry/retention tunables —
// is a row in the fleet's committed `tenants.json`, bundled into the Worker at
// build time and reviewed like any other change. Its secret half — the inbound
// URL (which embeds the ERP's per-server key), the HMAC secret and an optional
// Cloudflare Access service token — is one Worker secret named after the slug
// (see secretNameFor), so rotating one tenant never touches another and the
// repository never holds a capability.
//
// This module imports nothing but zod: it is published as the package's
// "./tenants" subpath so the fleet's Node scripts can validate a table with
// the very same rules the Worker applies, and it must therefore run in plain
// Node — no workerd-only APIs, and no extensionless sibling imports that only
// a bundler resolves.
// ---------------------------------------------------------------------------

/** The default retry schedule: 1 min, 5 min, 15 min, 1 h, then every 6 h. */
export const DEFAULT_BACKOFF_SECONDS: readonly number[] = [60, 300, 900, 3600, 21_600];

/** Lowercase letters, digits and hyphens; 1–63 characters; never an underscore (see secretNameFor). */
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;

/**
 * A lowercase A-label hostname with at least one dot, optionally prefixed by `*.` to claim every
 * subdomain (never the apex itself). Internationalised domains are written in their punycode form,
 * which is also what an envelope address carries once URL-normalised in the router.
 */
export const DOMAIN_PATTERN =
	/^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;

const MAX_RETENTION_DAYS = 3650;
const MAX_ATTEMPTS_CEILING = 10_000;
const MAX_TIMEOUT_SECONDS = 60;
const MAX_DELAY_SECONDS = 7 * 86_400;
const MAX_NOTE_CHARS = 200;

/** The knobs an operator may set per tenant, each with the package default. */
export const TenantTunablesSchema = z.object({
	/** Days a delivered message stays in R2; 0 deletes the object the moment the ERP accepts it. */
	retentionDays: z.number().int().min(0).max(MAX_RETENTION_DAYS).default(30),
	/** Attempts before a message is marked dead (32 ≈ 7 days on the default schedule). */
	maxAttempts: z.number().int().min(1).max(MAX_ATTEMPTS_CEILING).default(32),
	/** Retry delays in seconds, applied by attempt number; the last one repeats. */
	backoffSeconds: z
		.array(z.number().int().min(1))
		.min(1)
		.default([...DEFAULT_BACKOFF_SECONDS]),
	/** Per-attempt HTTP timeout in seconds. */
	deliveryTimeoutSeconds: z.number().int().min(1).max(MAX_TIMEOUT_SECONDS).default(30),
	/** Wait before the first attempt. Zero in production; tests raise it so alarms fire on demand. */
	deliveryDelaySeconds: z.number().int().min(0).max(MAX_DELAY_SECONDS).default(0),
});

export const PLATFORMS = ["odoo", "frappe"] as const;
export type Platform = (typeof PLATFORMS)[number];

/** One committed tenant row. */
export const TenantSchema = TenantTunablesSchema.extend({
	slug: z.string().regex(SLUG_PATTERN),
	platform: z.enum(PLATFORMS),
	/** The recipient domains routed to this tenant; matched on the envelope recipient. */
	domains: z.array(z.string().regex(DOMAIN_PATTERN)).min(1),
	/**
	 * False rejects the tenant's mail at SMTP time (offboarded, suspended). Its queue stays
	 * reachable.
	 */
	enabled: z.boolean().default(true),
	/** Free text for operators (client name, ticket). Never read by code. */
	note: z.string().max(MAX_NOTE_CHARS).optional(),
});

/** What tenants.json holds (defaults may be omitted). */
export type TenantInput = z.input<typeof TenantSchema>;
/** A tenant with every default applied. */
export type Tenant = z.output<typeof TenantSchema>;
export type TenantTable = readonly Tenant[];

/** `*.example.com` → `example.com`; an exact domain → null. */
export function wildcardBase(domain: string): string | null {
	return domain.startsWith("*.") ? domain.slice(2) : null;
}

/** Whether `domain` (exact or the base of a wildcard) sits under the wildcard base `base`. */
function isUnder(domain: string, base: string): boolean {
	return domain.endsWith(`.${base}`);
}

/**
 * The cross-row rules a single row cannot check: every slug unique, every domain claimed once, and
 * no wildcard of one tenant reaching into another tenant's domains — either direction, because a
 * message routed by the wildcard would otherwise land in the wrong ERP. Slug uniqueness also makes
 * the secret names unique: the slug alphabet has no underscore, so secretNameFor is injective.
 */
function refineTable(table: readonly Tenant[], ctx: z.RefinementCtx): void {
	const slugs = new Map<string, number>();
	const claims = new Map<string, number>();
	for (const [index, tenant] of table.entries()) {
		const seen = slugs.get(tenant.slug);
		if (seen === undefined) {
			slugs.set(tenant.slug, index);
		} else {
			ctx.addIssue({
				code: "custom",
				path: [index, "slug"],
				message: `duplicate slug "${tenant.slug}" (also row ${seen})`,
			});
		}
		for (const [d, domain] of tenant.domains.entries()) {
			const owner = claims.get(domain);
			if (owner === undefined) {
				claims.set(domain, index);
			} else {
				ctx.addIssue({
					code: "custom",
					path: [index, "domains", d],
					message: `domain "${domain}" is already claimed by row ${owner}`,
				});
			}
		}
	}
	for (const [index, tenant] of table.entries()) {
		for (const [d, domain] of tenant.domains.entries()) {
			const base = wildcardBase(domain);
			if (base === null) {
				continue;
			}
			for (const [other, owner] of claims) {
				if (owner === index) {
					continue;
				}
				const otherBase = wildcardBase(other) ?? other;
				if (isUnder(otherBase, base)) {
					ctx.addIssue({
						code: "custom",
						path: [index, "domains", d],
						message: `wildcard "${domain}" covers "${other}" claimed by row ${owner}`,
					});
				}
			}
		}
	}
}

export const TenantTableSchema = z.array(TenantSchema).superRefine(refineTable);

/**
 * The secret half, stored as a JSON string in the Worker secret `TENANT_<SLUG>`. Only http(s) —
 * `fetch` would silently fail on anything else — and plain http so wrangler dev can target a local
 * ERP. The Access pair is both-or-neither: half a service token makes Access answer 403 to every
 * delivery, which the queue would park as a permanent rejection of each message.
 */
export const TenantSecretSchema = z
	.object({
		/** The ERP's inbound webhook URL, key included. Never logged. */
		inboundUrl: z.url({ protocol: /^https?$/ }),
		/** The HMAC-SHA256 key behind X-Email-Relay-Signature. */
		secret: z.string().min(16),
		accessClientId: z.string().min(1).optional(),
		accessClientSecret: z.string().min(1).optional(),
	})
	.superRefine((v, ctx) => {
		if ((v.accessClientId === undefined) !== (v.accessClientSecret === undefined)) {
			const missing = v.accessClientId === undefined ? "accessClientId" : "accessClientSecret";
			ctx.addIssue({
				code: "custom",
				path: [missing],
				message: "accessClientId and accessClientSecret must be set together",
			});
		}
	});

export type TenantSecret = z.output<typeof TenantSecretSchema>;

/**
 * The Worker secret that holds a tenant's secret half: `TENANT_` + the slug upper-cased with
 * hyphens as underscores. The slug alphabet has no underscore, so two slugs never share a name.
 */
export function secretNameFor(slug: string): string {
	return `TENANT_${slug.toUpperCase().replaceAll("-", "_")}`;
}

/** `path message` per issue — paths and messages only, never the offending value. */
function describeIssues(issues: readonly z.ZodIssue[]): string[] {
	return issues.map((issue) => {
		const path = issue.path
			.map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`))
			.join("");
		return `${path === "" ? "(root)" : path.replace(/^\./, "")} ${issue.message}`;
	});
}

/** A committed table that does not validate. Fatal: the Worker must not start on one. */
export class TenantTableError extends Error {
	readonly issues: readonly string[];

	constructor(issues: readonly string[]) {
		super(`Invalid tenant table: ${issues.join("; ")}`);
		this.name = "TenantTableError";
		this.issues = issues;
	}
}

/** Parse and validate a tenant table (the JSON the fleet commits), applying defaults. */
export function parseTenantTable(input: unknown): Tenant[] {
	const parsed = TenantTableSchema.safeParse(input);
	if (!parsed.success) {
		throw new TenantTableError(describeIssues(parsed.error.issues));
	}
	return parsed.data;
}

/**
 * Parse the JSON string a `TENANT_<SLUG>` secret holds. Throws an Error whose message names fields
 * only: the URL embeds the ERP's key and the rest are secrets, and the message ends up in logs.
 */
export function parseTenantSecret(raw: string): TenantSecret {
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		throw new TypeError("secret is not valid JSON");
	}
	const parsed = TenantSecretSchema.safeParse(json);
	if (!parsed.success) {
		throw new TypeError(describeIssues(parsed.error.issues).join("; "));
	}
	return parsed.data;
}
