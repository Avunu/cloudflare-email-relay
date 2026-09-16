import type { RelayEnv } from "./env";
import { parseTenantSecret, secretNameFor, wildcardBase } from "./tenant-schema";
import type { Tenant, TenantTable } from "./tenant-schema";

// ---------------------------------------------------------------------------
// The tenant registry: routing by recipient domain, and the lazy merge of a
// tenant's committed row with its Worker secret.
//
// The public table is validated once, when the Worker is built (createRelay),
// so a bad table is a failed deploy rather than a running relay that misroutes.
// Secrets are read per tenant, per alarm pass: a missing or malformed
// TENANT_<SLUG> only ever stops that tenant's deliveries (its rows stay pending
// and the error is logged every pass) and never touches intake or any other
// tenant. Nothing about a failed secret is cached, so fixing it takes effect on
// the next pass with no redeploy.
// ---------------------------------------------------------------------------

/** A Cloudflare Access service token, sent on every delivery when the route sits behind Access. */
export interface AccessCredentials {
	readonly clientId: string;
	readonly clientSecret: string;
}

/** Everything one delivery attempt needs, resolved for one tenant. */
export interface TenantConfig {
	readonly tenant: Tenant;
	/** Where deliveries are POSTed. Embeds the ERP's per-server key — never log it. */
	readonly inboundUrl: string;
	readonly webhookSecret: string;
	readonly access: AccessCredentials | null;
	readonly retentionMs: number;
	readonly maxAttempts: number;
	readonly backoffSeconds: readonly number[];
	readonly deliveryTimeoutMs: number;
	readonly deliveryDelayMs: number;
}

const DAY_MS = 86_400_000;

/** A tenant whose secret half is missing or malformed. The message names fields only. */
export class TenantConfigError extends Error {
	readonly slug: string;

	constructor(slug: string, detail: string) {
		super(`Invalid configuration for tenant "${slug}": ${secretNameFor(slug)} ${detail}`);
		this.name = "TenantConfigError";
		this.slug = slug;
	}
}

/**
 * The domain of an envelope address, normalised the way the table is written: lower-case, trailing
 * dot dropped, IDN converted to its A-label. Null for anything that is not a plain `local@domain`
 * with a hostname the URL parser accepts (an IP literal, an empty domain, junk).
 */
export function domainOf(address: string): string | null {
	const at = address.lastIndexOf("@");
	if (at === -1) {
		return null;
	}
	let domain = address
		.slice(at + 1)
		.trim()
		.toLowerCase();
	if (domain.endsWith(".")) {
		domain = domain.slice(0, -1);
	}
	if (domain === "" || domain.startsWith("[")) {
		return null;
	}
	try {
		// The URL parser is the one IDNA implementation the runtime ships with.
		const { hostname } = new URL(`http://${domain}`);
		return hostname === "" ? null : hostname;
	} catch {
		return null;
	}
}

export class TenantRegistry {
	private readonly bySlug = new Map<string, Tenant>();
	private readonly exact = new Map<string, Tenant>();
	/** Wildcard bases, longest first, so `*.a.example.com` wins over `*.example.com`. */
	private readonly wildcards: readonly (readonly [base: string, tenant: Tenant])[];

	constructor(table: TenantTable) {
		const wildcards: [string, Tenant][] = [];
		for (const tenant of table) {
			this.bySlug.set(tenant.slug, tenant);
			for (const domain of tenant.domains) {
				const base = wildcardBase(domain);
				if (base === null) {
					this.exact.set(domain, tenant);
				} else {
					wildcards.push([base, tenant]);
				}
			}
		}
		wildcards.sort((a, b) => b[0].length - a[0].length);
		this.wildcards = wildcards;
	}

	list(): TenantTable {
		return [...this.bySlug.values()];
	}

	get(slug: string): Tenant | null {
		return this.bySlug.get(slug) ?? null;
	}

	/**
	 * The tenant that owns an envelope recipient: an exact domain first, then the most specific
	 * wildcard whose base the domain sits under (never the base itself). Null means the relay does
	 * not serve that domain and the message must be refused, not guessed at.
	 */
	route(address: string): Tenant | null {
		const domain = domainOf(address);
		if (domain === null) {
			return null;
		}
		const exact = this.exact.get(domain);
		if (exact !== undefined) {
			return exact;
		}
		for (const [base, tenant] of this.wildcards) {
			if (domain.endsWith(`.${base}`)) {
				return tenant;
			}
		}
		return null;
	}

	/**
	 * The row merged with its Worker secret. Throws TenantConfigError for an unknown slug or a
	 * missing/blank/malformed secret; the error names the secret and its bad fields, never values.
	 */
	resolve(slug: string, env: Pick<RelayEnv, `TENANT_${string}`>): TenantConfig {
		const tenant = this.bySlug.get(slug);
		if (tenant === undefined) {
			throw new TenantConfigError(slug, "belongs to no tenant in the table");
		}
		const name = secretNameFor(slug);
		const raw = env[name as `TENANT_${string}`];
		if (typeof raw !== "string" || raw.trim() === "") {
			throw new TenantConfigError(slug, "is not set");
		}
		let secret;
		try {
			secret = parseTenantSecret(raw.trim());
		} catch (error) {
			throw new TenantConfigError(slug, error instanceof Error ? error.message : String(error));
		}
		return {
			tenant,
			inboundUrl: secret.inboundUrl,
			webhookSecret: secret.secret,
			access:
				secret.accessClientId !== undefined && secret.accessClientSecret !== undefined
					? { clientId: secret.accessClientId, clientSecret: secret.accessClientSecret }
					: null,
			retentionMs: tenant.retentionDays * DAY_MS,
			maxAttempts: tenant.maxAttempts,
			backoffSeconds: tenant.backoffSeconds,
			deliveryTimeoutMs: tenant.deliveryTimeoutSeconds * 1000,
			deliveryDelayMs: tenant.deliveryDelaySeconds * 1000,
		};
	}
}
