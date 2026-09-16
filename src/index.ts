/// <reference types="@cloudflare/workers-types" />
import type { RelayEnv } from "./env";
import { handleEmail } from "./handlers/email";
import { handleOps } from "./handlers/ops";
import { InboxQueue } from "./inbox-do";
import type { InboxQueue as InboxQueueType } from "./inbox-do";
import { json } from "./lib/http";
import { logEvent } from "./lib/util";
import { parseTenantTable } from "./tenant-schema";
import { TenantRegistry } from "./tenants";

// Public package surface: the relay factory, the tenant model (schemas, registry, errors), the
// queue's record contracts and the env. The Durable Object class is deliberately not exported on
// its own — an unbound InboxQueue has no tenant table and cannot run — but comes out of
// createRelay() bound to the table it was built with, for the wrapper to re-export.
export type {
	InboxQueue,
	EnqueueInput,
	EnqueueResult,
	InboxCounts,
	InboxRecord,
	InboxStatus,
	RetryResult,
	RetryableStatus,
} from "./inbox-do";
export type { RelayEnv } from "./env";
export {
	DOMAIN_PATTERN,
	PLATFORMS,
	SLUG_PATTERN,
	TenantSchema,
	TenantSecretSchema,
	TenantTableError,
	TenantTableSchema,
	TenantTunablesSchema,
	parseTenantSecret,
	parseTenantTable,
	secretNameFor,
} from "./tenant-schema";
export type { Platform, Tenant, TenantInput, TenantSecret, TenantTable } from "./tenant-schema";
export { TenantConfigError, TenantRegistry, domainOf } from "./tenants";
export type { AccessCredentials, TenantConfig } from "./tenants";
export { VERSION } from "./version";

export interface RelayOptions {
	/**
	 * The committed tenant table (the parsed JSON of tenants.json). Validated here; a bad table
	 * throws.
	 */
	tenants: unknown;
	/**
	 * R2 key prefix for stored messages (default "inbox/"); the tenant slug and the message id follow
	 * it. Lets several Workers share one bucket without their objects colliding.
	 */
	keyPrefix?: string;
}

export interface Relay {
	/** The Worker's `email()` and `fetch()` handlers. */
	handler: ExportedHandler<RelayEnv>;
	/** The Durable Object class, bound to the tenant table; re-export it as `InboxQueue`. */
	InboxQueue: new (ctx: DurableObjectState, env: RelayEnv) => InboxQueueType;
}

/**
 * Build the relay for one tenant table.
 *
 * ```ts
 * import { createRelay } from "@avunu/cloudflare-email-relay";
 * import tenants from "./tenants.json";
 * const relay = createRelay({ tenants });
 * export default relay.handler;
 * export const InboxQueue = relay.InboxQueue;
 * ```
 *
 * The table is validated when the module is evaluated, so an invalid table fails the deploy (or the
 * very first invocation, which Cloudflare answers to the sending MTA as a temporary failure) rather
 * than routing anything. The runtime constructs Durable Objects with (ctx, env) only, so the
 * registry reaches the queue through a subclass bound here.
 */
export function createRelay(options: RelayOptions): Relay {
	const keyPrefix = options.keyPrefix ?? "inbox/";
	const registry = new TenantRegistry(parseTenantTable(options.tenants));

	class BoundInboxQueue extends InboxQueue {
		constructor(ctx: DurableObjectState, env: RelayEnv) {
			super(ctx, env, registry);
		}
	}

	return {
		handler: {
			// Errors propagate on purpose: an unhandled error here makes Cloudflare answer the
			// sending MTA with a temporary failure, so a message the relay could not store is
			// retried by the sender rather than lost (handleEmail logs the cause before rethrowing).
			async email(message: ForwardableEmailMessage, env: RelayEnv, _ctx: ExecutionContext) {
				await handleEmail(message, env, { registry, keyPrefix });
			},
			async fetch(request: Request, env: RelayEnv, _ctx: ExecutionContext): Promise<Response> {
				try {
					return await handleOps(request, env, registry);
				} catch (error) {
					logEvent("error", "unhandled_error", {
						path: new URL(request.url).pathname,
						message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
					});
					return json({ ok: false, error: "internal error" }, 500);
				}
			},
		},
		InboxQueue: BoundInboxQueue,
	};
}
