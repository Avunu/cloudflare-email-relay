import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { RelayEnv } from "../../src/env";
import { REJECT_DISABLED, REJECT_ENVELOPE, REJECT_UNROUTED } from "../../src/handlers/email";
import { signBody } from "../../src/lib/sign";
import { VERSION } from "../../src/version";
import {
	FIXTURE_BYTES,
	FIXTURE_MESSAGE_ID,
	alarmAt,
	captured,
	deliverToWorker,
	ingest,
	makeDue,
	mockMessage,
	queue,
	rowOf,
	runPass,
	resetQueue,
} from "./helpers";
import { ALPHA_SECRET, BETA_SECRET, TEST_TENANTS } from "./outbound";

const DAY_MS = 86_400_000;
const decoder = new TextDecoder();

beforeEach(resetQueue);

describe("email(): store first", () => {
	it("stores the raw message in R2 with the envelope prepended and metadata alongside", async () => {
		const row = await ingest("support@alpha.test");
		expect(row.status).toBe("pending");
		expect(row.attempts).toBe(0);
		expect(row.messageId).toBe(FIXTURE_MESSAGE_ID);
		expect(row.from).toBe("alice@example.com");
		expect(row.r2Key).toBe(`inbox/alpha/${row.id}.eml`);

		const object = await env.INBOX.get(row.r2Key);
		expect(object).not.toBeNull();
		if (object === null) {
			return;
		}
		const stored = new Uint8Array(await object.arrayBuffer());
		const envelope = "Delivered-To: support@alpha.test\r\nReturn-Path: <alice@example.com>\r\n";
		expect(decoder.decode(stored.subarray(0, envelope.length))).toBe(envelope);
		// The original bytes follow untouched.
		expect(stored.subarray(envelope.length)).toEqual(FIXTURE_BYTES);
		expect(row.size).toBe(stored.byteLength);
		expect(object.httpMetadata?.contentType).toBe("message/rfc822");
		expect(object.customMetadata).toMatchObject({
			tenant: "alpha",
			from: "alice@example.com",
			to: "support@alpha.test",
			messageId: FIXTURE_MESSAGE_ID,
			size: String(stored.byteLength),
		});
	});

	it("arms the alarm for the configured delivery delay, not for now", async () => {
		const before = Date.now();
		const row = await ingest("delayed@alpha.test");
		const alarm = await alarmAt(queue());
		expect(alarm).not.toBeNull();
		expect(row.nextAttemptAt).toBeGreaterThanOrEqual(before + 3_600_000);
		expect(alarm).toBeLessThanOrEqual(row.nextAttemptAt ?? 0);
	});

	it("writes the null reverse-path for a bounce", async () => {
		const row = await ingest("bounces@alpha.test", "");
		const object = await env.INBOX.get(row.r2Key);
		const text = decoder.decode(await object?.arrayBuffer());
		expect(text.startsWith("Delivered-To: bounces@alpha.test\r\nReturn-Path: <>\r\n")).toBe(true);
	});

	it("rejects an envelope that would inject headers, storing nothing", async () => {
		const before = (await env.INBOX.list()).objects.length;
		const message = mockMessage("alice@example.com", "victim@alpha.test\r\nBcc: evil@x");
		await deliverToWorker(message);
		expect(message.rejectedWith()).toBe(REJECT_ENVELOPE);
		expect((await env.INBOX.list()).objects.length).toBe(before);
		expect((await queue().list(null, 1000)).some((r) => r.to.includes("victim"))).toBe(false);
	});

	it("rethrows when the message cannot be stored, so the sender retries", async () => {
		const failingBucket = { put: () => Promise.reject(new Error("r2 down")) };
		const override = { ...env, INBOX: failingBucket } as unknown as RelayEnv;
		await expect(
			deliverToWorker(mockMessage("alice@example.com", "unlucky@alpha.test"), override),
		).rejects.toThrow("r2 down");
	});

	it("rethrows when the stream is shorter than rawSize claims", async () => {
		const message = mockMessage("alice@example.com", "short@alpha.test");
		const lying = { ...message, rawSize: message.rawSize + 10 };
		await expect(deliverToWorker(lying)).rejects.toThrow();
		expect((await queue().list(null, 1000)).some((r) => r.to === "short@alpha.test")).toBe(false);
	});
});

