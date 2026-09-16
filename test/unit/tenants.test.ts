import { describe, it, expect } from "vitest";
import { parseTenantTable, secretNameFor } from "../../src/tenant-schema";
import { TenantConfigError, TenantRegistry, domainOf } from "../../src/tenants";

const URL = "https://erp.acme.example/mail_cloudflare/inbound/k3y-that-is-secret";
const SECRET = "a-webhook-secret-of-sufficient-length";

const registry = new TenantRegistry(
	parseTenantTable([
		{ slug: "acme", platform: "odoo", domains: ["acme.example", "*.acme.example"] },
		{
			slug: "acme-eu",
			platform: "frappe",
			domains: ["acme-eu.example", "*.acme-eu.example"],
			retentionDays: 7,
		},
		{ slug: "beta", platform: "frappe", domains: ["beta.example"], enabled: false },
	]),
);

describe("domainOf", () => {
	it("lower-cases, drops a trailing dot and converts IDN to punycode", () => {
		expect(domainOf("Alice@Example.COM")).toBe("example.com");
		expect(domainOf("alice@example.com.")).toBe("example.com");
		expect(domainOf("alice@bücher.example")).toBe("xn--bcher-kva.example");
		expect(domainOf("josé@acme.example")).toBe("acme.example");
	});

	it("is null for anything that is not local@hostname", () => {
		for (const address of ["", "alice", "alice@", "alice@[192.0.2.1]", "alice@exa mple.com"]) {
			expect(domainOf(address), address).toBeNull();
		}
	});
});

describe("TenantRegistry.route", () => {
	it("matches an exact domain, case-insensitively", () => {
		expect(registry.route("support@acme.example")?.slug).toBe("acme");
		expect(registry.route("Support@ACME.Example")?.slug).toBe("acme");
	});

	it("matches a wildcard at any depth, and never confuses a look-alike suffix", () => {
		expect(registry.route("x@shop.acme.example")?.slug).toBe("acme");
		expect(registry.route("x@a.b.acme.example")?.slug).toBe("acme");
		expect(registry.route("x@shop.acme-eu.example")?.slug).toBe("acme-eu");
		expect(registry.route("x@acme-eu.example")?.slug).toBe("acme-eu");
	});

	it("returns null for an unserved or malformed recipient", () => {
		expect(registry.route("x@other.example")).toBeNull();
		expect(registry.route("x@notacme.example")).toBeNull();
		expect(registry.route("x@example")).toBeNull();
		expect(registry.route("no-at-sign")).toBeNull();
	});

	it("routes to a disabled tenant too — the handler decides what to do with it", () => {
		expect(registry.route("x@beta.example")?.enabled).toBe(false);
	});
});

describe("TenantRegistry.get / list", () => {
	it("looks tenants up by slug", () => {
		expect(registry.get("acme-eu")?.retentionDays).toBe(7);
		expect(registry.get("nope")).toBeNull();
		expect(registry.list().map((t) => t.slug)).toEqual(["acme", "acme-eu", "beta"]);
	});
});

describe("TenantRegistry.resolve", () => {
	const env = { [secretNameFor("acme")]: JSON.stringify({ inboundUrl: URL, secret: SECRET }) };

	it("merges the row with its secret", () => {
		const config = registry.resolve("acme", env);
		expect(config.tenant.slug).toBe("acme");
		expect(config.inboundUrl).toBe(URL);
		expect(config.webhookSecret).toBe(SECRET);
		expect(config.access).toBeNull();
		expect(config.retentionMs).toBe(30 * 86_400_000);
		expect(config.maxAttempts).toBe(32);
		expect(config.deliveryTimeoutMs).toBe(30_000);
		expect(config.deliveryDelayMs).toBe(0);
	});

	it("carries an Access token when the secret has one", () => {
		const withAccess = {
			TENANT_ACME: JSON.stringify({
				inboundUrl: URL,
				secret: SECRET,
				accessClientId: "id",
				accessClientSecret: "s",
			}),
		};
		expect(registry.resolve("acme", withAccess).access).toEqual({
			clientId: "id",
			clientSecret: "s",
		});
	});

	it("throws a TenantConfigError naming the secret for an unknown, unset or bad secret", () => {
		const failure = (slug: string, e: Record<string, string | undefined>): TenantConfigError => {
			try {
				registry.resolve(slug, e);
			} catch (error) {
				if (error instanceof TenantConfigError) {
					return error;
				}
				throw error;
			}
			throw new Error("expected resolve to throw");
		};
		expect(failure("nope", env).message).toContain("no tenant");
		expect(failure("acme-eu", env).message).toContain("TENANT_ACME_EU is not set");
		expect(failure("acme", { TENANT_ACME: "  " }).message).toContain("is not set");
		expect(failure("acme", { TENANT_ACME: "{oops" }).message).toContain("not valid JSON");
		const bad = failure("acme", {
			TENANT_ACME: JSON.stringify({ inboundUrl: "gopher://x/secret-key", secret: "short" }),
		});
		expect(bad.slug).toBe("acme");
		expect(bad.message).toContain("inboundUrl");
		expect(bad.message).toContain("secret");
		expect(bad.message).not.toContain("secret-key");
		expect(bad.message).not.toContain("short");
	});
});
