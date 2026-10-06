---
title: Ops API reference
description: Every route of the Cloudflare Email relay's ops API, the fields of a queue row, the four message states and the log events the Worker writes.
order: 3
tags: [ops, api, reference, logs]
updated: 2026-10-06
---

The relay's `fetch()` handler is a small JSON API for operators and scripts: list tenants and their queues, read a stored message, requeue what failed, and delete what should not be delivered. It is not meant for browsers, so there are no cookies, no CORS and no content negotiation.

## Access

- `GET /health` is public and answers `{"ok":true}`. It says nothing else, so it is enough for an uptime check and not enough to learn what the Worker is.
- Every other route needs `Authorization: Bearer <OPS_TOKEN>`. The token is the Worker secret `OPS_TOKEN` and must be at least 32 characters.
- **One token per Worker.** The operator runs every tenant, and no tenant ever receives ops access to a shared relay.
- While `OPS_TOKEN` is unset, blank or shorter than 32 characters, every route except `/health` answers 404, the same as any unknown path. A too-short token also logs `ops_token_too_short`, so a truncated paste never protects a relay with a few characters.
- With a valid token configured, a missing or wrong bearer token gets 401 with a `WWW-Authenticate: Bearer` header. The comparison is constant-time.

The API lives on the Worker's `workers.dev` hostname. For another layer, put a Cloudflare Access policy in front of it, either an Access application on that hostname or `workers_dev: false` plus a custom route behind Access. No code change is involved.

The examples below use `<RELAY_HOST>` for the Worker's hostname and `<SLUG>` for a tenant's slug. A route whose slug is not in the tenant table, or whose message ID is not a valid ULID, answers 404.

## Routes

| Route                                          | What it does                                                                                                          |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                                  | Public liveness check.                                                                                                |
| `GET /tenants`                                 | Every tenant's public configuration plus its `counts` of `pending`, `delivered`, `rejected` and `dead` rows.          |
| `GET /tenants/<SLUG>`                          | The same for one tenant.                                                                                              |
| `GET /tenants/<SLUG>/inbox?status=&limit=`     | The tenant's rows, newest first. Metadata only.                                                                       |
| `GET /tenants/<SLUG>/inbox/<ID>`               | One row.                                                                                                              |
| `GET /tenants/<SLUG>/inbox/<ID>/raw`           | The stored message, streamed from R2 as `message/rfc822` with `Content-Disposition: attachment; filename="<ID>.eml"`. |
| `POST /tenants/<SLUG>/inbox/<ID>/retry`        | Requeue one row for an immediate attempt. 202 when requeued, 409 when it is already `pending`.                        |
| `POST /tenants/<SLUG>/inbox/retry?status=dead` | Requeue every row in that state. `status` must be `dead` or `rejected`.                                               |
| `DELETE /tenants/<SLUG>/inbox/<ID>`            | Drop the row and its R2 object, whatever its state.                                                                   |

### Listing

```bash
curl -H "Authorization: Bearer <OPS_TOKEN>" https://<RELAY_HOST>/tenants
curl -H "Authorization: Bearer <OPS_TOKEN>" "https://<RELAY_HOST>/tenants/<SLUG>/inbox?status=pending&limit=20"
```

`GET /tenants` answers `{"ok": true, "items": [...]}`, where each item is the tenant's row from `tenants.json` with every default applied (slug, platform, domains, enabled, note, the retention, attempt, backoff and timeout settings) plus its `counts`. `GET /tenants/<SLUG>` answers `{"ok": true, "item": {...}}` in the same shape.

The inbox listing answers `{"ok": true, "items": [...]}`. `status` is one of the four states below; any other value answers 400 `invalid status`. `limit` defaults to 50 and is capped at 500, and a value that is not a positive whole number falls back to the default instead of failing.

### Retrying and deleting

```bash
curl -X POST -H "Authorization: Bearer <OPS_TOKEN>" https://<RELAY_HOST>/tenants/<SLUG>/inbox/<ID>/retry
curl -X POST -H "Authorization: Bearer <OPS_TOKEN>" "https://<RELAY_HOST>/tenants/<SLUG>/inbox/retry?status=dead"
curl -X DELETE -H "Authorization: Bearer <OPS_TOKEN>" https://<RELAY_HOST>/tenants/<SLUG>/inbox/<ID>
```

- **A retry gives the row its full attempt budget back**: the attempt count returns to 0, the next attempt is due at once and any purge date is cleared. It answers 202 with `{"ok": true, "id": "<ID>"}`.
- **A row that is already `pending` is left alone** and answers 409 `already pending`. Its attempt may be in flight, and resetting it could deliver the message twice. This is expected, not an error to fix.
- **The bulk retry** answers 202 with `{"ok": true, "status": "<status>", "requeued": <count>}`. Any other `status` answers 400 `status must be dead or rejected`.
- **Delete removes the R2 object first, then the row.** If the object cannot be deleted the row survives, so a failure is visible rather than leaving an orphan in the bucket.

Use a retry after you fix the cause: a rotated secret, a corrected `inboundUrl`, an ERP that is back up. Retrying without fixing it only reproduces the failure.

## The four states