describe("email(): routing", () => {
	async function refuse(to: string): Promise<string | null> {
		const before = (await env.INBOX.list()).objects.length;
		const message = mockMessage("alice@example.com", to);
		await deliverToWorker(message);
		expect((await env.INBOX.list()).objects.length).toBe(before);
		for (const tenant of TEST_TENANTS) {
			expect((await queue(tenant.slug).list(null, 1000)).some((r) => r.to === to)).toBe(false);
		}
		return message.rejectedWith();
	}

	it("rejects a recipient whose domain no tenant serves, storing nothing", async () => {
		expect(await refuse("someone@unknown.test")).toBe(REJECT_UNROUTED);
		expect(await refuse("someone@notalpha.test")).toBe(REJECT_UNROUTED);
		expect(await refuse("someone@alpha.test.evil")).toBe(REJECT_UNROUTED);
	});

	it("rejects a disabled tenant's mail with its own reason", async () => {
		expect(await refuse("someone@gamma.test")).toBe(REJECT_DISABLED);
	});

	it("routes subdomains through the wildcard and ignores case", async () => {
		const sub = await ingest("x@shop.alpha.test");
		expect(sub.r2Key.startsWith("inbox/alpha/")).toBe(true);
		const upper = await ingest("Sales@ALPHA.Test");
		expect(upper.r2Key.startsWith("inbox/alpha/")).toBe(true);
		expect(upper.to).toBe("Sales@ALPHA.Test");
	});

	it("keeps each tenant's rows in its own queue", async () => {
		const a = await ingest("one@alpha.test");
		const b = await ingest("two@beta.test");
		expect(b.r2Key.startsWith("inbox/beta/")).toBe(true);
		const alphaIds = (await queue("alpha").list(null, 1000)).map((r) => r.id);
		const betaIds = (await queue("beta").list(null, 1000)).map((r) => r.id);
		expect(alphaIds).toEqual([a.id]);
		expect(betaIds).toEqual([b.id]);
	});
});

