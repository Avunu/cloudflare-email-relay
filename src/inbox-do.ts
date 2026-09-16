import { DurableObject } from "cloudflare:workers";
import type { RelayEnv } from "./env";
import { backoffMs, classifyStatus } from "./lib/backoff";
import { signBody, unixSeconds } from "./lib/sign";
import { logEvent } from "./lib/util";
import { TenantConfigError } from "./tenants";
import type { TenantConfig, TenantRegistry } from "./tenants";
import { VERSION } from "./version";

// ---------------------------------------------------------------------------
// The delivery queue: one Durable Object per tenant, addressed as
// idFromName(slug), holding a row per stored message in SQLite and pushing
// each one to that tenant's ERP from its alarm.
//
// The Worker stores first and pushes second. By the time a row exists here the
// raw message is already in R2, so an ERP outage, a wrong secret or a bad
// deploy can only ever delay a message, never lose it. The alarm is the only
// thing that delivers: enqueue() arms it, each pass takes the rows whose time
// has come, and a failed attempt moves the row's next_attempt_at out along the
// backoff schedule until maxAttempts is spent. Rows the ERP refuses outright
// (wrong key, no route) are parked as `rejected` for an operator rather than
// retried — nothing about them gets better on its own.
//
// One instance per tenant is what makes tenants independent: a down ERP backs
// up its own queue only, a broken tenant secret parks its own rows only, and
// an ops call is always scoped to one tenant's data. The instance learns which
// tenant it is from its first enqueue() and keeps that in the `meta` table —
// a Durable Object cannot read its own idFromName() name.
//
// SQLite rather than the KV storage API because every status transition is a
// single UPDATE guarded by `status = 'pending'`: an operator retry racing an
// in-flight attempt, or a delete racing a delivery, resolves inside the
// database instead of in application code.
// ---------------------------------------------------------------------------

/** Rows delivered per alarm pass. More due rows simply re-arm the alarm for "now". */
const ALARM_BATCH = 10;

/** Expired R2 objects deleted per alarm pass (R2 accepts up to 1000 keys per delete call). */
const PURGE_BATCH = 100;

/** How long to back off when the pass itself failed (config error, storage error). */
const ALARM_RETRY_MS = 60_000;

/** Upper bound on last_error, mirrored by the CHECK constraint in the schema. */
const MAX_ERROR_CHARS = 200;

/** Hard cap on list(); the ops route clamps to less. */
const MAX_LIST = 1000;

