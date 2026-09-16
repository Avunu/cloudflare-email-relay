import { env, exports } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RelayEnv } from "../../src/env";
import type { InboxCounts, InboxRecord } from "../../src/inbox-do";
import type { Tenant } from "../../src/tenant-schema";
import { ingest, makeDue, ops, queue, runPass, resetQueue } from "./helpers";
import worker from "./worker";

interface ListBody {
	ok: boolean;
	items: InboxRecord[];
}

interface TenantsBody {
	ok: boolean;
	items: (Tenant & { counts: InboxCounts })[];
}

const ALPHA = "/tenants/alpha/inbox";

beforeEach(resetQueue);

describe("ops API", () => {
	it("GET /health is public and says nothing else", async () => {
		const response = await ops("/health", {}, null);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
	});

	it("requires the bearer token for everything else", async () => {
		const anonymous = await ops("/tenants", {}, null);
		expect(anonymous.status).toBe(401);
		expect(anonymous.headers.get("WWW-Authenticate")).toBe("Bearer");
		expect((await ops("/tenants", {}, "wrong-token")).status).toBe(401);
		expect((await ops("/health", { method: "POST" }, null)).status).toBe(401);
	});

	it("does not exist at all when OPS_TOKEN is unset or too short", async () => {
		const handler = worker.fetch;
		if (handler === undefined) {
			throw new Error("the worker exports no fetch handler");
		}
		type IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
		// A blank value is "unset" (that is all a dashboard form can express); a short one is a
		// mistake, not a credential.
		for (const token of ["", "short-token"]) {
			const override = { ...env, OPS_TOKEN: token } as RelayEnv;
			const request = new Request("https://relay.test/tenants", {
				headers: { Authorization: `Bearer ${token}` },
			}) as IncomingRequest;
			const response = await handler(request, override, createExecutionContext());
			expect(response.status, token).toBe(404);
			const health = await handler(
				new Request("https://relay.test/health") as IncomingRequest,
				override,
				createExecutionContext(),
			);
			expect(health.status).toBe(200);
		}
	});

	it("lists every tenant with its public config and counts", async () => {
		const a = await ingest("a@alpha.test");
		await ingest("b@beta.test");
		await makeDue(queue(), a.id);
		await runPass(queue());
		const body = (await (await ops("/tenants")).json()) as TenantsBody;
		expect(body.ok).toBe(true);
		expect(body.items.map((t) => t.slug)).toEqual(["alpha", "beta", "gamma", "delta"]);
		const [alpha, beta, gamma] = body.items;
		expect(alpha?.counts).toEqual({ pending: 0, delivered: 1, rejected: 0, dead: 0 });
		expect(alpha?.domains).toEqual(["alpha.test", "*.alpha.test"]);
		expect(alpha?.platform).toBe("odoo");
		expect(beta?.counts.pending).toBe(1);
		expect(gamma?.enabled).toBe(false);
		// The secret half never appears.
		expect(JSON.stringify(body)).not.toContain("test-server-key");
		expect(JSON.stringify(body)).not.toContain("integration-secret");

		const one = await ops("/tenants/beta");
		expect(one.status).toBe(200);
		expect(((await one.json()) as { item: Tenant }).item.slug).toBe("beta");
		expect((await ops("/tenants/nope")).status).toBe(404);
		expect((await ops("/tenants/Alpha")).status).toBe(404);
		expect((await ops("/tenants/beta", { method: "DELETE" })).status).toBe(404);
	});

	it("lists rows newest first, by status, within the limit, per tenant", async () => {
		const stub = queue();
		const first = await ingest("first@alpha.test");
		const second = await ingest("reject422@alpha.test");
		const other = await ingest("other@beta.test");
		await makeDue(stub, second.id);
		await runPass(stub);

		const all = (await (await ops(ALPHA)).json()) as ListBody;
		expect(all.ok).toBe(true);
		expect(all.items.map((r) => r.id)).toEqual([second.id, first.id]);

		const rejected = (await (await ops(`${ALPHA}?status=rejected`)).json()) as ListBody;
		expect(rejected.items.map((r) => r.id)).toEqual([second.id]);

		const limited = (await (await ops(`${ALPHA}?limit=1`)).json()) as ListBody;
		expect(limited.items).toHaveLength(1);

		expect((await ops(`${ALPHA}?status=bogus`)).status).toBe(400);

		const beta = (await (await ops("/tenants/beta/inbox")).json()) as ListBody;
		expect(beta.items.map((r) => r.id)).toEqual([other.id]);
		// A row is only reachable under its own tenant.
		expect((await ops(`${ALPHA}/${other.id}`)).status).toBe(404);
		expect((await ops(`/tenants/beta/inbox/${first.id}`)).status).toBe(404);
	});

	it("serves one row and its raw message", async () => {
		const row = await ingest("raw@alpha.test");
		const item = await ops(`${ALPHA}/${row.id}`);
		expect(item.status).toBe(200);
		expect(((await item.json()) as { item: InboxRecord }).item).toEqual(row);

		const raw = await ops(`${ALPHA}/${row.id}/raw`);
		expect(raw.status).toBe(200);
		expect(raw.headers.get("Content-Type")).toBe("message/rfc822");
		expect(raw.headers.get("Content-Disposition")).toBe(`attachment; filename="${row.id}.eml"`);
		const text = await raw.text();
		expect(text.startsWith("Delivered-To: raw@alpha.test\r\n")).toBe(true);
		expect(text.length).toBe(row.size);

		await env.INBOX.delete(row.r2Key);
		expect((await ops(`${ALPHA}/${row.id}/raw`)).status).toBe(404);
	});

	it("retries one row or every parked row", async () => {
		const stub = queue();
		const row = await ingest("reject422@alpha.test");
		// Still pending: nothing to retry.
		expect((await ops(`${ALPHA}/${row.id}/retry`, { method: "POST" })).status).toBe(409);
		await makeDue(stub, row.id);
		await runPass(stub);
		expect((await ops(`${ALPHA}/${row.id}/retry`, { method: "POST" })).status).toBe(202);
		// The runtime re-attempts at once and Odoo parks it again; wait for that before the bulk call.
		await vi.waitFor(
			async () => {
				expect((await stub.get(row.id))?.attempts).toBe(1);
			},
			{ timeout: 5000, interval: 50 },
		);
		const bulk = await ops(`${ALPHA}/retry?status=rejected`, { method: "POST" });
		expect(bulk.status).toBe(202);
		expect(await bulk.json()).toEqual({ ok: true, status: "rejected", requeued: 1 });
		expect((await ops(`${ALPHA}/retry?status=pending`, { method: "POST" })).status).toBe(400);
		expect((await ops(`${ALPHA}/retry`, { method: "POST" })).status).toBe(400);
		// Another tenant's bulk retry touches nothing here.
		const other = await ops("/tenants/beta/inbox/retry?status=rejected", { method: "POST" });
		expect(await other.json()).toEqual({ ok: true, status: "rejected", requeued: 0 });
	});

	it("deletes a row together with its message", async () => {
		const row = await ingest("delete@alpha.test");
		expect((await ops(`${ALPHA}/${row.id}`, { method: "DELETE" })).status).toBe(200);
		expect((await ops(`${ALPHA}/${row.id}`)).status).toBe(404);
		expect(await env.INBOX.get(row.r2Key)).toBeNull();
		expect((await ops(`${ALPHA}/${row.id}`, { method: "DELETE" })).status).toBe(404);
	});

	it("answers 404 for unknown routes and malformed ids", async () => {
		expect((await ops("/nope")).status).toBe(404);
		expect((await ops("/inbox")).status).toBe(404);
		expect((await ops(`${ALPHA}/not-a-ulid`)).status).toBe(404);
		expect((await ops(`${ALPHA}/01ARZ3NDEKTSV4RRFFQ69G5FAV`)).status).toBe(404);
		expect((await ops(`${ALPHA}/01ARZ3NDEKTSV4RRFFQ69G5FAV/raw`)).status).toBe(404);
		expect(
			(await ops(`${ALPHA}/01ARZ3NDEKTSV4RRFFQ69G5FAV/retry`, { method: "POST" })).status,
		).toBe(404);
		expect((await ops(`${ALPHA}/01ARZ3NDEKTSV4RRFFQ69G5FAV/bogus`)).status).toBe(404);
		expect((await ops(ALPHA, { method: "DELETE" })).status).toBe(404);
		expect((await ops("/tenants/nope/inbox")).status).toBe(404);
		expect((await ops("/tenants/../inbox")).status).toBe(404);
		// The service-binding default export is the same handler.
		expect((await exports.default.fetch("https://relay.test/health")).status).toBe(200);
	});
});
