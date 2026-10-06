# @avunu/cloudflare-email-relay

**Documentation:** [cloudflare-email.avunu.net](https://cloudflare-email.avunu.net) covers the whole Cloudflare Email suite: how it works, deploying the relay, the Frappe/ERPNext, Odoo and WordPress adapters, troubleshooting and the ops API. The Markdown source is in [`docs/`](docs/README.md).

A multi-tenant Cloudflare Email Routing Worker that turns inbound mail into signed HTTPS pushes to the ERP that owns the recipient's domain — an Odoo database running [`mail_cloudflare`](https://github.com/Avunu/avunu-odoo-addons/tree/18.0/mail_cloudflare) or a Frappe site running [`cloudflare_email_delivery`](https://github.com/Avunu/cloudflare_email_delivery). Every message is stored in R2 before anything is pushed, and each tenant has its own durable retry queue, so an ERP outage, a wrong secret or a bad deploy can delay a message but never lose it.

This package holds all of the logic. Deployments live in a separate fleet repository that supplies, per Worker, a `wrangler.jsonc`, a committed `tenants.json` and one secret per tenant — see [Deployment](#deployment).

Outbound mail does not pass through here: each ERP calls the Cloudflare Email Sending API directly.

## Concepts

| Term   | Meaning                                                                                                                                    |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| worker | One deployment: one wrangler.jsonc, one R2 bucket, one ops token. A shared relay serves many tenants; a dedicated worker serves one.       |
| tenant | One ERP instance. A slug, a platform (odoo or frappe), the domains routed to it, its tunables — and, as a secret, its inbound URL and key. |
| domain | The routing key: the domain of the envelope recipient. Exact (acme.example) or a wildcard for every subdomain (*.acme.example).            |

A recipient whose domain belongs to no tenant, or to a disabled one, is **rejected at SMTP time** with a fixed reason — the relay never guesses a tenant and never drops mail silently.

## What it exports

```ts
import { createRelay } from "@avunu/cloudflare-email-relay";
import tenants from "./tenants.json";

const relay = createRelay({ tenants });
export default relay.handler; // email() + fetch()
export const { InboxQueue } = relay; // the Durable Object, bound to this table
```

`createRelay({ tenants, keyPrefix? })` validates the table (a bad table throws, so it fails the deploy) and returns the handler plus the `InboxQueue` class the wrapper must re-export under that exact name for `wrangler.jsonc` to bind. Also exported: the zod schemas and helpers (`TenantSchema`, `TenantTableSchema`, `TenantSecretSchema`, `parseTenantTable`, `parseTenantSecret`, `secretNameFor`, `SLUG_PATTERN`, `DOMAIN_PATTERN`), `TenantRegistry`, the record types and `VERSION`. The schemas alone are available from `@avunu/cloudflare-email-relay/tenants`, which runs in plain Node so a fleet's CI can validate its tables with the Worker's own rules.

## How it works

1.  **`email()`** — Email Routing hands over one message for one recipient. The envelope is validated (no control characters, one header line each), the recipient's domain is looked up in the table, and the message is streamed into R2 as `inbox/<tenant>/<ulid>.eml` with `Delivered-To:` and `Return-Path:` prepended exactly as a delivering MTA would write them. Only then is a row inserted into the tenant's `InboxQueue`. A store failure is rethrown, so Cloudflare answers the sending MTA with a temporary failure and it retries.
2.  **`InboxQueue`** — one SQLite-backed Durable Object per tenant (`idFromName(slug)`). Its alarm delivers due rows oldest first, ten per pass, reads the tenant's secret fresh each pass, and applies the outcome in a single `UPDATE … WHERE status = 'pending'` so an operator action racing an in-flight attempt resolves in the database. Delivered rows are purged from R2 and the table after the tenant's `retentionDays`.
3.  **`fetch()`** — the ops API, per tenant, behind one bearer token.

## Inbound contract

The same contract, with a receiver checklist and a script that signs a test request, is in the [Inbound contract](docs/reference/inbound-contract.md) guide.

Each attempt is `POST <tenant's inboundUrl>` with the stored message as the body, `redirect: manual`.

| Header                            | Value                                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| Content-Type                      | message/rfc822                                                                         |
| X-Email-Relay-Id                  | the row's ULID (stable across attempts — the ERP may deduplicate on it)                |
| X-Email-Relay-Tenant              | the tenant slug                                                                        |
| X-Email-Relay-Timestamp           | Unix seconds, fresh per attempt                                                        |
| X-Email-Relay-Signature           | v1= + hex HMAC-SHA256(secret, "<timestamp>." + body bytes)                             |
| X-Email-Relay-Envelope-From / -To | the SMTP envelope (percent-encoded if not printable ASCII; From is empty for a bounce) |
| X-Email-Relay-Attempt             | 1-based attempt number                                                                 |
| User-Agent                        | cloudflare-email-relay/<version>                                                       |
| CF-Access-Client-Id / -Secret     | only when the tenant's secret carries an Access service token                          |

The body already contains `Delivered-To` (the envelope recipient — the ERP should check its domain is one it owns) and `Return-Path` (`<>` for a bounce) as its first two header lines.

Verification, as both ERP integrations do it:

```python
expected = hmac.new(secret.encode(), f"{timestamp}.".encode() + body, hashlib.sha256).hexdigest()
ok = hmac.compare_digest(signature, f"v1={expected}") and abs(time.time() - int(timestamp)) <= 300
```

Sign the timestamp string exactly as received. The cross-implementation vector every side pins: `HMAC("key", 1700000000, b"hello")` → `v1=4d583a269f4f276a3fa80ff31b5a01879a848096983222a17893d198418939aa`.

Replay protection is the timestamp window; within it a replayed request is a no-op because the ERPs deduplicate (Odoo on the message's own `Message-ID`, Frappe on the relay id). The `v1=` prefix exists so a `v2=` that also signs the relay id can be introduced without a flag day.

The ERP answers with JSON — `{"ok": true, "remote_ref": "<record id or name>" | null, "id": "<relay id>"}` on success, `{"ok": false, "error": "<one line>"}` otherwise. Frappe's `{"message": …}` wrapper and `{"exception": …}` error shape are understood, as are the pre-contract `thread_id` (Odoo) and `communication` (Frappe) fields.

| ERP responds                                           | Row becomes                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------- |
| 2xx                                                    | delivered — remoteRef recorded when present                   |
| 408, 429, 5xx, timeout, network error                  | pending — retried on the schedule; dead once attempts run out |
| any other 4xx, or a 3xx (redirects are never followed) | rejected — parked for an operator                             |

The ERP-side URLs the fleet expects: Odoo `https://<odoo>/mail_cloudflare/inbound/<key>`; Frappe `https://<site>/api/method/cloudflare_email_delivery.api.inbound?key=<key>`. Both embed a per-server key generated by the ERP, so the URL itself is a secret.

## Tenant model

A tenant is one ERP instance. Its public half is a row in the fleet's committed `tenants.json` (a slug, a platform, the domains routed to it and its retry and retention settings); its secret half is one Worker secret named `TENANT_<SLUG>` (`acme-eu` → `TENANT_ACME_EU`) holding the inbound URL, the HMAC secret and, optionally, a Cloudflare Access service token. A table that breaks a rule (a duplicate slug, a domain claimed twice, a wildcard that covers another tenant's domain) fails `createRelay()`. A missing or malformed secret parks only that tenant's rows as `pending`, with no attempt charged, and logs `tenant_config_error` once a minute until it is fixed; fixing it needs no redeploy. Every field, default and limit is in [Tenants and secrets](docs/reference/tenants.md).

## Ops API

`GET /health` is public. Everything else needs `Authorization: Bearer <OPS_TOKEN>` (≥ 32 characters; while it is unset or shorter, every ops route answers 404) and lets an operator list tenants with their queue counts, list and read a tenant's rows, download the stored `.eml`, requeue one row or every `dead` or `rejected` row, and delete a row. One token per Worker — tenants never receive it. The ops API lives on the Worker's `workers.dev` hostname; for an extra layer, put an Access policy in front of it. The routes, the row fields and the log events are in the [Ops API reference](docs/reference/ops-api.md).

## Deployment

A Worker is three files in the fleet — `index.ts` (the wrapper above), `tenants.json` and `wrangler.jsonc` (the name, the account, the `INBOX` R2 binding, the `INBOX_QUEUE` Durable Object binding and its `new_sqlite_classes` migration) — plus, once per Worker, an R2 bucket (with a lifecycle rule as a safety net for the purge) and the `OPS_TOKEN` secret, and, once per tenant, a `TENANT_<SLUG>` secret and the Email Routing rules that send its addresses to the Worker. Email Routing can only hand mail to a Worker in the **same Cloudflare account as the zone**, which is what decides between the shared relay and a dedicated Worker for a client that owns its account.

Requires the Workers Paid plan (Durable Objects). No `nodejs_compat`: the relay uses Web APIs only. The walk-through, with the Wrangler configuration and every command, is [Deploying the relay](docs/deploying-the-relay.md).

## Develop & test

```bash
npm ci
npm run check           # oxfmt + oxlint (incl. type-aware) + tsc, unit and integration configs
npm test                # unit (Node) + integration (workerd: R2, Durable Object, alarm, ops API)
cp .dev.vars.example .dev.vars   # then edit TENANT_DEV to point at a local ERP
npm run dev             # wrangler dev with dev/tenants.json
curl -X POST 'http://localhost:8787/cdn-cgi/local/email?from=alice@example.com&to=support@dev.test' \
     -H 'Content-Type: message/rfc822' --data-binary @test/fixtures/simple.eml
```

The integration suites run the relay against a fake Odoo and a fake Frappe with four fixture tenants (`alpha` odoo, `beta` frappe, `gamma` disabled, `delta` with a broken secret); see `test/integration/outbound.ts`.

## Publishing

Conventional Commits on `main` drive release-please; merging the release PR tags `v<version>` and publishes to GitHub Packages. `src/version.ts` carries the version the relay sends as its `User-Agent`.

## Part of the Cloudflare Email suite

Four open-source projects work together to give business systems email without SMTP credentials or IMAP polling:

| Project                                                                                 | Role                                                                                                                       |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| [cloudflare-email-relay](https://github.com/Avunu/cloudflare-email-relay)               | Multi-tenant inbound Worker: stores each message in R2, then delivers it to the right system with signed, retried requests |
| [cloudflare_email_delivery](https://github.com/Avunu/cloudflare_email_delivery)         | Frappe and ERPNext adapter                                                                                                 |
| [mail_cloudflare](https://github.com/Avunu/avunu-odoo-addons/tree/18.0/mail_cloudflare) | Odoo adapter                                                                                                               |
| [wordpress-cloudflare-email](https://github.com/Avunu/wordpress-cloudflare-email)       | WordPress plugin: outbound mail and a delivery log                                                                         |

Need it set up for your business? [Avunu](https://avunu.net) can help.
