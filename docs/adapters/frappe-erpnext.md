---
title: Frappe and ERPNext
description: Install cloudflare_email_delivery to send Frappe and ERPNext email through the Cloudflare Email Sending API and receive it from the relay as a signed webhook, with no SMTP or IMAP.
order: 1
tags: [frappe, erpnext, adapter]
updated: 2026-10-06
---

This guide shows how to run Frappe or ERPNext email through Cloudflare with the [cloudflare_email_delivery](https://github.com/Avunu/cloudflare_email_delivery) app. Use it when you want to retire SMTP and IMAP credentials for a domain and let Cloudflare carry both directions. For the design behind it, read [How the suite works](../how-it-works.md) first.

## How it works

The app replaces two things Frappe normally does with mailbox servers.

- **Outbound.** Frappe's `override_email_send` hook hands every Email Queue entry to the app. For an account on a Cloudflare domain, the app makes one call to the Cloudflare Email Sending REST API per recipient. Accounts on other domains keep using SMTP or Frappe Mail as before.
- **Inbound.** Cloudflare Email Routing delivers mail to the [relay](../deploying-the-relay.md), which posts each message to your site as a signed HTTPS request. The app verifies the signature and gives the raw message to Frappe's own `InboundMail`, the same class IMAP polling uses. _Append To_, auto-replies, attachments, notifications and reply threading behave as they do for a normal mailbox.

This guide covers the Frappe side. To stand up the relay and add your site as a tenant, follow [Deploying the relay](../deploying-the-relay.md).

## Requirements

- Frappe 16. The app declares `frappe >=16.0.0,<17.0.0` and Python 3.12 or newer.
- A Cloudflare account on the Workers Paid plan, with your domain onboarded for **Email Sending** and **Email Routing** enabled on the zone.
- A Cloudflare API token with the **Email Sending: Edit** permission.
- For inbound mail: a site reachable over https, with `host_name` set in its site config, and a [tenant](../reference/tenants.md) entry for the site on the relay.

## Install the app

From the bench directory, fetch the app and install it on your site:

```bash
bench get-app https://github.com/Avunu/cloudflare_email_delivery
bench --site <SITE_NAME> install-app cloudflare_email_delivery
```

The app adds custom fields to Email Domain, Email Account and Communication, and overrides the Email Domain and Email Account classes. The fields ship as customizations that sync on migrate, so if they do not appear after install, run `bench --site <SITE_NAME> migrate`.

## Configure outbound

### Create the Email Domain

Open **Email Domain** and create or edit the domain you send from.

1. Tick **Send via Cloudflare**. The SMTP and IMAP server fields stop being required.
2. Fill **Cloudflare Account ID** and **Cloudflare API Token**. Both are mandatory once the box is ticked.
3. Save. The app checks the token against Cloudflare and refuses to save if Cloudflare rejects it or reports it as not active.

> [!NOTE]
> The token check calls Cloudflare's token verification endpoint. It confirms the token is active; the Email Sending permission and the domain onboarding are only exercised when a message is actually sent.

### Create the Email Account

Open **Email Account** and create the account.

1. Set the email address and link the Email Domain from the previous step.
2. Tick **Enable Outgoing**. You do not need a password or any SMTP settings; the app blanks the server fields and skips connection tests.
3. Save.

Send yourself a test message from any document, then open **Email Queue** and check that the entry reaches _Sent_. If it fails, the error is recorded on the queue entry.

### What gets sent

Each recipient of a queue entry becomes one API call. The request carries the `From` address, the recipient, `Reply-To`, the text and HTML bodies, and attachments. Attachments with a `Content-ID` are sent as inline images, so `cid:` references keep working.

Cloudflare allows only some headers. The app passes through the threading headers (`In-Reply-To`, `References`), the documented `List-*` headers, `Precedence`, `Auto-Submitted` and anything starting with `X-`, and drops the rest. Cloudflare's [header reference](https://developers.cloudflare.com/email-service/reference/headers/) is the authority on the list.

Cloudflare also replaces the `Message-ID` on every message. Frappe keeps its own ID in Email Queue and Communication, so the app appends that ID to `References`. The inbound side uses it to thread replies, as described below.

### Retries and failures

- A network error or a 5xx response is retried up to three attempts in total, with a 1 second then 2 second back-off.
- A 429 response waits for `Retry-After` when Cloudflare sends it, capped at 10 seconds per wait.
- A 401 or 403 is treated as fatal. The remaining recipients in the same batch fail immediately instead of retrying with a bad token.
- Any other 4xx fails at once, because retrying a malformed or oversized request cannot help.
- If Cloudflare reports a recipient as permanently bounced or suppressed in its immediate response, that recipient is flagged. When no recipient could be reached the queue entry fails; when some could, the app logs a warning and counts the send as successful.

## Configure inbound

### Enable incoming on the Email Account

On the same Email Account:

1. Tick **Enable Incoming**.
2. Choose **Append To** (ToDo, Issue, Lead and so on) and set the usual options: auto-reply, attachment limit, notifications.
3. Save.

There is no IMAP server for this account, and the scheduler's mail pull does nothing for it. On save, the app generates a webhook key and a webhook secret once and never rotates them on later saves.

### Set host_name first

The webhook URL is built from the site's `host_name`. The app requires https and refuses to save otherwise, except on a loopback address (`localhost`, `127.0.0.1`, `::1`) or when the site is in developer mode. Set it before you save the account:

```bash
bench --site <SITE_NAME> set-config host_name https://site1.example.com
```

### Hand the credentials to the relay

After saving, the **Cloudflare Email Receiving** section shows the **Webhook URL**. The form has a **Cloudflare Webhook** group of buttons:

- **Copy Webhook URL**, available to anyone who can open the form.
- **Copy Webhook Secret**, for users with the System Manager role.
- **Regenerate Webhook Secret**, for System Managers.

Give the URL and the secret to whoever runs the relay. They become the tenant's `inboundUrl` and `secret` in its `TENANT_<SLUG>` secret (see [Tenants and secrets](../reference/tenants.md)), together with the domain or domains whose mail should reach this site. Then, in the Cloudflare zone's **Email Routing**, route the addresses you want (or the catch-all) to the relay Worker.

> [!WARNING]
> The Webhook URL embeds the key, and the secret signs every delivery. Treat both as credentials. Do not paste them into tickets, chat or Git.

### Rotate the secret

**Regenerate Webhook Secret** changes the secret only. The URL and key stay the same, so you only update the tenant's secret on the relay. Until you do, deliveries signed with the old secret are rejected with 401 and park as `rejected` on the relay, where they can be [retried in bulk](../reference/ops-api.md).

## Test inbound

Send a message to an address that routes to the relay and confirm a Communication appears on the Email Account's _Append To_ document type. If nothing arrives, check **Error Log** and **Unhandled Email** on the site, then the relay's own logs and queue ([Troubleshooting](../troubleshooting.md)).

To separate site problems from relay problems, post a signed test message straight to the webhook with the script in the [Inbound contract](../reference/inbound-contract.md). Use an address on the Email Account's domain as the envelope recipient, or the domain check answers 422. A successful call answers 200 with `"ok": true` and the new Communication's name as `remote_ref`.

## The webhook, from Frappe's side

The endpoint is `POST /api/method/cloudflare_email_delivery.api.inbound?key=<KEY>` with the raw message as a `message/rfc822` body. It is a guest method: the signature is the only credential. The headers the relay sends are listed in the [Inbound contract](../reference/inbound-contract.md). The status code Frappe answers tells the relay what to do next:

| Response | Meaning                                                                                                            | Relay behavior        |
| -------- | ------------------------------------------------------------------------------------------------------------------ | --------------------- |
| 200      | Processed. `remote_ref` is `null` when your own outgoing mail looped back and was deliberately ignored.            | `delivered`           |
| 401      | Missing or bad signature, or a stale timestamp.                                                                    | Parked as `rejected`  |
| 404      | Unknown key, or incoming disabled on the account.                                                                  | Parked as `rejected`  |
| 422      | The recipient domain is not the account's, the envelope is invalid, or the reference document refused the message. | Parked as `rejected`  |
| 500      | Anything else. The error is written to Error Log and the message is stored as an Unhandled Email.                  | Retried with back-off |

Replay protection is the 300 second window plus the relay ID check. A message larger than the site's `max_file_size` (25 MiB by default) is refused by the web server before it reaches the app.

## How replies thread

Frappe threads replies on `In-Reply-To` only. Because Cloudflare rewrites the `Message-ID` of outgoing mail, a reply's `In-Reply-To` points at an ID Frappe never issued. The app handles that by checking `In-Reply-To` first, then `References` from newest to oldest, for an ID it recognises: one containing the site name, or one stored on a Communication or Email Queue entry. The first match becomes the reply target, so the reply lands on the right queue entry, Communication and document.

This relies on the replying mail client copying `References`, which mainstream clients do.

## Limits and known gaps

- **Message size.** 5 MiB per outgoing message once encoded.
- **Recipients.** 50 per message, To, Cc and Bcc combined. Frappe already sends one message per recipient, so this rarely matters.
- **Custom headers.** At most 20, 2,048 bytes per value and 16 KB in total. The app trims the oldest `References` entries first if it must, and fails the send only when that is not enough.
- **Dropped headers.** Headers outside Cloudflare's allow-list, such as `Disposition-Notification-To`, are not sent.
- **Asynchronous bounces never reach Frappe.** The return path belongs to Cloudflare, so only recipients Cloudflare rejects in its immediate response are reported. Watch bounce activity in Cloudflare.
- **Bcc.** Bcc recipients receive their copy, but the delivered message does not list them.

## Troubleshooting

These are the Frappe-side checks. For relay-side symptoms and the ops API, see [Troubleshooting](../troubleshooting.md).

| Symptom                                                   | Where to look                                                                                         |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Email Domain will not save                                | The token failed verification. The error message includes Cloudflare's reason.                        |
| Email Account will not save, and the error mentions https | Set `host_name` in the site config to the public https address, then save again.                      |
| A queue entry failed with a Cloudflare error              | Read the error on the Email Queue entry. A 401 or 403 means the token or its permissions.             |
| Mail sent, but replies create new documents               | The replying client dropped `References`, or the original ID is not in Email Queue or Communication.  |
| Inbound deliveries are parked as `rejected`               | Match the status in the table above. A 401 after a rotation means the relay still has the old secret. |
| Inbound answers 500                                       | Open **Error Log** on the site and the matching **Unhandled Email** entry.                            |

## Run the app's tests

The app ships a test suite. From the bench directory:

```bash
bench --site <TEST_SITE> install-app cloudflare_email_delivery
bench --site <TEST_SITE> run-tests --app cloudflare_email_delivery
```

The signing and API client tests are plain `unittest` and need no site:

```bash
python -m unittest cloudflare_email_delivery.tests.test_relay
```

If your development bench has a mail guard that strips email overrides, disable it for the test process, because it removes the very hooks these tests exercise.

## Related

- [Adapters overview](README.md): the steps shared by every adapter.
- [Odoo](odoo.md): the same suite for Odoo 18.
- [Inbound contract](../reference/inbound-contract.md): the request the relay sends to this app.
- The app's own [README](https://github.com/Avunu/cloudflare_email_delivery#readme), the authority for its current version.
