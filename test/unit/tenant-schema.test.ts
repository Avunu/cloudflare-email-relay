import { describe, it, expect } from "vitest";
import {
	DOMAIN_PATTERN,
	SLUG_PATTERN,
	TenantTableError,
	parseTenantSecret,
	parseTenantTable,
	secretNameFor,
} from "../../src/tenant-schema";
import type { TenantInput } from "../../src/tenant-schema";
import { DEFAULT_BACKOFF_SECONDS } from "../../src/lib/backoff";

function tenant(overrides: Partial<TenantInput> = {}): TenantInput {
	return { slug: "acme", platform: "odoo", domains: ["acme.example"], ...overrides };
}

/** The TenantTableError message for a table, for asserting what it names. */
function failure(table: unknown): string {
	try {
		parseTenantTable(table);
	} catch (error) {
		if (error instanceof TenantTableError) {
			return error.message;
		}
		throw error;
	}
	throw new Error("expected parseTenantTable to throw");
}

describe("SLUG_PATTERN", () => {
	it("accepts lowercase letters, digits and hyphens up to 63 characters", () => {
		for (const slug of ["a", "acme", "acme-2", "0", "a".repeat(63)]) {
			expect(SLUG_PATTERN.test(slug), slug).toBe(true);
		}
	});

	it("rejects underscores, uppercase, leading hyphens, dots and empty", () => {
		for (const slug of ["", "Acme", "acme_2", "-acme", "acme.example", "a".repeat(64), "ac me"]) {
			expect(SLUG_PATTERN.test(slug), slug).toBe(false);
		}
	});
});

describe("DOMAIN_PATTERN", () => {
	it("accepts lowercase hostnames with a dot, and *. wildcards", () => {
		for (const domain of [
			"example.com",
			"mail.example.co.uk",
			"xn--bcher-kva.example",
			"*.example.com",
			"a-b.example",
		]) {
			expect(DOMAIN_PATTERN.test(domain), domain).toBe(true);
		}
	});

	it("rejects apex-less, uppercase, unicode, bare wildcards and trailing dots", () => {
		for (const domain of [
			"localhost",
			"Example.com",
			"bücher.example",
			"*",
			"*.",
			"*.*.example.com",
			"example.com.",
			"-a.example",
			"example.123",
			"",
		]) {
			expect(DOMAIN_PATTERN.test(domain), domain).toBe(false);
		}
	});
});

