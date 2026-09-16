// The fake ERPs the integration suites deliver to, plus the tenants and bindings they run with.
//
// This module is imported by vitest.integration.config.ts (Node, where miniflare's
// `outboundService` runs) AND by the tests and the test worker (workerd, for the constants), so it
// must not touch `cloudflare:test`, the filesystem or anything else only one side has. The
// captured deliveries live in this Node-side Map and are read back from workerd through the
// `control.test` origin: the two sides share no memory, only the outbound fetch path, which is
// exactly what makes the capture faithful — it sees the bytes and headers the worker really sent.

import type { TenantInput } from "../../src/tenant-schema";

export const ODOO_ORIGIN = "https://odoo-alpha.test";
export const ODOO_INBOUND_URL = `${ODOO_ORIGIN}/mail_cloudflare/inbound/test-server-key`;
export const FRAPPE_ORIGIN = "https://frappe-beta.test";
export const FRAPPE_INBOUND_URL = `${FRAPPE_ORIGIN}/api/method/cloudflare_email_delivery.api.inbound?key=test-account-key`;
export const ALPHA_SECRET = "alpha-integration-secret-0123456789";
export const BETA_SECRET = "beta-integration-secret-0123456789";
export const OPS_TOKEN = "integration-ops-token-0123456789-abcdef";
export const CONTROL_ORIGIN = "https://control.test";

/** The tunables every fixture tenant shares: alarms only fire on demand, failures give up fast. */
const TUNABLES: Omit<TenantInput, "slug" | "platform" | "domains"> = {
	retentionDays: 30,
	maxAttempts: 3,
	backoffSeconds: [60, 300],
	// The `slow@` recipient sleeps longer than this so the timeout path is exercised.
	deliveryTimeoutSeconds: 1,
	// Enqueued rows are due an hour out; tests rewind them and fire the alarm deliberately with
	// runDurableObjectAlarm(), so no delivery ever happens behind a test's back.
	deliveryDelaySeconds: 3600,
};

/**
 * The tenant table the test worker is built with:
 *
 * - `alpha` — an Odoo instance, on `alpha.test` and every subdomain.
 * - `beta` — a Frappe site, on `beta.test`; answers in Frappe's `{"message": …}` shape.
 * - `gamma` — disabled: its mail is rejected at intake.
 * - `delta` — enabled, but its TENANT_DELTA secret is malformed: its rows never deliver.
 */
export const TEST_TENANTS: readonly TenantInput[] = [
	{ slug: "alpha", platform: "odoo", domains: ["alpha.test", "*.alpha.test"], ...TUNABLES },
	{ slug: "beta", platform: "frappe", domains: ["beta.test"], ...TUNABLES },
	{ slug: "gamma", platform: "odoo", domains: ["gamma.test"], enabled: false, ...TUNABLES },
	{ slug: "delta", platform: "odoo", domains: ["delta.test"], ...TUNABLES },
];

// oxfmt rewrites escape sequences inside string literals into the bytes they denote, so the line
// ending is spelled out by code point to stay visible (and unmangled) in the source.
const CRLF = String.fromCodePoint(13, 10);

/**
 * Test/fixtures/simple.eml, line by line. The same bytes the wrangler dev recipe POSTs; kept here
 * as well because workerd has no filesystem to read the file from and Node's is off-limits to the
 * config under the lint rules. CRLF-terminated lines, like the file.
 */
export const FIXTURE_EML = [
	"Message-ID: <simple-0001@example.com>",
	"Date: Mon, 14 Sep 2026 12:00:00 +0000",
	"From: Alice Example <alice@example.com>",
	"To: support@erp.example.com",
	"Subject: Hello from the fixture",
	"MIME-Version: 1.0",
	"Content-Type: text/plain; charset=utf-8",
	"Content-Transfer-Encoding: 7bit",
	"",
	"Hi there,",
	"",
	"This is the simple fixture message used by the tests and the wrangler dev recipe.",
	"",
	"-- ",
	"Alice",
]
	.map((line) => `${line}${CRLF}`)
	.join("");

/** The secrets the suites run with, one per tenant; delta's is deliberately broken. */
export const BINDINGS = {
	OPS_TOKEN,
	TENANT_ALPHA: JSON.stringify({ inboundUrl: ODOO_INBOUND_URL, secret: ALPHA_SECRET }),
	TENANT_BETA: JSON.stringify({ inboundUrl: FRAPPE_INBOUND_URL, secret: BETA_SECRET }),
	TENANT_GAMMA: JSON.stringify({ inboundUrl: ODOO_INBOUND_URL, secret: ALPHA_SECRET }),
	TENANT_DELTA: "{not json",
} as const;

/** One delivery as the fake ERP received it. */
export interface CapturedDelivery {
	readonly method: string;
	readonly path: string;
	readonly search: string;
	/** Header names lower-cased, as `Headers` iterates them. */
	readonly headers: Record<string, string>;
	/** The body bytes, as a plain array so they survive JSON. */
	readonly body: number[];
}

