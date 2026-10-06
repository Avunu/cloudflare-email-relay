---
title: Deploying the relay
description: Deploy the multi-tenant Cloudflare Email Routing relay Worker with R2, Durable Objects, tenants, secrets, routing rules, the ops API and an end-to-end test.
order: 2
tags: [deployment, workers, wrangler]
updated: 2026-10-06
---

This page walks you through deploying the relay: the Worker that receives mail from Cloudflare Email Routing and pushes it as a signed HTTPS request to the Odoo or Frappe instance that owns the recipient's domain. Use it when you are standing up a new relay, adding a tenant to an existing one, or checking that a deployment works. For the reasoning behind the design, see [How the suite works](how-it-works.md).

## How the relay behaves

Knowing the moving parts makes the steps easier to follow.

- **Intake.** Email Routing hands the Worker one message per recipient. The Worker looks up the recipient's domain in a tenant table, writes the raw message to R2, and only then queues it.
- **Queue.** Each tenant gets its own SQLite-backed Durable Object. Its alarm pushes queued messages to the ERP, oldest first, ten per pass, and retries failures on a schedule.
- **Ops API.** The Worker's `fetch()` handler exposes a small bearer-token API for inspecting and retrying messages.

Because the message is stored before it is pushed, an ERP outage, a wrong secret or a bad deploy delays mail but does not lose it. Outbound mail does not pass through this Worker: each ERP calls the Cloudflare Email Sending API directly.

## Prerequisites

You need:

- A Cloudflare account on the Workers Paid plan. Durable Objects require it.
- The zone for each mail domain in that same account. Email Routing can only hand mail to a Worker in the account that owns the zone.
- Node.js and Wrangler 4.
- An ERP instance per tenant with its mail-receiving side set up: the [Odoo module](adapters/odoo.md) or the [Frappe app](adapters/frappe-erpnext.md). Each shows the webhook URL and secret that go into a tenant secret.

> [!NOTE]
> The relay needs no `nodejs_compat` flag. It uses Web APIs only, so leave `compatibility_flags` out of your config.

## Layout of a deployment

The package, `@avunu/cloudflare-email-relay`, holds all of the relay logic. A deployment is a small repository of your own with three files per Worker:

```text
index.ts        the wrapper that builds the relay
tenants.json    the committed tenant table
wrangler.jsonc  Worker name, account, R2 bucket, Durable Object binding and migration
```

The package is published to GitHub Packages (`https://npm.pkg.github.com`). Install it in your deployment repository with `npm install @avunu/cloudflare-email-relay`, after pointing the `@avunu` npm scope at that registry. Registry authentication is outside this guide: see GitHub's documentation for its npm registry.

### The wrapper

Create `index.ts`:

```ts
import { createRelay } from "@avunu/cloudflare-email-relay";
import tenants from "./tenants.json";

const relay = createRelay({ tenants });

export default relay.handler; // email() + fetch()
export const { InboxQueue } = relay; // the Durable Object, bound to this table
```

`createRelay` validates the tenant table when the module loads, so a bad table fails the deploy instead of misrouting mail. The Durable Object class must be re-exported under the exact name `InboxQueue`, because the Wrangler config binds it by that name.

If several Workers share one R2 bucket, pass `keyPrefix` to `createRelay` so their objects do not collide. The default is `inbox/`, and objects are stored as `<keyPrefix><slug>/<id>.eml`.

### The Wrangler config

Create `wrangler.jsonc`:

```jsonc
{
	"name": "email-relay",
	"main": "index.ts",
	"account_id": "<ACCOUNT_ID>",
	"compatibility_date": "2026-08-22",
	"observability": { "enabled": true },
	"r2_buckets": [{ "binding": "INBOX", "bucket_name": "email-relay-inbox" }],
	"durable_objects": { "bindings": [{ "name": "INBOX_QUEUE", "class_name": "InboxQueue" }] },
	"migrations": [{ "tag": "v1", "new_sqlite_classes": ["InboxQueue"] }],
}
```

Three details matter:

- The bindings must be named `INBOX` (R2) and `INBOX_QUEUE` (Durable Object). The code reads them by those names.
- The migration uses `new_sqlite_classes`, not `new_classes`, because the queue stores its rows in Durable Object SQLite. Keep the `v1` tag as it is and never edit it.
- There are no `vars`. Every tunable lives in the tenant table, and everything sensitive is a Worker secret.

