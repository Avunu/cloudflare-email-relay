---
title: How the suite works
description: How Cloudflare Email sends and receives ERP and website mail through Cloudflare's API and a store-first relay, with no SMTP or IMAP credentials and no lost inbound mail.
order: 1
tags: [architecture, design]
updated: 2026-10-06
---

This page explains how the suite moves mail in and out of Odoo, Frappe, ERPNext and WordPress without a single SMTP or IMAP mailbox in the loop. Read it before you deploy, or when you need to know why a message was delayed rather than lost.

## The problem with mailbox-style email

Most business systems still talk to email the way a desktop mail client does: log in to a mailbox over SMTP to send, log in over IMAP on a timer to receive. That model has four recurring problems:

- **Shared credentials.** The ERP holds a mailbox username and password, often shared by several people or systems. Rotating it means touching every place it was pasted.
- **Polling.** Inbound mail waits for the next fetch cycle, and every system needs its own mailbox and fetch job.
- **Fragile delivery.** If the ERP is down, a fetch fails or a mailbox misbehaves, you find out later and usually by accident.
- **Deliverability.** Sending through a general-purpose mailbox provider makes SPF, DKIM and DMARC somebody else's configuration, and the sender identity does not always match your domain.

The suite replaces both directions with APIs and signed web requests.

## The design at a glance

Outbound and inbound take different paths, and only the inbound path needs the relay.

