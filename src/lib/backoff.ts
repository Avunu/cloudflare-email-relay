// ---------------------------------------------------------------------------
// Retry policy for the push to the ERP.
//
// Delivery is attempted from a Durable Object alarm, so the schedule is a
// list of delays rather than a formula: operators can read it straight off
// the tenant's `backoffSeconds` and tune it without touching code. The default
// climbs from a minute to six hours so a brief ERP restart costs one minute
// and an overnight outage does not hammer it, and with maxAttempts = 32 the
// message survives about a week before it is marked dead.
// ---------------------------------------------------------------------------

export { DEFAULT_BACKOFF_SECONDS } from "../tenant-schema";

/**
 * How long to wait after attempt number `attempt` (1-based) has failed. The schedule's last value
 * repeats for every attempt beyond its length, so a short schedule still retries forever (until
 * maxAttempts) rather than falling off the end.
 */
export function backoffMs(schedule: readonly number[], attempt: number): number {
	const last = schedule.at(-1);
	if (last === undefined) {
		throw new RangeError("backoff schedule must not be empty");
	}
	const index = Math.min(Math.max(attempt, 1), schedule.length) - 1;
	return (schedule[index] ?? last) * 1000;
}

/**
 * What a delivery attempt's HTTP status means for the queue row:
 *
 * - `delivered` — the ERP accepted the message; the row is done.
 * - `retry` — a transient failure; keep the row pending and try again on the schedule.
 * - `rejected` — the ERP answered but will not take the message; keep the row for an operator.
 */
export type Outcome = "delivered" | "retry" | "rejected";

/**
 * 2xx delivered; 408 (request timeout), 429 (rate limited) and every 5xx retry. Everything else is
 * rejected — the other 4xx are the ERP's own verdicts (401 wrong secret, 404 unknown key, 422 no
 * route, Frappe's 417 for a validation error), and a 3xx means the inbound URL is wrong (deliveries
 * are sent with `redirect: "manual"`, since following a redirect would replay the signed body to an
 * origin nobody vetted). None of those get better by retrying.
 */
export function classifyStatus(status: number): Outcome {
	if (status >= 200 && status < 300) {
		return "delivered";
	}
	if (status === 408 || status === 429 || (status >= 500 && status < 600)) {
		return "retry";
	}
	return "rejected";
}