The repository's own [wrangler.jsonc](../wrangler.jsonc) is the same configuration for local development, with comments on each setting.

## Create the bucket and set the ops token

Run these once per Worker.

1. Create the R2 bucket that the `INBOX` binding points at:

   ```bash
   npx wrangler r2 bucket create email-relay-inbox
   ```

2. Add a lifecycle rule as a safety net behind the Worker's own purge:

   ```bash
   npx wrangler r2 bucket lifecycle add email-relay-inbox --prefix inbox/ --expire-days 180
   ```

3. Set the ops token. Generate a long random value first; the Worker ignores any token shorter than 32 characters:

   ```bash
   openssl rand -hex 32
   npx wrangler secret put OPS_TOKEN
   ```

> [!WARNING]
> The lifecycle rule deletes objects regardless of delivery state. If an object disappears before the queue delivers it, the row is marked `dead` with the error "stored message missing from R2". Keep the expiry well beyond both the retry window (about seven days on the defaults) and the longest `retentionDays` you give any tenant. The 180 days in the example is the repository's suggested value.

## Define a tenant

A tenant is one ERP instance. Its configuration is split in two: a public row in `tenants.json`, and a secret that holds the inbound URL and key. The fields, their limits and the rules for the whole table are in [Tenants and secrets](reference/tenants.md). The shortest valid row has a slug, a platform and the domains:

```json
[
	{
		"slug": "example-co",
		"platform": "odoo",
		"domains": ["example.com", "*.example.com"]
	}
]
```

The tenant's secret is a Worker secret named `TENANT_<SLUG>`: the slug in upper case with hyphens turned into underscores, so `example-co` becomes `TENANT_EXAMPLE_CO`. Its value is a JSON string:

```json
{
	"inboundUrl": "https://erp.example.com/mail_cloudflare/inbound/<KEY>",
	"secret": "<SHARED_SECRET>"
}
```

`inboundUrl` is the webhook URL your ERP shows you, key included, and `secret` is the HMAC key it shows beside it. Treat both as credentials. Set the secret with Wrangler and paste the JSON on one line when prompted:

```bash
npx wrangler secret put TENANT_EXAMPLE_CO
```

The Worker reads each tenant secret fresh on every delivery pass. If a secret is missing or malformed, that tenant's messages stay `pending` with no attempt charged, and the Worker logs `tenant_config_error` about once a minute. Intake and every other tenant keep working, and fixing the secret needs no redeploy.

## Deploy

From the deployment repository:

```bash
npx wrangler deploy
```

Changing `tenants.json` (adding a tenant, changing a domain or a tunable) needs a redeploy, because the table is bundled into the Worker. Changing a secret does not.

## Route mail to the Worker

In the Cloudflare dashboard, open the zone, then **Email Routing**, and send the addresses you want to receive (or the catch-all address) to the Worker with the **Send to a Worker** action, choosing your deployed Worker. Do this for every zone whose domains appear in the tenant table.

A recipient whose domain matches no tenant is still refused during the SMTP conversation with "Recipient domain is not served by this relay", so a routing rule for a domain missing from `tenants.json` gets mail refused instead of silently dropped.

## Check the ops API

The ops API lives on the Worker's `workers.dev` hostname. `GET /health` is public and answers `{"ok":true}`. Every other route needs the token:

```bash
curl -H "Authorization: Bearer <OPS_TOKEN>" https://email-relay.<ACCOUNT_SUBDOMAIN>.workers.dev/tenants
```

If `OPS_TOKEN` is unset or shorter than 32 characters, every route except `/health` answers 404. A missing or wrong token gets 401. Every route is listed in the [Ops API reference](reference/ops-api.md).

For another layer of protection, put a Cloudflare Access policy in front of the hostname, or set `workers_dev` to `false` and use a custom route behind Access. Neither needs a code change.

## Verify a test message end to end

Check the pieces in order, from the Worker outward.

1. Confirm the Worker is up:

   ```bash
   curl https://email-relay.<ACCOUNT_SUBDOMAIN>.workers.dev/health
   ```

   ```text
   {"ok":true}
   ```

