import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { alarmAt, ingest, makeDue, queue, rowOf, runDuePass, runPass, resetQueue } from "./helpers";

beforeEach(resetQueue);

describe("InboxQueue", () => {
	it("enqueue is idempotent on the id", async () => {
		const stub = queue();
		const row = await ingest("once@alpha.test");
		const again = await stub.enqueue({
			tenant: "alpha",
			id: row.id,
			r2Key: row.r2Key,
			from: row.from,
			to: row.to,
			messageId: row.messageId,
			size: row.size,
			receivedAt: row.receivedAt,
		});
		expect(again).toBe("duplicate");
		expect((await stub.list(null, 1000)).filter((r) => r.id === row.id)).toHaveLength(1);
	});

	it("lists newest first, filtered by status, capped by limit", async () => {
		const stub = queue();
		const first = await ingest("first@alpha.test");
		const second = await ingest("second@alpha.test");
		const third = await ingest("reject422@alpha.test");
		await makeDue(stub, third.id);
		await runPass(stub);

		const all = await stub.list(null, 1000);
		expect(all.map((r) => r.id)).toEqual([third.id, second.id, first.id]);
		expect((await stub.list("pending", 1000)).map((r) => r.id)).toEqual([second.id, first.id]);
		expect((await stub.list("rejected", 1000)).map((r) => r.id)).toEqual([third.id]);
		expect(await stub.list(null, 1)).toHaveLength(1);
		expect(await stub.get(first.id)).toEqual(first);
		expect(await stub.get("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBeNull();
	});

	it("delivers due rows in batches and comes straight back for the rest", async () => {
		const stub = queue();
		const rows = [];
		for (let i = 0; i < 12; i += 1) {
			rows.push(await ingest(`batch${i}@alpha.test`));
		}
		expect(await runDuePass(stub)).toBe(true);
		const delivered = (await stub.list("delivered", 1000)).length;
		// One pass takes ALARM_BATCH rows; the rest are still due, so the pass re-armed for now
		// and the runtime finishes them on its own.
		expect(delivered).toBeGreaterThanOrEqual(10);
		await vi.waitFor(
			async () => {
				expect((await stub.list("delivered", 1000)).length).toBe(rows.length);
			},
			{ timeout: 5000, interval: 50 },
		);
	});

	it("purges the object and the row once retention has run out", async () => {
		const stub = queue();
		const row = await ingest("purge@alpha.test");
		await makeDue(stub, row.id);
		await runPass(stub);
		expect((await rowOf(stub, row.id)).status).toBe("delivered");
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec("UPDATE inbox SET purge_at = ? WHERE id = ?", Date.now() - 1, row.id);
		});
		expect(await runPass(stub)).toBe(true);
		expect(await stub.get(row.id)).toBeNull();
		expect(await env.INBOX.get(row.r2Key)).toBeNull();
		expect(await alarmAt(stub)).toBeNull();
	});

	it("retry requeues a parked row with a fresh budget and leaves a pending one alone", async () => {
		const stub = queue();
		const row = await ingest("reject422@alpha.test");
		await makeDue(stub, row.id);
		await runPass(stub);
		expect((await rowOf(stub, row.id)).status).toBe("rejected");

		expect(await stub.retry(row.id)).toBe("requeued");
		// The requeue arms the alarm for "now", which the runtime fires on its own; the attempt
		// budget was reset, so the fresh attempt is number 1 and Odoo parks the row again.
		await vi.waitFor(
			async () => {
				const again = await rowOf(stub, row.id);
				expect(again.status).toBe("rejected");
				expect(again.attempts).toBe(1);
			},
			{ timeout: 5000, interval: 50 },
		);

		const fresh = await ingest("waiting@alpha.test");
		expect(await stub.retry(fresh.id)).toBe("already_pending");
		expect(await stub.retry("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe("not_found");
	});

	it("retryAll requeues every row in one parked state", async () => {
		const stub = queue();
		const a = await ingest("reject422@alpha.test");
		const b = await ingest("redirect@alpha.test");
		const c = await ingest("fine@alpha.test");
		for (const row of [a, b, c]) {
			await makeDue(stub, row.id);
		}
		await runPass(stub);
		expect(await stub.retryAll("dead")).toBe(0);
		expect(await stub.retryAll("rejected")).toBe(2);
		await vi.waitFor(
			async () => {
				// Both were attempted again (budget reset → attempt 1) and parked again.
				expect((await rowOf(stub, a.id)).attempts).toBe(1);
				expect((await rowOf(stub, b.id)).attempts).toBe(1);
			},
			{ timeout: 5000, interval: 50 },
		);
		expect((await rowOf(stub, a.id)).status).toBe("rejected");
		expect((await rowOf(stub, c.id)).status).toBe("delivered");
	});

	it("remove drops the row and its object", async () => {
		const stub = queue();
		const row = await ingest("gone@alpha.test");
		expect(await stub.remove(row.id)).toBe(true);
		expect(await stub.get(row.id)).toBeNull();
		expect(await env.INBOX.get(row.r2Key)).toBeNull();
		expect(await stub.remove(row.id)).toBe(false);
	});

	it("refuses to serve a second tenant once bound", async () => {
		const stub = queue();
		const row = await ingest("bound@alpha.test");
		expect(await stub.enqueue({ ...row, tenant: "beta", id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" })).toBe(
			"foreign_tenant",
		);
		expect(await stub.get("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBeNull();
		expect(await stub.tenantSlug()).toBe("alpha");
	});

	it("counts rows per status", async () => {
		const stub = queue();
		expect(await stub.counts()).toEqual({ pending: 0, delivered: 0, rejected: 0, dead: 0 });
		const a = await ingest("count1@alpha.test");
		await ingest("count2@alpha.test");
		const c = await ingest("reject422@alpha.test");
		await makeDue(stub, a.id);
		await makeDue(stub, c.id);
		await runPass(stub);
		expect(await stub.counts()).toEqual({ pending: 1, delivered: 1, rejected: 1, dead: 0 });
	});

	it("an alarm with nothing due is a no-op that clears itself", async () => {
		const stub = queue();
		await runInDurableObject(stub, (_instance, state) =>
			state.storage.setAlarm(Date.now() + 60_000),
		);
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		expect(await alarmAt(stub)).toBeNull();
	});
});
