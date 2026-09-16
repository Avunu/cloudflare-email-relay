import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { alarmAt, captured, ingest, makeDue, queue, rowOf, runPass, resetQueue } from "./helpers";
import { ODOO_INBOUND_URL, ALPHA_SECRET } from "./outbound";

beforeEach(resetQueue);

describe("tenant isolation", () => {
	it("a tenant with a broken secret parks its own rows and nobody else's", async () => {
		const delta = queue("delta");
		const alpha = queue("alpha");
		const stuck = await ingest("hello@delta.test");
		const fine = await ingest("hello@alpha.test");
		await makeDue(delta, stuck.id);
		await makeDue(alpha, fine.id);

		expect(await runPass(delta)).toBe(true);
		const after = await rowOf(delta, stuck.id);
		// Nothing was attempted and no attempt was charged; the pass re-armed a minute out.
		expect(after.status).toBe("pending");
		expect(after.attempts).toBe(0);
		expect(after.lastStatus).toBeNull();
		expect(await captured(stuck.id)).toBeNull();
		const alarm = await alarmAt(delta);
		expect(alarm).toBeGreaterThan(Date.now() + 50_000);
		expect(alarm).toBeLessThan(Date.now() + 70_000);

		await runPass(alpha);
		expect((await rowOf(alpha, fine.id)).status).toBe("delivered");
	});

	it("delivers once the secret is fixed, without a redeploy", async () => {
		const delta = queue("delta");
		const row = await ingest("later@delta.test");
		await makeDue(delta, row.id);
		await runPass(delta);
		expect((await rowOf(delta, row.id)).attempts).toBe(0);

		// The env is read on every pass, so a corrected secret takes effect at the next one.
		await runInDurableObject(delta, (instance) => {
			const mutable = instance as unknown as { env: Record<string, string> };
			mutable.env = {
				...mutable.env,
				TENANT_DELTA: JSON.stringify({ inboundUrl: ODOO_INBOUND_URL, secret: ALPHA_SECRET }),
			};
		});
		await makeDue(delta, row.id);
		await runPass(delta);
		const after = await rowOf(delta, row.id);
		expect(after.status).toBe("delivered");
		expect((await captured(row.id))?.headers["x-email-relay-tenant"]).toBe("delta");
	});

	it("an instance that was never bound has nothing to deliver", async () => {
		const stub = env.INBOX_QUEUE.get(env.INBOX_QUEUE.idFromName("never-used"));
		await runInDurableObject(stub, (_instance, state) =>
			state.storage.setAlarm(Date.now() + 60_000),
		);
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		expect(await alarmAt(stub)).toBeNull();
		expect(await stub.tenantSlug()).toBeNull();
	});

	it("binds an instance to its tenant on first use", async () => {
		await ingest("first@beta.test");
		expect(await queue("beta").tenantSlug()).toBe("beta");
		expect(await queue("alpha").tenantSlug()).toBe("alpha");
	});
});
