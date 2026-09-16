import { createExecutionContext, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import type { RelayEnv } from "../../src/env";
import { inboxQueueFor } from "../../src/inbox-do";
import type { InboxQueue, InboxRecord } from "../../src/inbox-do";
import { domainOf } from "../../src/tenants";
import worker from "./worker";
import { CONTROL_ORIGIN, FIXTURE_EML, OPS_TOKEN, TEST_TENANTS } from "./outbound";
import type { CapturedDelivery } from "./outbound";

/** The fixture message's own Message-ID, as the row and the R2 metadata should carry it. */
export const FIXTURE_MESSAGE_ID = "<simple-0001@example.com>";

/** The fixture message as bytes (CRLF, the same content as test/fixtures/simple.eml). */
export const FIXTURE_BYTES: Uint8Array = new TextEncoder().encode(FIXTURE_EML);

/** A ForwardableEmailMessage plus a way to read back what `setReject()` was given. */
export interface MockMessage extends ForwardableEmailMessage {
	rejectedWith: () => string | null;
}

/**
 * The message Email Routing would hand `email()`: the envelope as two strings, the message as a
 * byte stream, and the headers parsed for convenience. `forward`/`reply` are never called by the
 * worker and fail loudly if that changes.
 */
export function mockMessage(
	from: string,
	to: string,
	raw: Uint8Array = FIXTURE_BYTES,
): MockMessage {
	let rejected: string | null = null;
	const headers = new Headers();
	const headerBlock = new TextDecoder().decode(raw).split("\r\n\r\n", 1)[0] ?? "";
	for (const line of headerBlock.split("\r\n")) {
		const colon = line.indexOf(":");
		if (colon > 0) {
			headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
		}
	}
	return {
		from,
		to,
		headers,
		raw: new Blob([raw]).stream(),
		rawSize: raw.byteLength,
		setReject(reason: string) {
			rejected = reason;
		},
		forward: () => Promise.reject(new Error("forward() is not part of the worker's contract")),
		reply: () => Promise.reject(new Error("reply() is not part of the worker's contract")),
		rejectedWith: () => rejected,
	};
}

/** Run the worker's email handler on `message` with the test env (or an override of it). */
export async function deliverToWorker(message: MockMessage, override?: RelayEnv): Promise<void> {
	const handler = worker.email;
	if (handler === undefined) {
		throw new Error("the worker exports no email handler");
	}
	await handler(message, override ?? env, createExecutionContext());
}

/** The fixture tenant that owns `to`, by the same rule the worker routes with. */
export function tenantOf(to: string): string {
	const domain = domainOf(to) ?? "";
	const hit = TEST_TENANTS.find((tenant) =>
		tenant.domains.some((d) => (d.startsWith("*.") ? domain.endsWith(d.slice(1)) : d === domain)),
	);
	if (hit === undefined) {
		throw new Error(`no fixture tenant serves ${to}`);
	}
	return hit.slug;
}

/** Ingest one fixture message for `to` and return its queue row (in its tenant's queue). */
export async function ingest(to: string, from = "alice@example.com"): Promise<InboxRecord> {
	await deliverToWorker(mockMessage(from, to));
	const row = (await queue(tenantOf(to)).list("pending", 1000)).find((r) => r.to === to);
	if (row === undefined) {
		throw new Error(`no pending row for ${to}`);
	}
	return row;
}

/** One tenant's queue stub; `alpha` (the Odoo fixture) unless told otherwise. */
export function queue(slug = "alpha"): DurableObjectStub<InboxQueue> {
	return inboxQueueFor(env, slug);
}

/**
 * Wipe every fixture tenant's queue and alarm, and the bucket. The pool shares Durable Object and
 * R2 storage across the tests of a file, so every suite starts each test from an empty inbox. The
 * `meta` row is kept: the instance keeps serving the same tenant.
 */
export async function resetQueue(): Promise<void> {
	for (const tenant of TEST_TENANTS) {
		await runInDurableObject(queue(tenant.slug), async (_instance, state) => {
			state.storage.sql.exec("DELETE FROM inbox");
			await state.storage.deleteAlarm();
		});
	}
	const listed = await env.INBOX.list();
	if (listed.objects.length > 0) {
		await env.INBOX.delete(listed.objects.map((object) => object.key));
	}
}

/** What the fake ERP captured for one delivery, or null if it never arrived. */
export async function captured(id: string): Promise<CapturedDelivery | null> {
	const response = await fetch(`${CONTROL_ORIGIN}/captured/${id}`);
	if (response.status !== 200) {
		return null;
	}
	return (await response.json()) as CapturedDelivery;
}

/** The Durable Object's currently scheduled alarm, if any. */
export function alarmAt(stub: DurableObjectStub<InboxQueue>): Promise<number | null> {
	return runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
}

/** Rewind a row so its next attempt is due now. */
export function makeDue(stub: DurableObjectStub<InboxQueue>, id: string): Promise<void> {
	return runInDurableObject(stub, (_instance, state) => {
		state.storage.sql.exec("UPDATE inbox SET next_attempt_at = ? WHERE id = ?", Date.now() - 1, id);
	});
}

/**
 * Run one alarm pass synchronously. The alarm is armed a minute out first: an alarm set at or
 * before "now" is fired by the runtime itself, asynchronously, and runDurableObjectAlarm() then
 * finds nothing to run — the pass would happen behind the test's back instead of under it.
 */
export async function runPass(stub: DurableObjectStub<InboxQueue>): Promise<boolean> {
	await runInDurableObject(stub, (_instance, state) => state.storage.setAlarm(Date.now() + 60_000));
	return runDurableObjectAlarm(stub);
}

/** Make every pending row due, then run one pass. */
export async function runDuePass(stub: DurableObjectStub<InboxQueue>): Promise<boolean> {
	await runInDurableObject(stub, (_instance, state) => {
		state.storage.sql.exec(
			"UPDATE inbox SET next_attempt_at = ? WHERE status = 'pending'",
			Date.now() - 1,
		);
	});
	return runPass(stub);
}

export async function rowOf(stub: DurableObjectStub<InboxQueue>, id: string): Promise<InboxRecord> {
	const row = await stub.get(id);
	if (row === null) {
		throw new Error(`row ${id} vanished`);
	}
	return row;
}

/** A request to the ops API through the worker's fetch handler. */
export function ops(
	path: string,
	init: RequestInit = {},
	token: string | null = OPS_TOKEN,
): Promise<Response> {
	const headers = new Headers(init.headers);
	if (token !== null) {
		headers.set("Authorization", `Bearer ${token}`);
	}
	return exports.default.fetch(`https://relay.test${path}`, { ...init, headers });
}