2. Confirm the tenant is in the table and its counts are zero:

   ```bash
   curl -H "Authorization: Bearer <OPS_TOKEN>" https://email-relay.<ACCOUNT_SUBDOMAIN>.workers.dev/tenants/example-co
   ```

3. Send a message from an outside mailbox, such as `jane@example.org`, to an address on the tenant's domain that your Email Routing rule sends to the Worker.

4. Watch the logs. The Worker writes one JSON line per event (observability is on in the config above), which you can read in the dashboard or with `npx wrangler tail`. A healthy message produces `inbox_enqueued` and `email_stored` events and a `delivery_result` event with `"outcome":"delivered"`.

5. Check the queue:

   ```bash
   curl -H "Authorization: Bearer <OPS_TOKEN>" "https://email-relay.<ACCOUNT_SUBDOMAIN>.workers.dev/tenants/example-co/inbox?limit=5"
   ```

   The newest row should have status `delivered`. Then confirm in the ERP that the message arrived as a mail record.

6. Send one message to a domain that is not in the table. It should be refused during the SMTP conversation with the reason "Recipient domain is not served by this relay", which the sender's mail system normally reports back as a bounce. You will also see an `email_unrouted` log line. This proves unrouted mail is refused rather than lost.

### Reading the result

How the ERP's answer to each attempt changes the row:

| ERP response                                    | Row becomes                                                                   |
| ----------------------------------------------- | ----------------------------------------------------------------------------- |
| Any 2xx                                         | `delivered`                                                                   |
| 408, 429, any 5xx, a timeout or a network error | `pending`, retried on the backoff schedule, then `dead` when attempts run out |
| Any other 4xx, or any 3xx                       | `rejected`, parked for an operator                                            |

Redirects are never followed, because that would replay a signed message to an unvetted origin. A `rejected` row after a first test usually means the wrong secret (often a 401), a wrong or stale key in `inboundUrl` (often a 404), or an `inboundUrl` that redirects. Fix the cause, then requeue the rows:

```bash
curl -X POST -H "Authorization: Bearer <OPS_TOKEN>" "https://email-relay.<ACCOUNT_SUBDOMAIN>.workers.dev/tenants/example-co/inbox/retry?status=rejected"
```

## Add a tenant to a running relay

1. In the ERP, create the incoming mail server (Odoo) or enable incoming mail on the Email Account (Frappe) and copy its webhook URL and secret.
2. Add the tenant's row to `tenants.json` and redeploy.
3. Set the tenant's secret with `npx wrangler secret put TENANT_<SLUG>`.
4. In the zone's Email Routing, send the tenant's addresses (or the catch-all) to the Worker.
5. Send a test message and watch it reach `delivered`, as above.

## Test locally first

You can run the relay on your machine against a local ERP before touching Cloudflare. In a checkout of the [relay repository](https://github.com/Avunu/cloudflare-email-relay):

```bash
npm ci
cp .dev.vars.example .dev.vars
npm run dev
```

Edit `TENANT_DEV` in `.dev.vars` so `inboundUrl` and `secret` match your local ERP. Then post a sample message to the local Email Routing endpoint:

```bash
curl -X POST 'http://localhost:8787/cdn-cgi/local/email?from=jane@example.com&to=support@dev.test' \
  -H 'Content-Type: message/rfc822' --data-binary @test/fixtures/simple.eml
```

The development table in [dev/tenants.json](../dev/tenants.json) routes `dev.test` and `*.dev.test` to the `dev` tenant. Uncomment `OPS_TOKEN` in `.dev.vars` if you also want the ops API locally.

`npm test` runs the unit suite in Node and the integration suite in the Workers runtime, against a fake Odoo and a fake Frappe with four fixture tenants (see [test/integration/outbound.ts](../test/integration/outbound.ts)); `npm run check` runs the formatter, the linter and the type checks.

## Related

- [Tenants and secrets](reference/tenants.md): every field of the tenant table and of the secret.
- [Troubleshooting](troubleshooting.md): what to check when mail is delayed, rejected or missing.
- [Frappe and ERPNext](adapters/frappe-erpnext.md) and [Odoo](adapters/odoo.md): where the webhook URL and secret come from.