describe("delivery", () => {
	it("posts the stored bytes with a valid signature and records the ERP's answer", async () => {
		const stub = queue();
		const row = await ingest("support@alpha.test");
		await makeDue(stub, row.id);
		expect(await runPass(stub)).toBe(true);

		const after = await rowOf(stub, row.id);
		expect(after.status).toBe("delivered");
		expect(after.attempts).toBe(1);
		expect(after.lastStatus).toBe(200);
		expect(after.remoteRef).toBe("42");
		expect(after.lastError).toBeNull();
		expect(after.nextAttemptAt).toBeNull();
		expect(after.deliveredAt).not.toBeNull();
		expect(after.purgeAt).toBeGreaterThan(Date.now() + 29 * DAY_MS);
		// Nothing else is pending, so the alarm now waits for the purge.
		expect(await alarmAt(stub)).toBe(after.purgeAt);

		const hit = await captured(row.id);
		expect(hit).not.toBeNull();
		if (hit === null) {
			return;
		}
		expect(hit.method).toBe("POST");
		expect(hit.path).toBe("/mail_cloudflare/inbound/test-server-key");
		const { headers } = hit;
		expect(headers["content-type"]).toBe("message/rfc822");
		expect(headers["user-agent"]).toBe(`cloudflare-email-relay/${VERSION}`);
		expect(headers["x-email-relay-id"]).toBe(row.id);
		expect(headers["x-email-relay-tenant"]).toBe("alpha");
		expect(headers["x-email-relay-attempt"]).toBe("1");
		expect(headers["x-email-relay-envelope-from"]).toBe("alice@example.com");
		expect(headers["x-email-relay-envelope-to"]).toBe("support@alpha.test");
		expect(headers["cf-access-client-id"]).toBeUndefined();

		const timestamp = Number(headers["x-email-relay-timestamp"]);
		expect(Math.abs(timestamp - Date.now() / 1000)).toBeLessThan(60);
		const body = new Uint8Array(hit.body);
		expect(headers["x-email-relay-signature"]).toBe(await signBody(ALPHA_SECRET, timestamp, body));
		const object = await env.INBOX.get(row.r2Key);
		expect(object).not.toBeNull();
		if (object !== null) {
			expect(body).toEqual(new Uint8Array(await object.arrayBuffer()));
		}
	});

	it("keeps a row pending with backoff after a 500 and gives up after MAX_ATTEMPTS", async () => {
		const stub = queue();
		const row = await ingest("fail500@alpha.test");

		await makeDue(stub, row.id);
		await runPass(stub);
		let after = await rowOf(stub, row.id);
		expect(after.status).toBe("pending");
		expect(after.attempts).toBe(1);
		expect(after.lastStatus).toBe(500);
		expect(after.lastError).toBe("HTTP 500: internal error");
		expect(after.nextAttemptAt).toBeGreaterThan(Date.now() + 55_000);
		expect(after.nextAttemptAt).toBeLessThan(Date.now() + 65_000);
		expect(await alarmAt(stub)).toBe(after.nextAttemptAt);

		await makeDue(stub, row.id);
		await runPass(stub);
		after = await rowOf(stub, row.id);
		expect(after.attempts).toBe(2);
		expect(after.nextAttemptAt).toBeGreaterThan(Date.now() + 295_000);

		await makeDue(stub, row.id);
		await runPass(stub);
		after = await rowOf(stub, row.id);
		expect(after.status).toBe("dead");
		expect(after.attempts).toBe(3);
		expect(after.nextAttemptAt).toBeNull();
		expect((await captured(row.id))?.headers["x-email-relay-attempt"]).toBe("3");
		// A dead row keeps its message for the operator.
		expect(await env.INBOX.get(row.r2Key)).not.toBeNull();
	});

	it("parks an unroutable message (422) as rejected without retrying", async () => {
		const stub = queue();
		const row = await ingest("reject422@alpha.test");
		await makeDue(stub, row.id);
		await runPass(stub);
		const after = await rowOf(stub, row.id);
		expect(after.status).toBe("rejected");
		expect(after.attempts).toBe(1);
		expect(after.lastStatus).toBe(422);
		expect(after.lastError).toBe("HTTP 422: No possible route found");
		expect(after.nextAttemptAt).toBeNull();
		expect(await alarmAt(stub)).toBeNull();
	});

	it("never follows a redirect: a 3xx is a rejection", async () => {
		const stub = queue();
		const row = await ingest("redirect@alpha.test");
		await makeDue(stub, row.id);
		await runPass(stub);
		const after = await rowOf(stub, row.id);
		expect(after.status).toBe("rejected");
		expect(after.lastStatus).toBe(302);
		expect(after.lastError).toBe("HTTP 302");
	});

	it("treats a timeout as transient", async () => {
		const stub = queue();
		const row = await ingest("slow@alpha.test");
		await makeDue(stub, row.id);
		await runPass(stub);
		const after = await rowOf(stub, row.id);
		expect(after.status).toBe("pending");
		expect(after.attempts).toBe(1);
		expect(after.lastStatus).toBeNull();
		expect(after.lastError).toContain("TimeoutError");
	});

	it("counts a 200 without a remote reference as delivered", async () => {
		const stub = queue();
		const ignored = await ingest("nothread@alpha.test");
		const plain = await ingest("plain200@alpha.test");
		await makeDue(stub, ignored.id);
		await makeDue(stub, plain.id);
		await runPass(stub);
		for (const row of [ignored, plain]) {
			const after = await rowOf(stub, row.id);
			expect(after.status).toBe("delivered");
			expect(after.remoteRef).toBeNull();
			expect(after.lastStatus).toBe(200);
		}
	});

	it("still reads the pre-contract Odoo answer shape", async () => {
		const stub = queue();
		const row = await ingest("legacy@alpha.test");
		await makeDue(stub, row.id);
		await runPass(stub);
		expect((await rowOf(stub, row.id)).remoteRef).toBe("42");
	});

	it("marks a row dead when its stored message is gone", async () => {
		const stub = queue();
		const row = await ingest("vanished@alpha.test");
		await env.INBOX.delete(row.r2Key);
		await makeDue(stub, row.id);
		await runPass(stub);
		const after = await rowOf(stub, row.id);
		expect(after.status).toBe("dead");
		expect(after.lastError).toBe("stored message missing from R2");
		expect(await captured(row.id)).toBeNull();
	});

	it("percent-encodes a non-ASCII envelope on the wire and in R2 metadata", async () => {
		const stub = queue();
		const row = await ingest("josé@alpha.test");
		await makeDue(stub, row.id);
		await runPass(stub);
		expect((await rowOf(stub, row.id)).status).toBe("delivered");
		expect((await captured(row.id))?.headers["x-email-relay-envelope-to"]).toBe(
			"jos%C3%A9@alpha.test",
		);
		const object = await env.INBOX.get(row.r2Key);
		expect(object?.customMetadata?.to).toBe("jos%C3%A9@alpha.test");
		// The row and the stored message keep the real address.
		expect(row.to).toBe("josé@alpha.test");
		const text = decoder.decode(await object?.arrayBuffer());
		expect(text.startsWith("Delivered-To: josé@alpha.test\r\n")).toBe(true);
	});
});