- **Outbound:** each system calls the [Cloudflare Email Sending](https://developers.cloudflare.com/email-service/) REST API directly, with an API token. The relay is not involved.
- **Inbound:** Cloudflare Email Routing hands each message to the relay, a multi-tenant Worker. The relay stores the message in R2 first, then pushes it to the right ERP as an HMAC-signed HTTPS request. A Durable Object per tenant keeps retrying until the ERP accepts the message.

```text
OUTBOUND

  Odoo / Frappe / WordPress
        |
        |  HTTPS POST  /accounts/<ACCOUNT_ID>/email/sending/send
        |  (Bearer API token)
        v
  Cloudflare Email Sending  --->  recipient's mail server


INBOUND

  sender's mail server
        |
        v
  Cloudflare Email Routing  (address or catch-all -> "Send to a Worker")
        |
        v
  Relay Worker: email()
     1. look up the recipient's domain in the tenant table
     2. write the raw message to R2  (inbox/<tenant>/<id>.eml)
     3. add a row to that tenant's queue
        |
        v
  Durable Object "InboxQueue"  (one per tenant, SQLite + alarm)
        |
        |  HTTPS POST, message/rfc822 body, signed:
        |  X-Email-Relay-Signature: v1=<HMAC-SHA256 hex>
        v
  Odoo or Frappe site  (the tenant)
        |
        +-- 2xx                      -> delivered (purged after retention)
        +-- 408, 429, 5xx, timeout   -> pending, retried on a schedule
        +-- any other 4xx, or a 3xx  -> rejected, parked for an operator
```

## Outbound: the Email Sending API

Every integration sends with a `POST` to `/accounts/<ACCOUNT_ID>/email/sending/send` on `api.cloudflare.com`, authenticated with an API token that has the **Email Sending: Edit** permission. What each platform does with it:

- **Odoo 18** ([Odoo guide](adapters/odoo.md)): an outgoing mail server with the authentication type _Cloudflare Email Sending_ holds the account ID and token instead of a host and password. Odoo's own `mail.mail` queue, failure handling and `From` rewriting are unchanged; only the connection step is replaced.
- **Frappe 16 and ERPNext** ([Frappe guide](adapters/frappe-erpnext.md)): an Email Domain with **Send via Cloudflare** ticked holds the account ID and token. Each Email Queue entry sent from an account on that domain becomes one API call per recipient. Accounts on other domains keep using SMTP or Frappe Mail.
- **WordPress** ([WordPress guide](adapters/wordpress.md)): the plugin hooks `wp_mail()` and sends through the same API, with credentials set as constants in `wp-config.php`. It keeps a searchable log of every send and has no inbound half.

Because Cloudflare owns the sending infrastructure, the domain's SPF, DKIM and DMARC records are managed where you onboard the domain, not inside each application.

### Limits to plan around

The shared API client in the Odoo and Frappe adapters enforces Cloudflare's limits before it makes the request:

- 5 MiB for the whole encoded message.
- 50 recipients per message, To, Cc and Bcc combined.
- 20 custom headers, 2,048 bytes per header value and 16 KB of custom headers in total. Headers outside Cloudflare's allow-list (the threading headers, the `List-*` headers, `Precedence`, `Auto-Submitted` and anything starting with `X-` are allowed) are dropped.

Network errors and 5xx answers are retried briefly (up to three attempts in total), a 429 waits for `Retry-After` (capped at 10 seconds), and a 401 or 403 fails the rest of the batch at once. Recipients Cloudflare rejects or suppresses synchronously come back to the application as a failure with a reason.

> [!NOTE]
> Cloudflare assigns its own `Message-ID` to outbound mail. Odoo and Frappe keep their original ID and add it to `References`, so replies still thread, because mainstream mail clients copy `References` into a reply. The adapters rely on that behavior.

## Inbound: Email Routing, then a store-first relay

Inbound mail needs somewhere to go that does not depend on the ERP being up at that exact second. That is the job of the relay, which [Deploying the relay](deploying-the-relay.md) walks through.

### Routing by recipient domain

The relay is multi-tenant. A **tenant** is one ERP instance: an Odoo database or a Frappe site. Each tenant owns one or more recipient domains, exact (`example.com`) or wildcard (`*.example.com`, which never matches the bare domain). The tenant table and its rules are in [Tenants and secrets](reference/tenants.md).

When Email Routing hands the Worker a message, the Worker routes on the domain of the envelope recipient. The table is validated when the Worker is built, so overlapping claims fail the deploy instead of misrouting mail at runtime.

A recipient whose domain belongs to no tenant, or to a disabled one, is **rejected at SMTP time** with a fixed reason. The relay never guesses a tenant and never drops mail silently: a shared relay must not deliver one client's mail to another, and a bounce tells the sender what a silent drop would hide.

### Store first

For an accepted message the Worker:

1. Streams the raw bytes into an R2 object at `inbox/<tenant>/<id>.eml`, with `Delivered-To` and `Return-Path` prepended from the SMTP envelope, the way a delivering mail server would write them. The message is never decoded, so attachments survive intact.
2. Only then adds a row to that tenant's queue.

If storing or queuing fails, the Worker raises the error. Cloudflare answers the sending server with a temporary failure and the sender tries again later. Once the handler returns normally, the message exists in R2 and is retried until the ERP takes it or an operator decides otherwise.

### One queue per tenant

Each tenant has its own Durable Object (`InboxQueue`) backed by SQLite. Its alarm delivers due messages oldest first, ten per pass, and a failed attempt moves the next attempt out along a backoff schedule.

Because the queue is per tenant, tenants stay independent:

- A tenant whose ERP is down backs up only its own queue.
- A tenant with a missing or malformed secret has its rows held as pending, with no attempt charged, and the relay logs `tenant_config_error` about once a minute until it is fixed. Other tenants carry on, and fixing the secret needs no redeploy.

### The signed push

Each attempt is an HTTPS `POST` of the stored message, content type `message/rfc822`, to the tenant's inbound URL, with redirects never followed. The request carries `X-Email-Relay-*` headers: the queue ID, the tenant slug, a fresh Unix timestamp, the attempt number and the SMTP envelope. The signature header is `X-Email-Relay-Signature`, with the value `v1=` followed by the hex HMAC-SHA256 of `<timestamp>.` plus the body, keyed with the tenant's secret.

The receiving side checks that the signature matches and that the timestamp is within 300 seconds of its own clock. Both adapters then deduplicate, so a retried or replayed push is harmless: Odoo ignores a message whose `Message-ID` it has already processed, and Frappe recognises a push it has already processed by the relay's queue ID (`X-Email-Relay-Id`). The exact request and the answers the relay understands are in the [Inbound contract](reference/inbound-contract.md).

The inbound URLs carry a per-server key, so treat the URL as a secret as well:

- Odoo: `/mail_cloudflare/inbound/<KEY>`
- Frappe: `/api/method/cloudflare_email_delivery.api.inbound?key=<KEY>`

Both adapters feed the message into the platform's normal inbound path, the same one IMAP polling uses: `message_process()` in Odoo and `InboundMail` in Frappe. Aliases, reply threading, attachments and auto-replies behave as they always did, and the standard fetch job is not needed for this mail.

### Delayed, never lost

How the relay reacts to the ERP's answer decides what happens to the message:

| ERP response                                    | Relay does                                                         | Typical cause                                           |
| ----------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------- |
| 2xx                                             | Marks the row `delivered` and purges it after the retention period | The normal case                                         |
| 408, 429, any 5xx, a timeout or a network error | Keeps it `pending` and retries                                     | ERP restarting, overloaded or unreachable               |
| Any other 4xx, or a 3xx                         | Marks it `rejected` and parks it for an operator                   | Wrong secret, unknown key, no matching route, wrong URL |

The default retry schedule is 1 minute, 5 minutes, 15 minutes, 1 hour, then every 6 hours, repeating the last value. With the default limit of 32 attempts, a message is retried for about a week before it is marked `dead`. Delivered messages stay in R2 for 30 days by default (`retentionDays`), and each tenant can tune the schedule, the attempt limit, the timeout and the retention.

Rejected and dead messages are not discarded. An operator can list them, read the stored `.eml` and requeue them one at a time or in bulk through the [Ops API](reference/ops-api.md), which is protected by a bearer token. That is how you recover after an outage or after rotating a secret.

> [!WARNING]
> The relay protects a message once it has been stored. It cannot help with mail that Cloudflare Email Routing never delivered to the Worker, such as a recipient domain with no route configured or an address that matches none of your routing rules. When mail never shows up in the relay's logs at all, check the zone's Email Routing settings.

## What you gain

- **No mailbox credentials in the ERP.** Outbound uses an API token. Inbound uses a per-tenant signing secret plus an unguessable URL.
- **No polling.** Mail arrives as a push the moment the ERP can accept it.
- **A queue you can inspect.** Every inbound message has a row with its status, attempt count, last HTTP status and the ERP's reference to the record it created.
- **Tenant isolation.** One client's outage, bad secret or deploy cannot block another client's mail.
- **Deliverability managed in one place.** Sender authentication records live with the domain in Cloudflare.

## Limitations

- **Asynchronous bounces do not reach Odoo or Frappe.** The `Return-Path` on outbound mail is Cloudflare's, and bounces go to Cloudflare's own bounce subdomain. Only recipients Cloudflare rejects at send time are reported back to the application.
- **Reply matching depends on `References`.** Because Cloudflare rewrites `Message-ID`, a client that drops `References` can break threading.
- **Inbound size.** The Frappe adapter's documentation says the web server refuses messages larger than the site's `max_file_size` (25 MiB by default) before they reach the app. The relay itself has no size limit in its code.
- **Messages without a `Message-ID`** cannot be deduplicated on retry by Odoo.
- **Email Routing and the Worker must share a Cloudflare account.** A client who owns their own Cloudflare account therefore needs a dedicated Worker rather than a shared relay.
- **Plans.** The relay needs the Workers Paid plan because it uses Durable Objects.

## Where to go next

- [Deploying the relay](deploying-the-relay.md): stand up the inbound Worker, its R2 bucket, tenants and secrets.
- [Adapter guides](adapters/README.md): configure Frappe, ERPNext, Odoo or WordPress.
- [Troubleshooting](troubleshooting.md): diagnose stuck, rejected and missing mail.
