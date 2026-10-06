---
title: Tenants and secrets
description: The tenant table and the per-tenant Worker secret of the Cloudflare Email relay, with every field, default, limit and routing rule.
order: 1
tags: [tenants, configuration, reference]
updated: 2026-10-06
---

A **tenant** is one ERP instance: an Odoo database or a Frappe site. Each tenant has two halves that live in different places on purpose.

| Half   | Holds                                                                                      | Lives in                                                       |
| ------ | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Public | Slug, platform, the domains routed to the tenant, and its retry and retention settings     | A row of `tenants.json`, committed and bundled into the Worker |
| Secret | The inbound URL (which embeds the ERP's key), the HMAC secret and an optional Access token | One Worker secret named `TENANT_<SLUG>`                        |

Keeping them apart means a reviewer can read the committed table without seeing a capability, and rotating one tenant's secret never touches another tenant or needs a redeploy. The domain of the envelope recipient is the routing key.

## The tenant table

`tenants.json` is an array with one object per tenant. This row shows every field with its default:

```jsonc
{
	"slug": "example-co", // never change it once mail has flowed
	"platform": "odoo", // "odoo" or "frappe"
	"domains": ["example.com", "*.example.com"],
	"enabled": true, // false rejects the tenant's mail at intake
	"note": "Example Co, ticket 123", // free text, never read
	"retentionDays": 30,
	"maxAttempts": 32,
	"backoffSeconds": [60, 300, 900, 3600, 21600], // the last value repeats
	"deliveryTimeoutSeconds": 30,
	"deliveryDelaySeconds": 0,
}
```

Only `slug`, `platform` and `domains` are required. The comments are for this page: `tenants.json` itself is plain JSON.

| Field                    | Meaning                                                                                                                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slug`                   | Lowercase letters, digits and hyphens, 1 to 63 characters, starting with a letter or digit. It names the queue, the R2 prefix and the secret, so it is immutable once mail has flowed. |
| `platform`               | `odoo` or `frappe`. It is recorded for operators and shown by the ops API; the delivery contract is identical for both.                                                                |
| `domains`                | At least one recipient domain routed to this tenant. See "Domains" below.                                                                                                              |
| `enabled`                | Default `true`. When `false`, mail for the tenant's domains is rejected at intake with "Recipient domain is disabled on this relay". The tenant's queue stays reachable.               |
| `note`                   | Free text up to 200 characters, for operators (a ticket number, say). The code never reads it.                                                                                         |
| `retentionDays`          | Default 30, from 0 to 3650. Days a delivered message stays in R2 before it and its row are purged. `0` purges it as soon as the ERP accepts it.                                        |
| `maxAttempts`            | Default 32, from 1 to 10,000. Attempts before a message is marked `dead`. 32 is about seven days on the default schedule.                                                              |
| `backoffSeconds`         | Default `[60, 300, 900, 3600, 21600]`: a list of one or more delays in seconds, applied by attempt number. The last value repeats for every later attempt.                             |
| `deliveryTimeoutSeconds` | Default 30, from 1 to 60. The timeout of one delivery attempt; a timeout counts as a transient failure and is retried.                                                                 |
| `deliveryDelaySeconds`   | Default 0, up to seven days. A wait before the first attempt. Leave it at 0 in production: the integration tests raise it so that alarms fire on demand.                               |

### Domains

A domain is a lowercase hostname with at least one dot. Internationalized names are written in their punycode (A-label) form. There are two kinds:

- **Exact**, such as `example.com`, matches mail for that domain only.
- **Wildcard**, such as `*.example.com`, matches every subdomain and **never the bare domain**. List `example.com` separately when you want both.

The relay lowercases the envelope recipient's domain, drops a trailing dot and converts internationalized names before it looks the domain up. It tries an exact match first, then the most specific wildcard (`*.mail.example.com` wins over `*.example.com`). A recipient that matches nothing is rejected at SMTP time with "Recipient domain is not served by this relay".

### Rules for the whole table

A table that breaks a rule makes `createRelay()` throw, so the deploy fails instead of the relay misrouting mail:

- Every slug is unique.
- Every domain is claimed by one tenant.
- A wildcard may not cover another tenant's domain, whether that domain is exact or a wildcard of its own.

The error names the row and the problem, for example `duplicate slug "example-co" (also row 0)` or `wildcard "*.example.com" covers "mail.example.com" claimed by row 1`.

### Validating a table in CI

The schemas are also published on their own at `@avunu/cloudflare-email-relay/tenants`, which runs in plain Node, so a deployment repository's CI can check its table with the Worker's own rules without a Workers runtime:

```js
import { readFileSync } from "node:fs";
import { parseTenantTable } from "@avunu/cloudflare-email-relay/tenants";

parseTenantTable(JSON.parse(readFileSync("tenants.json", "utf8")));
```

`parseTenantTable` throws a `TenantTableError` listing every problem. The same entry point exports `parseTenantSecret`, `secretNameFor` and the schemas.

## The tenant secret

Each tenant has one Worker secret named `TENANT_<SLUG>`: the slug in upper case with hyphens turned into underscores. The slug `example-co` becomes `TENANT_EXAMPLE_CO`, and `acme-eu` would become `TENANT_ACME_EU`. Because slugs never contain underscores, two slugs never share a secret name.

The value is a JSON string:

```json
{
	"inboundUrl": "https://erp.example.com/mail_cloudflare/inbound/<KEY>",
	"secret": "<SHARED_SECRET>",
	"accessClientId": "<ACCESS_CLIENT_ID>",
	"accessClientSecret": "<ACCESS_CLIENT_SECRET>"
}
```

| Field                | Required | Meaning                                                                                                                                                  |
| -------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inboundUrl`         | yes      | The ERP's inbound webhook URL, key included. It must be an `http` or `https` URL; use `https` outside local development. It is never logged.             |
| `secret`             | yes      | The HMAC-SHA256 key behind `X-Email-Relay-Signature`, at least 16 characters.                                                                            |
| `accessClientId`     | no       | A Cloudflare Access service token's client ID, sent as `CF-Access-Client-Id`.                                                                            |
| `accessClientSecret` | no       | The matching client secret, sent as `CF-Access-Client-Secret`. Set both Access fields or neither: half a token would make every delivery fail at Access. |

The URL and the secret come from the ERP: the [Odoo](../adapters/odoo.md) incoming mail server and the [Frappe](../adapters/frappe-erpnext.md) Email Account each generate a key and a secret and show them in the form. Add the Access fields only when the inbound route sits behind a Cloudflare Access policy.

Set a tenant's secret with Wrangler and paste the JSON on one line:

```bash
npx wrangler secret put TENANT_EXAMPLE_CO
```

### How the relay treats a bad secret

The relay reads the secret on every delivery pass and caches nothing about a failure. If the secret is missing, blank or malformed:

- The tenant's rows stay `pending` and are **not** charged an attempt.
- The relay logs `tenant_config_error` about once a minute, naming the secret and the bad fields but never their values.
- Intake and every other tenant carry on.
- Fixing the secret with `wrangler secret put` takes effect on the next pass. No redeploy is needed.

### Rotating a secret

The ERPs rotate the secret without changing the URL: _Regenerate Secret_ in Odoo and _Regenerate Webhook Secret_ in Frappe. Until the relay has the new value, deliveries are signed with the old one and the ERP answers 401, which parks the rows as `rejected`. Update `TENANT_<SLUG>`, then requeue the parked rows in bulk with `POST /tenants/<SLUG>/inbox/retry?status=rejected` (see the [Ops API reference](ops-api.md)).

> [!WARNING]
> The secret and the webhook URL are credentials. Keep them out of the repository, tickets and chat. The committed table never holds a capability, which is why the secret half exists.

## Related

- [Deploying the relay](../deploying-the-relay.md): where the table and the secrets fit in a deployment.
- [Inbound contract](inbound-contract.md): what the relay sends to `inboundUrl` and how it signs it.
