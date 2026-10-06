---
title: Troubleshooting
description: Symptom-first checks for Cloudflare Email that is not sent, not received, delayed, rejected by signature or blocked by limits, on Odoo, Frappe and WordPress.
order: 3
tags: [troubleshooting, dmarc, logs]
updated: 2026-10-06
---

Use this page when mail that should flow through Cloudflare does not: a message is not sent, a message never shows up in the ERP, mail arrives late, or a delivery is refused. It starts from the symptom and points at the exact setting or log line to check. Each check maps to a message or setting that exists in the Avunu code; where something has not been verified, the text says so. For the design, see [How the suite works](how-it-works.md).

## How the pieces fit

Outbound and inbound mail take different paths, so first decide which one is broken.

- **Outbound** goes straight from the platform to the Cloudflare Email Sending API. The Odoo module, the Frappe app and the WordPress plugin each make that call themselves. The relay is not involved.
- **Inbound** goes from Cloudflare Email Routing to the relay Worker. The Worker stores the message in R2, queues it, and pushes it as a signed HTTPS request to the ERP. The ERP answers with a status code, and that code decides whether the relay retries.

## Start here

| Symptom                                              | Likely cause                                          | Go to                                                                               |
| ---------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Nothing leaves WordPress, no error                   | Plugin constants missing, so it does nothing          | [Nothing is sent](#nothing-is-sent)                                                 |
| Send fails with a token error or 401/403             | Wrong or inactive API token                           | [Token and credential errors](#token-and-credential-errors)                         |
| Cloudflare refuses the sender                        | The From domain is not onboarded for Email Sending    | [Sender domain refused](#sender-domain-refused)                                     |
| Send fails with a size, recipient or header message  | A Cloudflare limit                                    | [Limits](#limits)                                                                   |
| The sender gets an immediate bounce when mailing you | The relay rejected the recipient                      | [The sender is bounced at once](#the-sender-is-bounced-at-once)                     |
| Mail reached Cloudflare but is not in the ERP        | Queued, retrying or parked on the relay               | [Mail is on the relay but not in the ERP](#mail-is-on-the-relay-but-not-in-the-erp) |
| Rows stay `pending` for hours                        | The retry schedule, or a broken tenant secret         | [Mail is delayed](#mail-is-delayed)                                                 |
| Rows are `rejected`                                  | The ERP refused them with 401, 404, 422 or a redirect | [The ERP refuses the delivery](#the-erp-refuses-the-delivery)                       |
| Replies start new threads                            | The `References` header was lost                      | [Replies do not thread](#replies-do-not-thread)                                     |

## Outbound problems

### Nothing is sent

Check the platform first.

- **WordPress.** If `CLOUDFLARE_EMAIL_ACCOUNT_ID` and `CLOUDFLARE_EMAIL_API_TOKEN` are not both defined in `wp-config.php`, the plugin does not intercept mail and WordPress uses its normal transport. In production, wp-admin shows a "not configured" notice. Outside production (`WP_ENVIRONMENT_TYPE` other than `production`) it stays silent on purpose.
- **Frappe.** The send hook only uses Cloudflare when the Email Account's Email Domain has **Send via Cloudflare** ticked. Accounts on any other domain fall back to Frappe Mail or SMTP. If you expected Cloudflare, open the Email Domain and confirm the box and the account link.
- **Odoo.** The outgoing mail server must have **Authenticate with** set to _Cloudflare Email Sending_. Odoo picks the server by its **FROM Filtering**, so a message whose sender does not match is not sent through it.

If a send is attempted and fails, look at the platform's record of the failure:

| Platform  | Where the failure is recorded                                                                                        |
| --------- | -------------------------------------------------------------------------------------------------------------------- |
| Odoo      | The `mail.mail` record goes to the _Exception_ state, with a failure reason that starts with `CloudflareEmailError:` |
| Frappe    | The Email Queue entry records the error                                                                              |
| WordPress | **Tools > Cloudflare Email** shows the entry with status `failed` and the error text                                 |

WordPress has no silent fallback. When Cloudflare rejects a message, the entry is logged as failed and `wp_mail()` returns `false`.

### Token and credential errors

The platforms surface the same Cloudflare answers in their own words.

| Message                                                      | Meaning                                                                                              |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `Cloudflare rejected the API token: HTTP 401 (...)`          | Cloudflare answered 401 or 403 to the token check. The token is wrong, revoked or lacks permission.  |
| `The API token is not active (status: ...)`                  | The token exists but its status is not `active`.                                                     |
| `Cloudflare refused the message: HTTP 401 (...)`             | The same credential failure, raised by a send instead of the token check.                            |
| `Token verification failed: HTTP ...`                        | The verify call returned something other than success.                                               |
| `Could not reach Cloudflare: ...`                            | A network error before any answer.                                                                   |
| `Not retried: an earlier send in this batch failed with ...` | A 401 or 403 already failed this batch, so the remaining sends fail fast without calling Cloudflare. |

To test the token:

- **Odoo:** open the outgoing mail server and click _Test Connection_. A failure reads `Connection Test Failed for <server>!` followed by the error.
- **Frappe:** save the Email Domain. A bad token fails with `Cloudflare API token validation failed`. A missing account ID or token fails with `Cloudflare Account ID and API Token are required when Send via Cloudflare is enabled.`
- **WordPress:** run `wp cloudflare-email verify`, then send a test message.

```bash
wp cloudflare-email verify
wp cloudflare-email send-test jane@example.com
```

The token needs the **Email Sending: Edit** permission on the account whose ID you configured. A token for a different account than the one you configured fails the same way.

On Odoo, saving the server also validates its fields. The messages `The Cloudflare Account ID is required for the outgoing mail server`, `The Cloudflare API Token is required for the outgoing mail server` and `needs a FROM Filtering set to a domain onboarded for Cloudflare Email Sending` each point at the one field to fix.

### Sender domain refused

Cloudflare only sends from domains that are onboarded for Email Sending on the account. If the From domain is not onboarded, Cloudflare refuses the message, and the platform shows Cloudflare's own error text in the form `HTTP <status> (<code>: <message>)`. Cloudflare's error codes are not catalogued here, so read the text it returns.

Check these:

1. In Cloudflare, confirm the sending domain is onboarded for Email Sending. For Odoo this is _Compute > Email Service > Email Sending > Onboard Domain_. Onboarding is also what adds the bounce MX and the SPF, DKIM and DMARC records, so look at the zone's DNS if deliverability looks wrong.
2. **Odoo:** set **FROM Filtering** to the onboarded domain. It is required, and it is what makes Odoo rewrite a foreign `From` to the notifications address. A mail forced onto the Cloudflare server whose `From` is outside the onboarded domain is sent as is and refused.
3. **Odoo:** make sure the company's alias domain (_Settings > General > Discuss > Alias Domain_) is the domain you routed, so `catchall@`, `bounce@` and `notifications@` exist on it.
4. **WordPress:** set `CLOUDFLARE_EMAIL_FROM` to an address on the onboarded domain. Without it, WordPress defaults to `wordpress@<site-domain>`, which is usually not onboarded.
5. **Frappe:** the Email Account's address must be on a domain onboarded for sending.

### Limits

These limits are enforced before or by the Cloudflare API. The messages below are the ones the code produces.

| Limit                                                    | Message you see                                                                                                                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 50 recipients across To, Cc and Bcc                      | `<N> recipients; Cloudflare accepts at most 50 (To, Cc and Bcc combined) per message.` WordPress says `Cloudflare allows at most 50 combined To/Cc/Bcc recipients per message.` |
| 5 MiB for the whole message                              | `Message is <X> MiB once encoded; Cloudflare accepts at most 5 MiB.`                                                                                                            |
| 20 custom headers, 2,048 bytes per value, 16 KB in total | `Headers exceed Cloudflare's limits ...` or `<N> custom headers; Cloudflare accepts at most 20.`                                                                                |
| At least one body                                        | `The message has neither a text nor an html body; Cloudflare requires at least one.`                                                                                            |
| A usable sender                                          | `The message has no valid From address.`                                                                                                                                        |
| At least one recipient                                   | `No recipient left after envelope validation.` WordPress says `No recipients specified.`                                                                                        |

Attachments are base64 encoded, so the encoded message is about a third larger than the files on disk. A 4 MiB attachment can already exceed the limit.

On Odoo, **Maximum Email Size** is set to 5 MB automatically for Cloudflare servers. Above it, attachments that belong to the business record are sent as download links. Attachments added in the composer are always embedded, so a large one still fails with the size message before any request is made. The WordPress plugin does not pre-check size, so an oversized message comes back as Cloudflare's own error.

Cloudflare allows only a closed list of headers plus anything starting with `X-`. The Odoo and Frappe code drops headers outside the list. The WordPress plugin sends custom headers as given, so a header Cloudflare disallows fails the whole send and is logged as failed. Remove it with the `cloudflare_email_payload` filter:

```php
add_filter('cloudflare_email_payload', function (array $payload) {
    unset($payload['headers']['X-Some-Header']);
    return $payload;
});
```

### Retries, bounces and suppression

The Odoo and Frappe clients try a send up to 3 times. They retry network errors and 5xx answers after 1 second, then 2 seconds, and 429 answers after the `Retry-After` value, capped at 10 seconds. Any other 4xx is not retried. When attempts run out you see `Giving up after 3 attempts: ...`.

If Cloudflare reports synchronous bounces or suppressed recipients and nobody could be reached, the send fails with `No recipient could be reached (permanently bounced: [...]; suppressed: [...])`. If only some recipients failed, the send counts as a success and the client logs a warning.

> [!NOTE]
> Asynchronous bounces never reach Odoo or Frappe. The return path belongs to Cloudflare, and bounces go to its own bounce subdomain. A message can be accepted and still not arrive, with no error in the ERP.

## Inbound problems

### The sender is bounced at once

The relay refuses a message during the SMTP conversation with one of three fixed replies. The sender sees the text, and the relay logs a matching event in Workers Logs (the example `wrangler.jsonc` has observability on). Filter on the `event` field.

| Reply to the sender                            | Log event               | Cause                                                                                     |
| ---------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------- |
| `Recipient domain is not served by this relay` | `email_unrouted`        | The recipient domain is in no tenant's `domains` list.                                    |
| `Recipient domain is disabled on this relay`   | `email_tenant_disabled` | The tenant has `"enabled": false`.                                                        |
| `Invalid envelope address`                     | `email_rejected`        | The envelope sender or recipient has control characters or is too long for a header line. |

For an unrouted domain, check the tenant row in your `tenants.json` (the format is in [Tenants and secrets](reference/tenants.md)):

- Domains are matched on the envelope recipient, lowercase, with internationalized names written in punycode.
- A wildcard such as `*.example.com` matches subdomains only, never `example.com` itself. List the bare domain separately.
- The table is bundled into the Worker at deploy time. Editing `tenants.json` does nothing until you redeploy.

A malformed table is a different failure: the Worker validates the table when it starts and refuses to run on one, and the error names the row. The common mistakes are a duplicate slug, a domain claimed twice, and a wildcard that covers another tenant's domain.

If the sender is not bounced and the relay logs nothing for the address, the message never reached the Worker. In Cloudflare Email Routing, confirm the address or catch-all routes to the Worker with _Send to a Worker_, and that the Worker is in the same Cloudflare account as the zone. Email Routing cannot hand mail to a Worker in another account.

### Mail is on the relay but not in the ERP

A message that passes intake is stored in R2 first and queued second. A healthy message logs `inbox_enqueued` and `email_stored`, then `delivery_result`. If you see `email_store_failed`, the relay could not write the message. It rethrows the error, so Cloudflare answers the sending server with a temporary failure and the sender retries.

To see where a message stands, use the [ops API](reference/ops-api.md). Every route except `/health` needs the ops token as a bearer token. Replace the placeholders with your relay host and token.

```bash
curl -H "Authorization: Bearer <OPS_TOKEN>" https://<RELAY_HOST>/tenants
curl -H "Authorization: Bearer <OPS_TOKEN>" "https://<RELAY_HOST>/tenants/<SLUG>/inbox?status=pending&limit=20"
```

The first call lists each tenant with counts of `pending`, `delivered`, `rejected` and `dead` rows. The second lists rows with `attempts`, `nextAttemptAt`, `lastStatus` and `lastError`. Use `/tenants/<SLUG>/inbox/<ID>` for one row and `/tenants/<SLUG>/inbox/<ID>/raw` to download the stored `.eml`.

If every ops route answers 404, `OPS_TOKEN` is unset or shorter than 32 characters, and a too-short token logs `ops_token_too_short`. A 401 means the token is wrong. A 404 on `/tenants/<SLUG>` means the slug is not in the table.

### Mail is delayed

Delivery is attempted from a per-tenant queue. A failed attempt is rescheduled along the tenant's `backoffSeconds` list, which defaults to 60, 300, 900, 3600 and 21600 seconds. The last value repeats. With the default `maxAttempts` of 32, a message is retried for about a week before it is marked `dead`.

The relay retries when the ERP answers 408, 429 or any 5xx, when the request times out (30 seconds by default, 60 at most), or when the network fails. Each attempt writes a `delivery_result` event with `outcome`, `status`, `attempts` and `nextAttemptAt`, and the same detail is on the row as `lastError`.

If rows sit in `pending` and `attempts` is not climbing, look for a tenant secret problem. The relay reads the `TENANT_<SLUG>` secret on every pass. If it is missing or malformed, it parks that tenant's rows without charging an attempt and logs `tenant_config_error` once a minute:

```text
Invalid configuration for tenant "<SLUG>": TENANT_<SLUG> is not set
```

The error names the bad field but never the value. The secret is a JSON object with `inboundUrl` and `secret` (at least 16 characters), plus optional `accessClientId` and `accessClientSecret`, which must be set together. Fix the secret with `wrangler secret put` and the next pass picks it up. You do not need to redeploy.

Other events to know: `delivery_error` for an attempt that threw, `alarm_failed` for a failed pass (the alarm is re-armed a minute later), and `inbox_foreign_tenant` for a queue addressed to the wrong tenant. The full list is in the [Ops API reference](reference/ops-api.md#log-events).

A row becomes `dead` when attempts run out, or immediately with `stored message missing from R2` if the object was deleted. Once you fix the cause, requeue it:

```bash
curl -X POST -H "Authorization: Bearer <OPS_TOKEN>" https://<RELAY_HOST>/tenants/<SLUG>/inbox/<ID>/retry
curl -X POST -H "Authorization: Bearer <OPS_TOKEN>" "https://<RELAY_HOST>/tenants/<SLUG>/inbox/retry?status=dead"
```

A retry restores the full attempt budget. Retrying a row that is already `pending` returns 409, which is expected.

### The ERP refuses the delivery

The ERP's status code decides what the relay does. Anything the relay will not retry is parked as `rejected` until you fix the cause and requeue it. A redirect is never followed: a 3xx means the `inboundUrl` is wrong, and it is parked too.

| Status | Odoo cause                                                                                                | Frappe cause                                                                                          |
| ------ | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 401    | Bad or missing signature, or a stale timestamp                                                            | The same                                                                                              |
| 404    | No server for that key, or it is not confirmed, is archived, or is not the _Cloudflare Email Worker_ type | No Email Account with that key and **Enable Incoming**, or its domain is not a Cloudflare domain      |
| 422    | No alias matched and no fallback model, or control characters in an envelope header                       | The recipient domain is not the account's, a bad envelope, or the target document refused the message |
| 500    | Anything else, retried                                                                                    | Anything else, retried                                                                                |

Rejected rows come back with the ERP's one-line reason in `lastError`. Both ERPs log the failure on their side, and neither says which signature check failed.

#### 401: the signature is rejected

The ERP log line is `signature verification failed on <name>`. Four things cause it:

1. **The secrets differ.** The relay's tenant `secret` must equal the ERP's webhook secret. This happens most often after _Regenerate Secret_ (Odoo) or _Regenerate Webhook Secret_ (Frappe), which rotate the secret but keep the URL. Rows delivered in between are parked as `rejected`. Update the relay's `TENANT_<SLUG>` secret, then bulk-retry the `rejected` rows.
2. **The clock is off.** The ERP rejects a timestamp more than 300 seconds from its own clock. The relay signs a fresh timestamp on every attempt, so a stale timestamp usually means the ERP server's clock is wrong.
3. **A proxy changed the body.** The signature covers the exact body bytes. Anything between the relay and the ERP that rewrites or re-encodes the body breaks it.
4. **The wrong secret was pasted.** The signature is `v1=` followed by the hex HMAC-SHA256 of `<timestamp>.` plus the body, keyed with the secret.

To check a secret without the relay, compute the signature for the shared test vector. If your ERP's secret handling produces a different value, the problem is in how the secret is stored or read.

```python
import hashlib, hmac

secret, timestamp, body = "key", "1700000000", b"hello"
digest = hmac.new(secret.encode(), f"{timestamp}.".encode() + body, hashlib.sha256).hexdigest()
print(f"v1={digest}")
```

```text
v1=4d583a269f4f276a3fa80ff31b5a01879a848096983222a17893d198418939aa
```

#### 404: unknown key

The ERP log line is `no confirmed server for key <first 8 characters>...` on Odoo and `no enabled account for key <first 8 characters>...` on Frappe. The key is part of the URL, so compare the tenant's `inboundUrl` with the ERP's webhook URL.

- **Odoo:** the incoming mail server must be confirmed with _Test & Confirm_ and not archived. The webhook URL comes from `web.base.url`, which must be `https://` (plain `http://` is accepted only on `localhost`). Test & Confirm fails with a message naming `web.base.url` otherwise. On a multi-database host, the route needs `dbfilter` or `db_name` to find the database, because a `?db=` redirect would lose the POST body.
- **Frappe:** tick **Enable Incoming** on the Email Account and keep its Email Domain on **Send via Cloudflare**. The URL is built from `host_name` in the site config, and saving fails with `The webhook URL (...) must be https` unless the site is in developer mode or the host is loopback.

#### 422: no route or wrong domain

- **Odoo:** the message matched no alias and the server has no fallback model. Check the alias domain, or set a _Create a New Record_ model on the incoming server. The reply body carries the reason Odoo built.
- **Frappe:** `recipient domain does not belong to this account` means the routed recipient is on neither the Email Domain's name nor the Email Account address's domain. This is the guard against a shared relay misrouting mail. `Invalid envelope-from address: control characters` points at a bad envelope header.

#### 500: the ERP failed

The relay retries these, so check the ERP's own error record.

- **Frappe:** open Error Log and look for the title `Cloudflare relay inbound`. The failed message is also stored as an Unhandled Email, so nothing is lost.
- **Odoo:** the server log has `Cloudflare inbound <relay id> failed on <server>` with a traceback.

### Delivered, but nothing appears

A `delivered` row with an empty `remoteRef` is not an error. The ERP answered 200 and chose to ignore the message: a duplicate (the same `Message-ID` on Odoo, the same relay ID on Frappe), a bounce, or Frappe's own outgoing mail looping back. Open the row with the ops API to see `remoteRef`, then search the ERP for the message's `Message-ID`.

### Attachments and message size

The relay stores the whole message in R2 and does not decode it, and its code contains no size limit. Limits appear at the ERP:

- **Frappe:** the app's documentation says a message larger than the site's `max_file_size` (25 MiB by default) is refused by the web server before it reaches the app. This has not been verified on a live site.
- **Both:** a reverse proxy that refuses the body with a 4xx answer is read by the relay as a rejection, and the row is parked. Check the proxy's body limit if only large messages fail.
- **Odoo:** if the incoming server's attachment option is off, attachments are stripped from the stored record.

### Replies do not thread

Cloudflare replaces the outgoing `Message-ID`, so the platform adds its own ID to the `References` header, and replying clients copy `References` into the reply. Threading breaks when a reply loses that header, for example when a client or an intermediate service rewrites it. No setting in the adapters fixes this. The outbound code trims the oldest `References` entries first if the header grows past 2,048 bytes, and never drops the platform's own ID.

## Where to look, by platform

Platform setup is covered in the [Odoo](adapters/odoo.md), [Frappe and ERPNext](adapters/frappe-erpnext.md) and [WordPress](adapters/wordpress.md) guides.

| Task                        | Odoo                                                     | Frappe                                                                 | WordPress                                             |
| --------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------- |
| Outbound failures           | `mail.mail` in the _Exception_ state                     | The Email Queue error                                                  | The **Tools > Cloudflare Email** log, status `failed` |
| Test the token              | _Test Connection_ on the outgoing server                 | Save the Email Domain                                                  | `wp cloudflare-email verify`                          |
| Inbound webhook credentials | The incoming server's _Webhook URL_ and _Webhook Secret_ | The Email Account's **Cloudflare Email Receiving** section             | Not applicable, outbound only                         |
| Rotate the signing secret   | _Regenerate Secret_                                      | _Regenerate Webhook Secret_ (System Manager)                           | Not applicable                                        |
| Inbound failures            | The Odoo server log                                      | Error Log, Unhandled Email, and the `cloudflare_email_delivery` logger | Not applicable                                        |

On WordPress you can also resend a message from its log entry. The log keeps entries for 30 days by default (`CLOUDFLARE_EMAIL_LOG_RETENTION_DAYS`, where 0 keeps them forever), and a daily WP-Cron job prunes older ones. Set `CLOUDFLARE_EMAIL_LOG` to `false` to stop logging successful sends. Failures are always logged.

## Checklist when you are stuck

1. Decide whether the problem is outbound or inbound.
2. Outbound: read the failure on the platform, then run the token test.
3. Inbound: check Workers Logs for `email_unrouted`, `email_tenant_disabled` or `email_rejected`.
4. Ask the ops API where the row stands: `pending`, `rejected` or `dead`.
5. Match `lastStatus` and `lastError` to the tables above, fix the cause, then requeue.
