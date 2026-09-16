/// <reference types="@cloudflare/workers-types" />
import type { InboxQueue } from "./inbox-do";

/**
 * Bindings + secrets every deployment provides. The fleet's `wrangler.jsonc` supplies the two
 * bindings; everything else is a Worker secret set with `wrangler secret put`. There are no
 * committed vars: every tunable lives in the tenant table (see tenant-schema.ts), which the fleet
 * bundles into the Worker through createRelay().
 */
export interface RelayEnv {
	/**
	 * Raw inbound messages, one `inbox/<tenant>/<ulid>.eml` object each, written before any delivery
	 * attempt.
	 */
	INBOX: R2Bucket;
	/** The delivery queues: one Durable Object per tenant, addressed as idFromName(slug). */
	INBOX_QUEUE: DurableObjectNamespace<InboxQueue>;
	/** Bearer token for the /tenants routes (≥ 32 characters). Unset = every ops route answers 404. */
	OPS_TOKEN?: string;
	/**
	 * One per tenant, named by secretNameFor(slug): the JSON of TenantSecretSchema (inbound URL, HMAC
	 * secret, optional Access service token). Read lazily, per alarm pass.
	 */
	[tenantSecret: `TENANT_${string}`]: string | undefined;
}
