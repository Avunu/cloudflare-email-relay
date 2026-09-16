import { opsTokenOf } from "../config";
import type { RelayEnv } from "../env";
import { inboxQueueFor, isInboxStatus } from "../inbox-do";
import type { InboxStatus } from "../inbox-do";
import { bearerToken, intParam, json, notFound, unauthorized } from "../lib/http";
import { ULID_PATTERN, logEvent, timingSafeEqual } from "../lib/util";
import { SLUG_PATTERN } from "../tenant-schema";
import type { TenantRegistry } from "../tenants";

/** Default and ceiling for `?limit=` on a tenant's inbox listing. */
const LIST_DEFAULT = 50;
const LIST_MAX = 500;

/**
 * `/tenants/<slug>`, `/tenants/<slug>/inbox`, `/tenants/<slug>/inbox/<id-or-retry>`,
 * `/tenants/<slug>/inbox/<id>/<raw|retry>`. The slug and the id are validated separately.
 */
const TENANT_ROUTE = /^\/tenants\/([^/]+)(?:\/inbox(?:\/([^/]+)(?:\/(raw|retry))?)?)?$/;

/**
 * The ops API behind `fetch()`.
 *
 * `GET /health` is public and says nothing but `{"ok":true}` — enough for an uptime check, not
 * enough to learn what the worker is. Everything else is for operators and scripts, and does not
 * exist unless OPS_TOKEN is set: with no token every other path answers 404, the same as any
 * unknown path, so a deployment that never configured the API is indistinguishable from a worker
 * with no API at all. With a token, a missing or wrong bearer gets a 401; the comparison is
 * constant-time. One token per Worker: the operator runs every tenant, and no tenant ever gets ops
 * access to a shared relay.
 *
 * Routes:
 *
 * - `GET /tenants` — every tenant in the table with its public config and per-status counts.
 * - `GET /tenants/:slug` — one tenant.
 * - `GET /tenants/:slug/inbox?status=&limit=` — its queue rows, newest first, metadata only.
 * - `GET /tenants/:slug/inbox/:id` — one row.
 * - `GET /tenants/:slug/inbox/:id/raw` — the stored message, streamed from R2 as message/rfc822.
 * - `POST /tenants/:slug/inbox/:id/retry` — requeue one row: 202 requeued, 409 already pending.
 * - `POST /tenants/:slug/inbox/retry?status=dead|rejected` — requeue every row in that state.
 * - `DELETE /tenants/:slug/inbox/:id` — drop the row and its R2 object.
 *
 * A `:slug` must be in the table and an `:id` must match the ULID alphabet before either goes
 * anywhere near a Durable Object, SQL or R2; every unknown or malformed route is a 404.
 */
export async function handleOps(
	request: Request,
	env: RelayEnv,
	registry: TenantRegistry,
): Promise<Response> {
	const url = new URL(request.url);
	const { pathname } = url;
	const { method } = request;

	if (method === "GET" && pathname === "/health") {
		return json({ ok: true });
	}

	const opsToken = opsTokenOf(env);
	if (opsToken === null) {
		if (typeof env.OPS_TOKEN === "string" && env.OPS_TOKEN.trim() !== "") {
			logEvent("warn", "ops_token_too_short", {});
		}
		return notFound();
	}
	const presented = bearerToken(request);
	if (presented === null || !timingSafeEqual(presented, opsToken)) {
		return unauthorized();
	}

	if (pathname === "/tenants" && method === "GET") {
		const tenants = registry.list();
		const counts = await Promise.all(
			tenants.map((tenant) => inboxQueueFor(env, tenant.slug).counts()),
		);
		const items = [];
		for (const [i, tenant] of tenants.entries()) {
			items.push({ ...tenant, counts: counts[i] });
		}
		return json({ ok: true, items });
	}

	const match = TENANT_ROUTE.exec(pathname);
	const slug = match?.[1];
	if (slug === undefined || !SLUG_PATTERN.test(slug)) {
		return notFound();
	}
	const tenant = registry.get(slug);
	if (tenant === null) {
		return notFound();
	}
	const queue = inboxQueueFor(env, slug);
	const segment = match?.[2];
	const action = match?.[3];
	const atInbox = pathname.endsWith("/inbox");

	if (segment === undefined && !atInbox) {
		return method === "GET"
			? json({ ok: true, item: { ...tenant, counts: await queue.counts() } })
			: notFound();
	}

	if (atInbox && method === "GET") {
		const rawStatus = url.searchParams.get("status");
		let status: InboxStatus | null = null;
		if (rawStatus !== null) {
			if (!isInboxStatus(rawStatus)) {
				return json({ ok: false, error: "invalid status" }, 400);
			}
			status = rawStatus;
		}
		const limit = intParam(url.searchParams, "limit", LIST_DEFAULT, LIST_MAX);
		return json({ ok: true, items: await queue.list(status, limit) });
	}

	if (segment === "retry" && action === undefined && method === "POST") {
		const status = url.searchParams.get("status");
		if (status !== "dead" && status !== "rejected") {
			return json({ ok: false, error: "status must be dead or rejected" }, 400);
		}
		const requeued = await queue.retryAll(status);
		return json({ ok: true, status, requeued }, 202);
	}

	const id = segment;
	if (id === undefined || !ULID_PATTERN.test(id)) {
		return notFound();
	}

	if (action === undefined && method === "GET") {
		const item = await queue.get(id);
		return item === null ? notFound() : json({ ok: true, item });
	}

	if (action === undefined && method === "DELETE") {
		return (await queue.remove(id)) ? json({ ok: true, id }) : notFound();
	}

	if (action === "raw" && method === "GET") {
		const item = await queue.get(id);
		if (item === null) {
			return notFound();
		}
		const object = await env.INBOX.get(item.r2Key);
		if (object === null) {
			return notFound("stored message missing from R2");
		}
		return new Response(object.body, {
			headers: {
				"Content-Type": "message/rfc822",
				"Content-Length": String(object.size),
				"Content-Disposition": `attachment; filename="${id}.eml"`,
			},
		});
	}

	if (action === "retry" && method === "POST") {
		const result = await queue.retry(id);
		if (result === "requeued") {
			return json({ ok: true, id }, 202);
		}
		if (result === "already_pending") {
			return json({ ok: false, error: "already pending" }, 409);
		}
		return notFound();
	}

	return notFound();
}