const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS inbox (
		id TEXT PRIMARY KEY,
		r2_key TEXT NOT NULL,
		envelope_from TEXT NOT NULL,
		envelope_to TEXT NOT NULL,
		message_id TEXT,
		size INTEGER NOT NULL,
		received_at INTEGER NOT NULL,
		status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'rejected', 'dead')),
		attempts INTEGER NOT NULL DEFAULT 0,
		next_attempt_at INTEGER,
		last_attempt_at INTEGER,
		last_status INTEGER,
		last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= ${MAX_ERROR_CHARS}),
		remote_ref TEXT,
		delivered_at INTEGER,
		purge_at INTEGER
	)`,
	"CREATE INDEX IF NOT EXISTS inbox_status_next_attempt ON inbox (status, next_attempt_at)",
	"CREATE INDEX IF NOT EXISTS inbox_purge_at ON inbox (purge_at)",
	// The instance's identity (key "tenant"), written by the first enqueue().
	"CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
];

/** Longest remote reference kept; ERPs answer with a record id or name, never prose. */
const MAX_REMOTE_REF_CHARS = 200;

export type InboxStatus = "pending" | "delivered" | "rejected" | "dead";

const INBOX_STATUSES: ReadonlySet<string> = new Set(["pending", "delivered", "rejected", "dead"]);

export function isInboxStatus(value: string): value is InboxStatus {
	return INBOX_STATUSES.has(value);
}

/** What the email handler hands over once the message is safely in R2. */
export interface EnqueueInput {
	/** The tenant this instance serves; must match on every call after the first. */
	tenant: string;
	/** ULID minted by the email handler; also the R2 object's basename. */
	id: string;
	r2Key: string;
	/** Envelope sender; empty for a bounce (the null reverse-path). */
	from: string;
	/** Envelope recipient — the routed address. */
	to: string;
	/** The message's own Message-ID, when it has a usable one. */
	messageId: string | null;
	/** Stored size in bytes, envelope headers included. */
	size: number;
	/** Milliseconds since the epoch. */
	receivedAt: number;
}

/** One queue row, as the ops API shows it. Timestamps are milliseconds since the epoch. */
export interface InboxRecord {
	id: string;
	r2Key: string;
	from: string;
	to: string;
	messageId: string | null;
	size: number;
	receivedAt: number;
	status: InboxStatus;
	attempts: number;
	nextAttemptAt: number | null;
	lastAttemptAt: number | null;
	/** HTTP status of the last attempt; null when it never got a response. */
	lastStatus: number | null;
	lastError: string | null;
	/**
	 * What the ERP created or matched once delivered — an Odoo thread id or a Frappe Communication
	 * name; null when it reported none (duplicate, bounce, loop) or answered without JSON.
	 */
	remoteRef: string | null;
	deliveredAt: number | null;
	/** When the R2 object and this row are dropped; set on delivery from RETENTION_DAYS. */
	purgeAt: number | null;
}

export type RetryResult = "requeued" | "not_found" | "already_pending";

/**
 * How enqueue() ended: a new row; a row that already existed (a retried email() invocation); or a
 * refusal because this instance serves another tenant — a bug the caller must fail loudly on.
 */
export type EnqueueResult = "enqueued" | "duplicate" | "foreign_tenant";

/** The statuses retryAll() accepts: the two an operator can do something about. */
export type RetryableStatus = "dead" | "rejected";

/**
 * A row exactly as SQLite returns it. Extends the storage value map because SqlStorage.exec's row
 * type must carry an index signature.
 */
interface InboxRow extends Record<string, SqlStorageValue> {
	id: string;
	r2_key: string;
	envelope_from: string;
	envelope_to: string;
	message_id: string | null;
	size: number;
	received_at: number;
	status: string;
	attempts: number;
	next_attempt_at: number | null;
	last_attempt_at: number | null;
	last_status: number | null;
	last_error: string | null;
	remote_ref: string | null;
	delivered_at: number | null;
	purge_at: number | null;
}

/** How one delivery attempt ended, before the attempt budget is applied. */
type Verdict = "delivered" | "retry" | "rejected" | "dead";

function toRecord(row: InboxRow): InboxRecord {
	return {
		id: row.id,
		r2Key: row.r2_key,
		from: row.envelope_from,
		to: row.envelope_to,
		messageId: row.message_id,
		size: row.size,
		receivedAt: row.received_at,
		// The CHECK constraint guarantees the value; the fallback only satisfies the type.
		status: isInboxStatus(row.status) ? row.status : "dead",
		attempts: row.attempts,
		nextAttemptAt: row.next_attempt_at,
		lastAttemptAt: row.last_attempt_at,
		lastStatus: row.last_status,
		lastError: row.last_error,
		remoteRef: row.remote_ref,
		deliveredAt: row.delivered_at,
		purgeAt: row.purge_at,
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * An envelope address as an HTTP header value or an R2 metadata value. Both transports are
 * ASCII-shaped: `fetch` refuses header values with code points above U+00FF (and a server that does
 * accept raw bytes decodes them as Latin-1), and R2 custom metadata is only guaranteed for ASCII.
 * Everything outside printable ASCII — plus `%` itself, so decodeURIComponent inverts the result
 * exactly — is percent-encoded. An ordinary address passes through byte for byte; an SMTPUTF8 one
 * arrives legible instead of failing the attempt or being silently mangled.
 */
export function asciiValue(value: string): string {
	// The class is printable ASCII (space through `~`) with `%` cut out of the middle.
	return value.replaceAll(/[^ -$&-~]/g, (ch) => encodeURIComponent(ch));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * The JSON object an ERP answered with, unwrapped: Frappe wraps every API method's return value as
 * `{"message": <value>}`, Odoo answers the object directly. Null when the body is not JSON.
 */
function payloadOf(text: string): Record<string, unknown> | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isRecord(parsed)) {
		return null;
	}
	return isRecord(parsed.message) ? parsed.message : parsed;
}

/**
 * The ERP's reference for a delivered message: `remote_ref` (the contract), else the shapes the two
 * platforms produced before it — Odoo's numeric `thread_id`, Frappe's `communication` name.
 * Anything else (false, null, a duplicate the ERP ignored, a 2xx without JSON) is null.
 */
export function remoteRefOf(text: string): string | null {
	const payload = payloadOf(text);
	if (payload === null) {
		return null;
	}
	const candidates = [payload.remote_ref, payload.thread_id, payload.communication];
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate !== "") {
			return candidate.slice(0, MAX_REMOTE_REF_CHARS);
		}
		if (typeof candidate === "number" && Number.isFinite(candidate)) {
			return String(candidate);
		}
	}
	return null;
}

/**
 * A short, operator-facing description of a failed response: the ERP's `error` field when the body
 * is the contract's JSON shape (Frappe's wrapper unwrapped), the first line of Frappe's `exception`
 * when the site threw, otherwise the first line of whatever came back (an nginx 502 page, say).
 */
export function errorOf(status: number, text: string): string {
	const trimmed = text.trim();
	const payload = payloadOf(trimmed);
	let detail: string | null = null;
	if (payload !== null) {
		if (typeof payload.error === "string" && payload.error !== "") {
			detail = payload.error;
		} else if (typeof payload.exception === "string" && payload.exception !== "") {
			detail = payload.exception;
		}
	}
	const line = (detail ?? trimmed).split(/\r?\n/, 1)[0] ?? "";
	return (line === "" ? `HTTP ${status}` : `HTTP ${status}: ${line}`).slice(0, MAX_ERROR_CHARS);
}

/** The body as text, or "" when it cannot be read — the status alone still tells the operator. */
async function textOf(response: Response): Promise<string> {
	try {
		return await response.text();
	} catch {
		return "";
	}
}

/** The queue stub for one tenant. */
export function inboxQueueFor(env: RelayEnv, slug: string): DurableObjectStub<InboxQueue> {
	return env.INBOX_QUEUE.get(env.INBOX_QUEUE.idFromName(slug));
}

/** Per-status row counts, as the ops tenant listing shows them. */
export type InboxCounts = Record<InboxStatus, number>;

export class InboxQueue extends DurableObject<RelayEnv> {
	private readonly sql: SqlStorage;
	private readonly registry: TenantRegistry;

	/**
	 * The registry is injected by the bound subclass createRelay() builds: the runtime constructs a
	 * Durable Object with (ctx, env) only, and the tenant table is a build-time input.
	 */
	constructor(ctx: DurableObjectState, env: RelayEnv, registry: TenantRegistry) {
		super(ctx, env);
		this.registry = registry;
		this.sql = ctx.storage.sql;
		// Synchronous, and idempotent, so it simply runs on every instantiation.
		for (const statement of SCHEMA) {
			this.sql.exec(statement);
		}
	}

	/** The tenant this instance serves; null until the first enqueue() named it. */
	tenantSlug(): string | null {
		const [row] = this.sql
			.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'tenant'")
			.toArray();
		return row?.value ?? null;
	}

	/**
	 * Record the tenant on first use, and refuse to serve another one afterwards: the handler
	 * addresses this instance by slug, so a mismatch is a bug, and the one thing a bug must not do
	 * here is deliver one tenant's mail with another tenant's credentials. Reported as a result
	 * rather than thrown so the refusal crosses the RPC boundary as data.
	 */
	private bindTenant(slug: string): boolean {
		this.sql.exec("INSERT OR IGNORE INTO meta (key, value) VALUES ('tenant', ?)", slug);
		return this.tenantSlug() === slug;
	}

	/**
	 * Queue a stored message. Idempotent on `id` so a retried email() invocation cannot create a
	 * second row. Arms the alarm for the first attempt — with the default zero delay it fires as soon
	 * as the email handler returns, so no waitUntil is involved. The delay comes from the committed
	 * table, which cannot fail here; the secret is not needed yet.
	 */
	async enqueue(input: EnqueueInput): Promise<EnqueueResult> {
		if (!this.bindTenant(input.tenant)) {
			logEvent("error", "inbox_foreign_tenant", {
				tenant: this.tenantSlug(),
				requested: input.tenant,
				id: input.id,
			});
			return "foreign_tenant";
		}
		const now = Date.now();
		const delaySeconds = this.registry.get(input.tenant)?.deliveryDelaySeconds ?? 0;
		const nextAttemptAt = now + delaySeconds * 1000;
		const inserted =
			this.sql
				.exec<Pick<InboxRow, "id">>(
					`INSERT OR IGNORE INTO inbox
						(id, r2_key, envelope_from, envelope_to, message_id, size, received_at,
						 status, attempts, next_attempt_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)
					 RETURNING id`,
					input.id,
					input.r2Key,
					input.from,
					input.to,
					input.messageId,
					input.size,
					input.receivedAt,
					nextAttemptAt,
				)
				.toArray().length > 0;
		if (!inserted) {
			logEvent("info", "inbox_duplicate", { tenant: input.tenant, id: input.id });
			return "duplicate";
		}
		await this.armNoLaterThan(nextAttemptAt);
		logEvent("info", "inbox_enqueued", { tenant: input.tenant, id: input.id, nextAttemptAt });
		return "enqueued";
	}

	/** How many rows sit in each status. Cheap enough to run for every tenant on a listing. */
	counts(): InboxCounts {
		const counts: InboxCounts = { pending: 0, delivered: 0, rejected: 0, dead: 0 };
		for (const row of this.sql
			.exec<{ status: string; n: number }>(
				"SELECT status, COUNT(*) AS n FROM inbox GROUP BY status",
			)
			.toArray()) {
			if (isInboxStatus(row.status)) {
				counts[row.status] = row.n;
			}
		}
		return counts;
	}

	get(id: string): InboxRecord | null {
		const [row] = this.sql.exec<InboxRow>("SELECT * FROM inbox WHERE id = ?", id).toArray();
		return row === undefined ? null : toRecord(row);
	}

	/** Newest first (ULIDs sort by arrival time), optionally filtered by status. Metadata only. */
	list(status: InboxStatus | null = null, limit = 50): InboxRecord[] {
		const cap = Math.min(Math.max(Math.trunc(limit), 1), MAX_LIST);
		const rows =
			status === null
				? this.sql.exec<InboxRow>("SELECT * FROM inbox ORDER BY id DESC LIMIT ?", cap)
				: this.sql.exec<InboxRow>(
						"SELECT * FROM inbox WHERE status = ? ORDER BY id DESC LIMIT ?",
						status,
						cap,
					);
		return rows.toArray().map((row) => toRecord(row));
	}

	/**
	 * Put a row back on the queue for an immediate attempt with a fresh attempt budget — the operator
	 * has presumably fixed whatever failed. A row that is already pending is left alone (409 at the
	 * API): its attempt may be in flight, and resetting it would double-deliver.
	 */
	async retry(id: string): Promise<RetryResult> {
		const now = Date.now();
		const requeued =
			this.sql
				.exec<Pick<InboxRow, "id">>(
					`UPDATE inbox
					 SET status = 'pending', attempts = 0, next_attempt_at = ?, purge_at = NULL
					 WHERE id = ? AND status <> 'pending'
					 RETURNING id`,
					now,
					id,
				)
				.toArray().length > 0;
		if (requeued) {
			await this.armNoLaterThan(now);
			logEvent("info", "inbox_requeued", { tenant: this.tenantSlug(), id });
			return "requeued";
		}
		return this.get(id) === null ? "not_found" : "already_pending";
	}

	/** Requeue every row in `status` — after an outage, or after fixing the secret. Returns the count. */
	async retryAll(status: RetryableStatus): Promise<number> {
		if (status !== "dead" && status !== "rejected") {
			throw new RangeError("retryAll accepts 'dead' or 'rejected'");
		}
		const now = Date.now();
		const count = this.sql
			.exec<Pick<InboxRow, "id">>(
				`UPDATE inbox
				 SET status = 'pending', attempts = 0, next_attempt_at = ?, purge_at = NULL
				 WHERE status = ?
				 RETURNING id`,
				now,
				status,
			)
			.toArray().length;
		if (count > 0) {
			await this.armNoLaterThan(now);
		}
		logEvent("info", "inbox_requeued_all", { tenant: this.tenantSlug(), status, count });
		return count;
	}

	/** Drop a row and its R2 object, whatever its state. False when there is no such row. */
	async remove(id: string): Promise<boolean> {
		const [row] = this.sql
			.exec<Pick<InboxRow, "r2_key">>("SELECT r2_key FROM inbox WHERE id = ?", id)
			.toArray();
		if (row === undefined) {
			return false;
		}
		// Object first: if this fails the row survives and the next attempt reports the object
		// missing, which is visible; the other order could leave an invisible orphan in the bucket.
		await this.env.INBOX.delete(row.r2_key);
		this.sql.exec("DELETE FROM inbox WHERE id = ?", id);
		logEvent("info", "inbox_removed", { tenant: this.tenantSlug(), id });
		return true;
	}

	/**
	 * The delivery loop. Never throws: a throwing alarm handler is retried by the runtime with its
	 * own backoff, which would stack on top of ours and hide the real error. Each phase is isolated
	 * and logged, and a failed pass simply re-arms a minute out.
	 */
	override async alarm(): Promise<void> {
		const tenant = this.tenantSlug();
		let healthy = true;
		try {
			await this.processDue(Date.now(), ALARM_BATCH);
		} catch (error) {
			healthy = false;
			if (error instanceof TenantConfigError) {
				// Loud on purpose: once a minute per broken tenant until the secret is fixed. The rows
				// stay pending and are not charged an attempt.
				logEvent("error", "tenant_config_error", { tenant, message: error.message });
			} else {
				logEvent("error", "alarm_failed", {
					tenant,
					phase: "deliver",
					message: errorMessage(error),
				});
			}
		}
		try {
			await this.purgeExpired(Date.now());
		} catch (error) {
			healthy = false;
			logEvent("error", "alarm_failed", { tenant, phase: "purge", message: errorMessage(error) });
		}
		try {
			await (healthy ? this.rearm() : this.ctx.storage.setAlarm(Date.now() + ALARM_RETRY_MS));
		} catch (error) {
			logEvent("error", "alarm_failed", { tenant, phase: "rearm", message: errorMessage(error) });
		}
	}

	/** Never push an existing alarm later; only ever bring it forward. */
	private async armNoLaterThan(at: number): Promise<void> {
		const current = await this.ctx.storage.getAlarm();
		if (current === null || at < current) {
			await this.ctx.storage.setAlarm(at);
		}
	}

	/**
	 * Arm for the earliest thing left to do — the next pending attempt or the next purge — or clear
	 * the alarm when the queue is idle. Called at the end of every pass, so a pass that delivered ten
	 * of twenty due rows comes straight back for the rest.
	 */
	private async rearm(): Promise<void> {
		const { next } = this.sql
			.exec<{ next: number | null }>(
				`SELECT MIN(t) AS next FROM (
					SELECT next_attempt_at AS t FROM inbox WHERE status = 'pending'
					UNION ALL
					SELECT purge_at FROM inbox WHERE purge_at IS NOT NULL
				)`,
			)
			.one();
		await (next === null ? this.ctx.storage.deleteAlarm() : this.ctx.storage.setAlarm(next));
	}

	/**
	 * Deliver the rows whose time has come, oldest first, one at a time — an ERP processes inbound
	 * mail in one transaction each, and a burst is better spread than fired at once. The tenant's
	 * config is resolved once per pass; when it is invalid nothing is attempted and no attempt is
	 * charged.
	 */
	private async processDue(now: number, batch: number): Promise<void> {
		const due = this.sql
			.exec<InboxRow>(
				`SELECT * FROM inbox
				 WHERE status = 'pending' AND next_attempt_at <= ?
				 ORDER BY next_attempt_at, id
				 LIMIT ?`,
				now,
				batch,
			)
			.toArray();
		if (due.length === 0) {
			return;
		}
		const slug = this.tenantSlug();
		if (slug === null) {
			// Rows without a tenant cannot exist (enqueue binds first), but the type says otherwise.
			throw new RangeError("queue instance has pending rows but no tenant");
		}
		const config = this.registry.resolve(slug, this.env);
		for (const row of due) {
			try {
				await this.deliver(row, config);
			} catch (error) {
				logEvent("error", "delivery_error", {
					tenant: slug,
					id: row.id,
					message: errorMessage(error),
				});
			}
		}
	}

	/**
	 * One attempt. The timestamp and signature are computed fresh here and never stored: the ERP
	 * rejects a timestamp more than five minutes old, so a signature from an earlier attempt would be
	 * useless, and keeping it would only put secret-derived material on disk.
	 */
	private async deliver(row: InboxRow, config: TenantConfig): Promise<void> {
		const attempt = row.attempts + 1;
		const object = await this.env.INBOX.get(row.r2_key);
		if (object === null) {
			// The queue only ever points at objects it stored, so the object was deleted by hand
			// (or by a bucket lifecycle rule). Nothing to deliver, and retrying cannot fix that.
			await this.settle(row, config, attempt, "dead", null, "stored message missing from R2", null);
			return;
		}
		const body = await object.arrayBuffer();
		const timestamp = unixSeconds();
		const signature = await signBody(config.webhookSecret, timestamp, body);
		const headers: Record<string, string> = {
			"Content-Type": "message/rfc822",
			"User-Agent": `cloudflare-email-relay/${VERSION}`,
			"X-Email-Relay-Id": row.id,
			"X-Email-Relay-Tenant": config.tenant.slug,
			"X-Email-Relay-Timestamp": String(timestamp),
			"X-Email-Relay-Signature": signature,
			"X-Email-Relay-Envelope-From": asciiValue(row.envelope_from),
			"X-Email-Relay-Envelope-To": asciiValue(row.envelope_to),
			"X-Email-Relay-Attempt": String(attempt),
		};
		if (config.access !== null) {
			headers["CF-Access-Client-Id"] = config.access.clientId;
			headers["CF-Access-Client-Secret"] = config.access.clientSecret;
		}

		let response: Response | null = null;
		let failure: string | null = null;
		try {
			// redirect: "manual" — following a redirect would replay the signed body to an origin
			// nobody vetted; a 3xx is classified as a rejection instead so the URL gets fixed.
			response = await fetch(config.inboundUrl, {
				method: "POST",
				headers,
				body,
				redirect: "manual",
				signal: AbortSignal.timeout(config.deliveryTimeoutMs),
			});
		} catch (error) {
			// Network failure or timeout: no verdict from the ERP, so it is treated as transient.
			failure = errorMessage(error);
		}
		const status = response?.status ?? null;
		const verdict: Verdict = status === null ? "retry" : classifyStatus(status);
		let remoteRef: string | null = null;
		if (response !== null) {
			const text = await textOf(response);
			if (verdict === "delivered") {
				remoteRef = remoteRefOf(text);
			} else {
				failure = errorOf(response.status, text);
			}
		}
		await this.settle(row, config, attempt, verdict, status, failure, remoteRef);
	}

	/**
	 * Apply an attempt's outcome to its row in a single UPDATE guarded by `status = 'pending'`, so a
	 * row an operator removed or requeued while the attempt was in flight is left as they set it. A
	 * retry that spends the last attempt becomes `dead`; a delivery schedules the purge (at once when
	 * retention is zero — the purge pass runs right after this one).
	 */
	private async settle(
		row: InboxRow,
		config: TenantConfig,
		attempt: number,
		verdict: Verdict,
		status: number | null,
		error: string | null,
		remoteRef: string | null,
	): Promise<void> {
		const now = Date.now();
		const outcome: Verdict =
			verdict === "retry" && attempt >= config.maxAttempts ? "dead" : verdict;
		const nextStatus: InboxStatus = outcome === "retry" ? "pending" : outcome;
		const nextAttemptAt =
			outcome === "retry" ? now + backoffMs(config.backoffSeconds, attempt) : null;
		const deliveredAt = outcome === "delivered" ? now : null;
		const purgeAt = outcome === "delivered" ? now + config.retentionMs : null;
		const lastError = error === null ? null : error.slice(0, MAX_ERROR_CHARS);

		const applied =
			this.sql
				.exec<Pick<InboxRow, "id">>(
					`UPDATE inbox
					 SET status = ?, attempts = ?, next_attempt_at = ?, last_attempt_at = ?,
					     last_status = ?, last_error = ?, remote_ref = ?, delivered_at = ?, purge_at = ?
					 WHERE id = ? AND status = 'pending'
					 RETURNING id`,
					nextStatus,
					attempt,
					nextAttemptAt,
					now,
					status,
					lastError,
					remoteRef,
					deliveredAt,
					purgeAt,
					row.id,
				)
				.toArray().length > 0;

		const level = outcome === "delivered" ? "info" : outcome === "dead" ? "error" : "warn";
		logEvent(level, "delivery_result", {
			tenant: config.tenant.slug,
			id: row.id,
			from: row.envelope_from,
			to: row.envelope_to,
			outcome,
			status,
			attempts: attempt,
			nextAttemptAt,
			remoteRef,
			error: lastError,
			// False when the row changed under the attempt (removed or requeued by an operator).
			applied,
		});
	}

	/** Drop the R2 object and the row of every delivered message whose retention has run out. */
	private async purgeExpired(now: number): Promise<void> {
		const expired = this.sql
			.exec<Pick<InboxRow, "id" | "r2_key">>(
				`SELECT id, r2_key FROM inbox
				 WHERE purge_at IS NOT NULL AND purge_at <= ?
				 ORDER BY purge_at
				 LIMIT ?`,
				now,
				PURGE_BATCH,
			)
			.toArray();
		if (expired.length === 0) {
			return;
		}
		await this.env.INBOX.delete(expired.map((row) => row.r2_key));
		for (const row of expired) {
			// Guarded on purge_at so a row requeued in the meantime (which clears it) survives.
			this.sql.exec("DELETE FROM inbox WHERE id = ? AND purge_at IS NOT NULL", row.id);
		}
		logEvent("info", "inbox_purged", { tenant: this.tenantSlug(), count: expired.length });
	}
}