| State       | Meaning                                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pending`   | Stored and waiting for its next attempt, or waiting for a fix to the tenant's secret.                                                                         |
| `delivered` | The ERP answered 2xx. The row and its R2 object are purged after the tenant's `retentionDays`.                                                                |
| `rejected`  | The ERP answered with a status the relay does not retry (any 4xx other than 408 and 429, or a 3xx). Parked until an operator fixes the cause and requeues it. |
| `dead`      | The attempts ran out, or the stored object is missing from R2 (`stored message missing from R2`). Requeue it after fixing the cause.                          |

## A queue row

The inbox routes answer rows with these fields. Timestamps are milliseconds since the Unix epoch.

| Field           | Meaning                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `id`            | The message's ULID. It sorts by arrival time and is also the R2 object's name.                                           |
| `r2Key`         | The R2 object key, `<keyPrefix><slug>/<id>.eml`.                                                                         |
| `from`, `to`    | The SMTP envelope. `from` is empty for a bounce.                                                                         |
| `messageId`     | The message's own `Message-ID`, or `null` when it has none.                                                              |
| `size`          | Stored size in bytes, the two envelope header lines included.                                                            |
| `receivedAt`    | When the relay accepted the message.                                                                                     |
| `status`        | One of the four states.                                                                                                  |
| `attempts`      | Delivery attempts made so far.                                                                                           |
| `nextAttemptAt` | When the next attempt is due, or `null` when none is scheduled.                                                          |
| `lastAttemptAt` | When the last attempt finished.                                                                                          |
| `lastStatus`    | The HTTP status of the last attempt, or `null` when it got no response (a timeout or a network error).                   |
| `lastError`     | A one-line reason for the last failure, up to 200 characters, such as `HTTP 401: invalid signature`.                     |
| `remoteRef`     | What the ERP created or matched, such as an Odoo thread ID or a Frappe Communication name. `null` when it reported none. |
| `deliveredAt`   | When the ERP accepted the message.                                                                                       |
| `purgeAt`       | When a delivered row and its object will be dropped.                                                                     |

A `delivered` row with an empty `remoteRef` is not an error. The ERP answered 2xx and chose to ignore the message: a duplicate, a bounce, or its own outgoing mail looping back.

## Log events

The Worker writes one JSON line per event, so Workers Logs can filter on the `event` field and on any other field. The example configuration turns observability on, and `npx wrangler tail` streams the same lines. Events carry ids, addresses, statuses and counts, never a message body, a secret or the inbound URL.

| Event                                  | Level               | Meaning                                                                                                                                                                                                                             |
| -------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `email_stored`                         | info                | A message was stored in R2 and queued.                                                                                                                                                                                              |
| `inbox_enqueued`                       | info                | A queue row was created, with the time of its first attempt.                                                                                                                                                                        |
| `inbox_duplicate`                      | info                | A retried intake tried to enqueue a row that already existed, so no second row was made.                                                                                                                                            |
| `email_unrouted`                       | warn                | The recipient's domain belongs to no tenant. The sender was refused with "Recipient domain is not served by this relay".                                                                                                            |
| `email_tenant_disabled`                | warn                | The tenant has `"enabled": false`. The sender was refused with "Recipient domain is disabled on this relay".                                                                                                                        |
| `email_rejected`                       | warn                | The envelope sender or recipient has a control character or is too long for a header line. The sender was refused with "Invalid envelope address".                                                                                  |
| `email_store_failed`                   | error               | R2 or the queue failed. The error is rethrown, so Cloudflare answers the sending server with a temporary failure and it retries.                                                                                                    |
| `delivery_result`                      | info, warn or error | One attempt's outcome: `outcome` (`delivered`, `retry`, `rejected` or `dead`), `status`, `attempts`, `nextAttemptAt`, `remoteRef` and `error`. `applied` is false when an operator changed the row while the attempt was in flight. |
| `delivery_error`                       | error               | An attempt threw before it could be settled.                                                                                                                                                                                        |
| `tenant_config_error`                  | error               | The tenant's secret is missing or malformed. Its rows stay `pending` and no attempt is charged. Logged about once a minute until fixed.                                                                                             |
| `alarm_failed`                         | error               | A delivery pass failed in one of three phases (`deliver`, `purge` or `rearm`). The queue's alarm is re-armed a minute later.                                                                                                        |
| `inbox_requeued`, `inbox_requeued_all` | info                | An operator requeued one row, or every row in a state (with the `count`).                                                                                                                                                           |
| `inbox_removed`                        | info                | An operator deleted a row and its object.                                                                                                                                                                                           |
| `inbox_purged`                         | info                | Delivered rows whose retention ran out were dropped, with the `count`.                                                                                                                                                              |
| `inbox_foreign_tenant`                 | error               | A queue instance was addressed with another tenant's slug. This cannot happen in normal operation. The intake fails with a temporary error (an `email_store_failed` line follows), so the sender retries.                           |
| `ops_token_too_short`                  | warn                | `OPS_TOKEN` is set but shorter than 32 characters, so the ops API is disabled.                                                                                                                                                      |
| `unhandled_error`                      | error               | An unexpected error in the ops API. The caller received a 500 `internal error`.                                                                                                                                                     |

## Related

- [Troubleshooting](../troubleshooting.md): which event or status to look at for each symptom.
- [Tenants and secrets](tenants.md): the settings behind retention, backoff and the attempt limit.
- [Inbound contract](inbound-contract.md): how a status code from the ERP becomes a row state.