describe("parseTenantTable", () => {
	it("applies the documented defaults", () => {
		const [parsed] = parseTenantTable([tenant()]);
		expect(parsed).toEqual({
			slug: "acme",
			platform: "odoo",
			domains: ["acme.example"],
			enabled: true,
			retentionDays: 30,
			maxAttempts: 32,
			backoffSeconds: DEFAULT_BACKOFF_SECONDS,
			deliveryTimeoutSeconds: 30,
			deliveryDelaySeconds: 0,
		});
	});

	it("keeps every tunable that is given", () => {
		const [parsed] = parseTenantTable([
			tenant({
				platform: "frappe",
				enabled: false,
				note: "Acme Co",
				retentionDays: 0,
				maxAttempts: 3,
				backoffSeconds: [60, 300],
				deliveryTimeoutSeconds: 60,
				deliveryDelaySeconds: 3600,
			}),
		]);
		expect(parsed).toMatchObject({
			platform: "frappe",
			enabled: false,
			note: "Acme Co",
			retentionDays: 0,
			maxAttempts: 3,
			backoffSeconds: [60, 300],
			deliveryTimeoutSeconds: 60,
			deliveryDelaySeconds: 3600,
		});
	});

	it("accepts an empty table", () => {
		expect(parseTenantTable([])).toEqual([]);
	});

	it("rejects a row that is not a tenant, naming the path", () => {
		expect(failure([tenant({ slug: "Acme" })])).toContain("[0].slug");
		expect(failure([tenant({ platform: "sap" as "odoo" })])).toContain("[0].platform");
		expect(failure([tenant({ domains: [] })])).toContain("[0].domains");
		expect(failure([tenant({ domains: ["Example.com"] })])).toContain("[0].domains[0]");
		expect(failure([tenant({ maxAttempts: 0 })])).toContain("[0].maxAttempts");
		expect(failure([tenant({ backoffSeconds: [] })])).toContain("[0].backoffSeconds");
		expect(failure([tenant({ backoffSeconds: [0] })])).toContain("[0].backoffSeconds[0]");
		expect(failure([tenant({ deliveryTimeoutSeconds: 61 })])).toContain(
			"[0].deliveryTimeoutSeconds",
		);
		expect(failure({ acme: tenant() })).toContain("(root)");
		expect(failure("nope")).toContain("(root)");
	});

	it("rejects duplicate slugs and duplicate domains across rows", () => {
		expect(failure([tenant(), tenant({ domains: ["other.example"] })])).toContain(
			'duplicate slug "acme"',
		);
		expect(failure([tenant(), tenant({ slug: "other", domains: ["acme.example"] })])).toContain(
			'domain "acme.example" is already claimed by row 0',
		);
		expect(failure([tenant({ domains: ["acme.example", "acme.example"] })])).toContain(
			"[0].domains[1]",
		);
	});

	it("rejects a wildcard that covers another tenant's domain, in either direction", () => {
		const wild = tenant({ slug: "wild", domains: ["*.example.com"] });
		const exact = tenant({ slug: "exact", domains: ["shop.example.com"] });
		expect(failure([wild, exact])).toContain('wildcard "*.example.com" covers "shop.example.com"');
		expect(failure([exact, wild])).toContain('wildcard "*.example.com" covers "shop.example.com"');
		const nested = tenant({ slug: "nested", domains: ["*.eu.example.com"] });
		expect(failure([wild, nested])).toContain('covers "*.eu.example.com"');
		// The apex is not under its own wildcard, and a sibling is not under it either.
		expect(() =>
			parseTenantTable([
				wild,
				tenant({ slug: "apex", domains: ["example.com"] }),
				tenant({ slug: "sibling", domains: ["example.org", "*.example.org"] }),
			]),
		).not.toThrow();
	});

	it("collects every problem into one error", () => {
		const message = failure([tenant({ slug: "Bad" }), tenant({ domains: ["x"] })]);
		expect(message).toContain("[0].slug");
		expect(message).toContain("[1].domains[0]");
	});
});

describe("secretNameFor", () => {
	it("upper-cases the slug and turns hyphens into underscores", () => {
		expect(secretNameFor("acme")).toBe("TENANT_ACME");
		expect(secretNameFor("acme-eu-2")).toBe("TENANT_ACME_EU_2");
	});
});

describe("parseTenantSecret", () => {
	const URL = "https://erp.acme.example/mail_cloudflare/inbound/k3y-that-is-secret";
	const SECRET = "a-webhook-secret-of-sufficient-length";

	it("parses the JSON blob", () => {
		expect(parseTenantSecret(JSON.stringify({ inboundUrl: URL, secret: SECRET }))).toEqual({
			inboundUrl: URL,
			secret: SECRET,
		});
		expect(
			parseTenantSecret(
				JSON.stringify({
					inboundUrl: "http://localhost:8169/x",
					secret: SECRET,
					accessClientId: "id",
					accessClientSecret: "s",
				}),
			),
		).toMatchObject({ accessClientId: "id", accessClientSecret: "s" });
	});

	it("rejects non-JSON, bad URLs, short secrets and half an Access token", () => {
		expect(() => parseTenantSecret("{not json")).toThrow("not valid JSON");
		expect(() => parseTenantSecret(JSON.stringify({ secret: SECRET }))).toThrow("inboundUrl");
		for (const inboundUrl of ["ftp://x.example/a", "mailto:x@example", "erp.example", "https://"]) {
			expect(() => parseTenantSecret(JSON.stringify({ inboundUrl, secret: SECRET }))).toThrow(
				"inboundUrl",
			);
		}
		expect(() => parseTenantSecret(JSON.stringify({ inboundUrl: URL, secret: "short" }))).toThrow(
			"secret",
		);
		expect(() =>
			parseTenantSecret(JSON.stringify({ inboundUrl: URL, secret: SECRET, accessClientId: "id" })),
		).toThrow("accessClientSecret");
	});

	it("names fields, never values", () => {
		const bad = JSON.stringify({ inboundUrl: "gopher://erp.example/secret-key", secret: "short" });
		let message = "";
		try {
			parseTenantSecret(bad);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).not.toBe("");
		expect(message).not.toContain("secret-key");
		expect(message).not.toContain("gopher");
		expect(message).not.toContain("short");
	});
});