describe("delivery to a Frappe tenant", () => {
	it("signs with that tenant's secret, posts to its URL and unwraps Frappe's answer", async () => {
		const stub = queue("beta");
		const row = await ingest("support@beta.test");
		await makeDue(stub, row.id);
		await runPass(stub);

		const after = await rowOf(stub, row.id);
		expect(after.status).toBe("delivered");
		expect(after.remoteRef).toBe("COMM-0042");

		const hit = await captured(row.id);
		expect(hit).not.toBeNull();
		if (hit === null) {
			return;
		}
		expect(hit.path).toBe("/api/method/cloudflare_email_delivery.api.inbound");
		expect(hit.search).toBe("?key=test-account-key");
		expect(hit.headers["x-email-relay-tenant"]).toBe("beta");
		const timestamp = Number(hit.headers["x-email-relay-timestamp"]);
		expect(hit.headers["x-email-relay-signature"]).toBe(
			await signBody(BETA_SECRET, timestamp, new Uint8Array(hit.body)),
		);
	});

	it("reads the pre-contract Frappe answer shape and null references", async () => {
		const stub = queue("beta");
		const legacy = await ingest("legacy@beta.test");
		const none = await ingest("nothread@beta.test");
		await makeDue(stub, legacy.id);
		await makeDue(stub, none.id);
		await runPass(stub);
		expect((await rowOf(stub, legacy.id)).remoteRef).toBe("COMM-0001");
		expect((await rowOf(stub, none.id)).remoteRef).toBeNull();
	});

	it("parks Frappe's 417 and a wrapped 422 as rejected with the first line of the reason", async () => {
		const stub = queue("beta");
		const invalid = await ingest("reject417@beta.test");
		const unroutable = await ingest("reject422@beta.test");
		await makeDue(stub, invalid.id);
		await makeDue(stub, unroutable.id);
		await runPass(stub);
		const a = await rowOf(stub, invalid.id);
		expect(a.status).toBe("rejected");
		expect(a.lastStatus).toBe(417);
		expect(a.lastError).toBe("HTTP 417: frappe.exceptions.ValidationError: Append To is required");
		const b = await rowOf(stub, unroutable.id);
		expect(b.status).toBe("rejected");
		expect(b.lastError).toBe("HTTP 422: recipient domain does not belong to this account");
	});

	it("retries Frappe's 500, recording only the exception's first line", async () => {
		const stub = queue("beta");
		const row = await ingest("fail500@beta.test");
		await makeDue(stub, row.id);
		await runPass(stub);
		const after = await rowOf(stub, row.id);
		expect(after.status).toBe("pending");
		expect(after.lastError).toBe("HTTP 500: RuntimeError: database went away");
	});
});