const captured = new Map<string, CapturedDelivery>();

/** How long `slow@` stalls — comfortably past deliveryTimeoutSeconds. */
const SLOW_MS = 1500;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/** Odoo's controller answers the contract's object directly. */
function odooAnswer(local: string, id: string): Promise<Response> {
	switch (local) {
		case "fail500": {
			return Promise.resolve(
				Response.json({ ok: false, error: "internal error" }, { status: 500 }),
			);
		}
		case "reject422": {
			return Promise.resolve(
				Response.json({ ok: false, error: "No possible route found" }, { status: 422 }),
			);
		}
		case "redirect": {
			return Promise.resolve(
				new Response(null, { status: 302, headers: { Location: "https://elsewhere.test/" } }),
			);
		}
		case "slow": {
			return sleep(SLOW_MS).then(() => Response.json({ ok: true, remote_ref: "1", id }));
		}
		case "nothread": {
			return Promise.resolve(Response.json({ ok: true, remote_ref: null, id }));
		}
		case "legacy": {
			// The shape the Odoo module answered with before `remote_ref` existed.
			return Promise.resolve(Response.json({ ok: true, thread_id: 42, id }));
		}
		case "plain200": {
			return Promise.resolve(new Response("OK", { status: 200 }));
		}
		default: {
			return Promise.resolve(Response.json({ ok: true, remote_ref: "42", id }));
		}
	}
}

/**
 * Frappe wraps a whitelisted method's return value as `{"message": …}` and reports an uncaught
 * exception as `{"exception": "…", "exc_type": …}` with the status the exception carries (417 for a
 * validation error, 500 otherwise).
 */
function frappeAnswer(local: string, id: string): Promise<Response> {
	switch (local) {
		case "fail500": {
			return Promise.resolve(
				Response.json(
					{ exception: "RuntimeError: database went away\nTraceback (most recent call last)" },
					{ status: 500 },
				),
			);
		}
		case "reject417": {
			return Promise.resolve(
				Response.json(
					{ exception: "frappe.exceptions.ValidationError: Append To is required" },
					{ status: 417 },
				),
			);
		}
		case "reject422": {
			return Promise.resolve(
				Response.json(
					{ message: { ok: false, error: "recipient domain does not belong to this account" } },
					{ status: 422 },
				),
			);
		}
		case "nothread": {
			return Promise.resolve(Response.json({ message: { ok: true, remote_ref: null, id } }));
		}
		case "legacy": {
			return Promise.resolve(
				Response.json({ message: { ok: true, communication: "COMM-0001", id } }),
			);
		}
		default: {
			return Promise.resolve(Response.json({ message: { ok: true, remote_ref: "COMM-0042", id } }));
		}
	}
}

/**
 * Answer by origin (which fake ERP) and by the envelope recipient's local part, so a test picks the
 * ERP's behaviour simply by choosing an address:
 *
 * - `fail500@…` → 500, the transient-failure path (retry with backoff)
 * - `reject422@…` → 422 with the contract's error shape (unroutable: parked as rejected)
 * - `reject417@…` (Frappe) → 417 with Frappe's exception shape (parked as rejected)
 * - `redirect@…` (Odoo) → 302 (a misconfigured URL: never followed, parked as rejected)
 * - `slow@…` (Odoo) → stalls past the delivery timeout (network-level failure: retry)
 * - `nothread@…` → 200 with `remote_ref: null` (a duplicate the ERP ignored: delivered)
 * - `legacy@…` → 200 in the platform's pre-contract shape (`thread_id` / `communication`)
 * - `plain200@…` (Odoo) → 200 with a non-JSON body (delivered, reference unknown)
 * - Anything else → 200 with a remote reference
 *
 * Every other host is refused with a 502 so a test that starts depending on the network fails
 * loudly instead of quietly reaching out.
 */
export async function outboundService(request: Request): Promise<Response> {
	const url = new URL(request.url);

	if (url.origin === CONTROL_ORIGIN) {
		const id = url.pathname.split("/").pop() ?? "";
		const hit = captured.get(id);
		return hit === undefined
			? new Response("no such delivery", { status: 404 })
			: Response.json(hit);
	}

	const platform =
		url.origin === ODOO_ORIGIN ? "odoo" : url.origin === FRAPPE_ORIGIN ? "frappe" : null;
	if (platform === null || request.method !== "POST") {
		return new Response(`unexpected outbound request to ${request.url}`, { status: 502 });
	}

	const headers: Record<string, string> = {};
	for (const [name, value] of request.headers) {
		headers[name] = value;
	}
	const body = [...new Uint8Array(await request.arrayBuffer())];
	const id = headers["x-email-relay-id"] ?? "";
	captured.set(id, {
		method: request.method,
		path: url.pathname,
		search: url.search,
		headers,
		body,
	});

	const [local] = (headers["x-email-relay-envelope-to"] ?? "").split("@");
	return platform === "odoo" ? odooAnswer(local ?? "", id) : frappeAnswer(local ?? "", id);
}
