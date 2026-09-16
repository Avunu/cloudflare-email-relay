import type { RelayEnv } from "../env";
import { asciiValue, inboxQueueFor } from "../inbox-do";
import {
	EnvelopeError,
	assertHeaderSafe,
	envelopeHeaders,
	headerBlock,
	messageIdOf,
} from "../lib/rfc822";
import { logEvent, ulid } from "../lib/util";
import type { TenantRegistry } from "../tenants";

export interface EmailHandlerOptions {
	registry: TenantRegistry;
	/** R2 key prefix for stored messages, e.g. "inbox/"; the tenant slug follows it. */
	keyPrefix: string;
}

/** Longest envelope address kept as R2 metadata; the row and the message itself keep the full value. */
const MAX_METADATA_ADDRESS = 256;

/** The SMTP replies. Fixed strings: nothing a sender controls is echoed back to it. */
export const REJECT_ENVELOPE = "Invalid envelope address";
export const REJECT_UNROUTED = "Recipient domain is not served by this relay";
export const REJECT_DISABLED = "Recipient domain is disabled on this relay";

/**
 * The Email Routing entry point: route the message to its tenant, store it, then queue it.
 *
 * Nothing is pushed to the ERP from here. The raw message goes to R2 first, with the SMTP envelope
 * written into it as Delivered-To / Return-Path the way a delivering MTA would, and only then is a
 * queue row created; the tenant's Durable Object alarm does the push. That ordering is the whole
 * guarantee of this worker — once this function returns normally the message exists on disk and
 * will be retried until the ERP takes it or an operator decides otherwise.
 *
 * The ways out are deliberate. An envelope address that cannot be written into a header (control
 * characters, or longer than a header line) is rejected with a permanent SMTP error: it cannot be
 * stored faithfully, and a sender producing one is not one we want to accept mail from. A recipient
 * whose domain belongs to no tenant, or to a disabled one, is rejected too — the relay never
 * guesses a tenant, because delivering one client's mail to another is the one mistake a shared
 * relay must never make, and a bounce tells the sender what a silent drop would hide. A failure to
 * store or queue is rethrown so Cloudflare answers the sending MTA with a temporary failure and it
 * retries later.
 */
export async function handleEmail(
	message: ForwardableEmailMessage,
	env: RelayEnv,
	options: EmailHandlerOptions,
): Promise<void> {
	const { from, to } = message;
	try {
		assertHeaderSafe("Delivered-To", to);
		assertHeaderSafe("Return-Path", from);
	} catch (error) {
		if (error instanceof EnvelopeError) {
			logEvent("warn", "email_rejected", { reason: error.message, size: message.rawSize });
			message.setReject(REJECT_ENVELOPE);
			return;
		}
		throw error;
	}

	const tenant = options.registry.route(to);
	if (tenant === null) {
		logEvent("warn", "email_unrouted", { from, to, size: message.rawSize });
		message.setReject(REJECT_UNROUTED);
		return;
	}
	if (!tenant.enabled) {
		logEvent("warn", "email_tenant_disabled", {
			tenant: tenant.slug,
			from,
			to,
			size: message.rawSize,
		});
		message.setReject(REJECT_DISABLED);
		return;
	}

	const id = ulid();
	const receivedAt = Date.now();
	const envelope = headerBlock(envelopeHeaders(from, to));
	const size = envelope.byteLength + message.rawSize;
	const messageId = messageIdOf(message.headers);
	const r2Key = `${options.keyPrefix}${tenant.slug}/${id}.eml`;

	try {
		// The message is streamed into R2 behind the envelope block rather than buffered and
		// concatenated: R2 needs the total length up front, which FixedLengthStream supplies, and
		// the bytes are never decoded (attachments must survive intact). The put is started before
		// anything is written — the stream has no buffer of its own, so a write only completes once
		// R2 is reading. A short or long stream fails the put, which fails this handler, which makes
		// the sender retry.
		const { readable, writable } = new FixedLengthStream(size);
		const putting = env.INBOX.put(r2Key, readable, {
			httpMetadata: { contentType: "message/rfc822" },
			// Enough to identify an object from a bucket listing alone, should the queue ever be
			// lost. Custom metadata must be ASCII and is capped in size, hence the encoding and the
			// truncation; the queue row carries the exact values.
			customMetadata: {
				tenant: tenant.slug,
				from: asciiValue(from.slice(0, MAX_METADATA_ADDRESS)),
				to: asciiValue(to.slice(0, MAX_METADATA_ADDRESS)),
				...(messageId === null ? {} : { messageId }),
				receivedAt: new Date(receivedAt).toISOString(),
				size: String(size),
			},
		});
		const writing = (async () => {
			const writer = writable.getWriter();
			await writer.write(envelope);
			writer.releaseLock();
			await message.raw.pipeTo(writable);
		})();
		await Promise.all([putting, writing]);
		const queued = await inboxQueueFor(env, tenant.slug).enqueue({
			tenant: tenant.slug,
			id,
			r2Key,
			from,
			to,
			messageId,
			size,
			receivedAt,
		});
		if (queued === "foreign_tenant") {
			// Cannot happen when the instance is addressed by the slug it was bound with; if it
			// does, the sender retrying is far better than the message going anywhere.
			throw new RangeError(`queue instance for "${tenant.slug}" belongs to another tenant`);
		}
	} catch (error) {
		logEvent("error", "email_store_failed", {
			tenant: tenant.slug,
			id,
			from,
			to,
			size,
			message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
		});
		throw error;
	}

	logEvent("info", "email_stored", { tenant: tenant.slug, id, from, to, messageId, size });
}
