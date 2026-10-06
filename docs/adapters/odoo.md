---
title: Odoo
description: Install the mail_cloudflare module to send Odoo mail through the Cloudflare Email Sending API and receive it from the relay as a signed webhook, with no SMTP or IMAP server.
order: 2
tags: [odoo, adapter]
updated: 2026-10-06
---

This guide covers the [mail_cloudflare](https://github.com/Avunu/avunu-odoo-addons/tree/18.0/mail_cloudflare) Odoo module: how to install it, configure an outgoing mail server for Cloudflare Email Sending, create an incoming mail server that receives mail through a signed webhook, and test and troubleshoot both directions. Use it when you want Odoo to send and receive mail without running an SMTP relay or polling an IMAP mailbox. For the design behind it, read [How the suite works](../how-it-works.md) first.

## How it works

The module plugs into two stock Odoo models and leaves the rest of the mail stack alone.

**Outbound.** An outgoing mail server (`ir.mail_server`) gets a new authentication type, _Cloudflare Email Sending_. Instead of a host and a password it holds a Cloudflare account ID and an API token. When Odoo sends, the message it already built is turned into one REST call per recipient. The mail queue, failure handling and the `From` rewrite are still stock Odoo.

**Inbound.** An incoming mail server (`fetchmail.server`) gets a new type, _Cloudflare Email Worker_. It has no host or login. It carries a webhook key (part of the URL) and a signing secret, both generated when you save the record. The [relay](../deploying-the-relay.md) receives mail from Cloudflare Email Routing and posts the raw message to Odoo. Odoo verifies the signature and hands the message to the same `message_process()` path that IMAP polling uses, so aliases, reply threading and the server's fallback model behave as they always have.

Nothing is polled. The standard fetchmail cron stays off unless you also have an IMAP or POP server configured.

## Before you start

You need:

- Odoo 18.0 with the `mail` module. The module depends only on `mail`.
- A Cloudflare account with your domain on it, on the Workers Paid plan, which Email Sending requires.
- A public `https://` address for Odoo, set as the `web.base.url` system parameter.
- Shell access to put the module in your Odoo addons path.

## Prepare Cloudflare

### Email Sending

1. In the Cloudflare dashboard, go to _Compute > Email Service > Email Sending_ and choose _Onboard Domain_ for every domain you send from. Cloudflare adds the bounce MX, SPF, DKIM and DMARC records for you.
2. Create an API token with the **Email Sending: Edit** permission. The module expects an account-owned token.
3. Note your Cloudflare account ID. In the dashboard it is in the API section of the account's overview page.

### Email Routing

Enable Email Routing on the zone for free. Then route the addresses Odoo should receive, or the catch-all, to the deployed relay Worker with the _Send to a Worker_ action. [Deploying the relay](../deploying-the-relay.md) covers deploying the Worker and adding Odoo as a tenant.

## Install the module

Copy the `mail_cloudflare` directory from the [avunu-odoo-addons](https://github.com/Avunu/avunu-odoo-addons/tree/18.0) repository (branch `18.0`) into a directory on your Odoo `addons_path`. Then, in Odoo with developer mode on, open _Apps_, choose _Update Apps List_, search for "Cloudflare Email Transport" and install it.

> [!WARNING]
> Uninstalling the module resets Cloudflare-typed outgoing servers to the default type with no host. Archive them first.

## Configure the outgoing mail server

Go to _Settings > Technical > Outgoing Mail Servers_ and create a new record.

| Field                 | Value                                   |
| --------------------- | --------------------------------------- |
| Authenticate with     | Cloudflare Email Sending                |
| Cloudflare Account ID | `<CLOUDFLARE_ACCOUNT_ID>`               |
| Cloudflare API Token  | `<CLOUDFLARE_API_TOKEN>`                |
| FROM Filtering        | `example.com`, the domain you onboarded |
| Maximum Email Size    | 5 MB, set automatically                 |

Choosing the Cloudflare authentication blanks the SMTP host and port and hides the Connection tab, since none of it applies.

The module enforces three things when you save: an account ID, an API token and a FROM Filtering value are all required. The filter matters because Cloudflare only sends from onboarded domains. With the filter set, Odoo rewrites a `From` address outside your domain to the notifications address instead of sending something Cloudflare will refuse.

Click _Test Connection_. For Cloudflare servers this calls the token verification endpoint and succeeds when the token is active. It does not send a message. _Detect Max Limit_ sets the size to 5 MB, which is Cloudflare's fixed limit rather than a measured value.

Also check _Settings > General > Discuss > Alias Domain_. It should be the domain you routed in Cloudflare, so `catchall@`, `bounce@` and `notifications@` exist on it.

### What Odoo sends

Each message becomes one JSON request to the Cloudflare send API, carrying these pieces:

- `From`, `To` and `Cc` from the headers, and `Bcc` from the envelope.
- Text and HTML bodies, and `Reply-To`.
- Attachments, with inline ones tied to their `Content-ID`.
- Only the headers Cloudflare allows: threading headers, `List-*`, `Precedence`, `Auto-Submitted`, anything starting with `X-`, and a few others. Unknown headers are dropped rather than sent, because one disallowed header fails the whole request.

Cloudflare replaces the `Message-ID` of every message. To keep reply threading working, the module appends Odoo's own message ID to `References`. Mail clients copy `References` into replies, and Odoo matches on it.

Retries are short. Network errors and 5xx responses are retried with a 1 second and then 2 second back-off, up to 3 attempts. A 429 honors `Retry-After`, capped at 10 seconds. A 401 or 403 is treated as fatal and the rest of the batch fails immediately. Other 4xx responses are not retried.

## Configure the incoming mail server

1. Go to _Settings > Technical > Incoming Mail Servers_ and create a new record.
2. Set the type to **Cloudflare Email Worker**. Optionally set _Create a New Record_ to a fallback model, which receives mail that no alias matches.
3. Save the record. The webhook key and secret are generated on save, and the form shows a _Webhook URL_, _Webhook Key_ and _Webhook Secret_ with copy buttons.
4. Click _Test & Confirm_.
5. Give the Webhook URL and Webhook Secret to the relay as this tenant's `inboundUrl` and `secret` (see [Tenants and secrets](../reference/tenants.md)).

The URL is built from `web.base.url`. Confirmation fails unless that parameter is an `https://` address. Plain `http://` is accepted only for `localhost`, `127.0.0.1` or `::1`, which exists for local `wrangler dev` work. Set the parameter to your public HTTPS address and freeze it with `web.base.url.freeze`, so Odoo does not rewrite it from the browser's address.

### Rotate the secret

Use _Regenerate Secret_ on the server form to revoke a leaked or retired secret. It changes only the secret. The key, and so the URL, stay the same, so you only update the secret in the relay. Requests signed with the old secret are rejected as soon as you regenerate.

A duplicated server gets its own key and secret rather than copying the original's.

## The webhook, from Odoo's side

The relay sends `POST /mail_cloudflare/inbound/<KEY>` with a `message/rfc822` body containing the raw message. The headers that accompany it are listed in the [Inbound contract](../reference/inbound-contract.md). Two of them matter to Odoo in particular: Odoo recognizes aliases and Bcc'd recipients from `Delivered-To`, and bounces from `Return-Path`, and the module writes both into the message from the envelope headers when they are absent.

Odoo answers in JSON, and the status code tells the relay what to do next.

| Response | Meaning                                                                                                          | Relay action          |
| -------- | ---------------------------------------------------------------------------------------------------------------- | --------------------- |
| 200      | Processed. `remote_ref` is the record ID, or `null` for a duplicate, bounce or loop that was ignored on purpose. | `delivered`           |
| 401      | Bad or missing signature, or a stale timestamp.                                                                  | Parked as `rejected`  |
| 404      | Unknown key, or the server is not confirmed or is archived.                                                      | Parked as `rejected`  |
| 422      | No route: no alias matched and there is no fallback model.                                                       | Parked as `rejected`  |
| 500      | Anything else.                                                                                                   | Retried with back-off |

The route needs no session. The signature is the credential, and a failed check never says which part failed. Duplicates are ignored by `Message-ID`, so a retried push is harmless. Messages without a `Message-ID` cannot be deduplicated.

> [!NOTE]
> On a host that serves several databases, set `dbfilter` or `db_name` so Odoo can pick the database from the request. A `?db=` redirect would drop the POST body.

## Test it

### Outbound

1. Click _Test Connection_ on the outgoing server and confirm it succeeds.
2. Send a real message from Odoo, for example a chatter message to a partner whose address is on your side, and check it arrives.
3. If it does not, open the failed outgoing mail record. A mail that Cloudflare refused ends in the _Exception_ state with the reason in its failure text, prefixed with `CloudflareEmailError:`.

### Inbound

Send mail to an address you routed to the relay Worker and watch for a new record or a chatter reply. To test Odoo in isolation, post a signed request yourself with the script in the [Inbound contract](../reference/inbound-contract.md), using the Webhook URL and Webhook Secret from the server form.

A routed message answers with a 200 and an `ok` flag. If no alias matches the recipient and the server has no fallback model, you get a 422, which is the correct result. Sending the same `Message-ID` twice returns 200 with a `null` `remote_ref` the second time.

## Troubleshooting

These are the Odoo-side checks. For relay-side symptoms and the ops API, see [Troubleshooting](../troubleshooting.md).

### Test Connection fails

The message includes Cloudflare's response. A 401 or 403 means the token is wrong or lacks permission. An inactive token is reported as such. "Could not reach Cloudflare" is a network problem between Odoo and `api.cloudflare.com`.

### Mail goes to Exception

Read the failure reason on the mail. The common ones:

- **No recipient could be reached.** Cloudflare synchronously bounced or suppressed every recipient. If only some were refused, Odoo logs a warning and reports success.
- **More than 50 recipients.** To, Cc and Bcc combined are capped at 50.
- **Message is too large.** The encoded message must fit in 5 MiB, and Odoo checks before it makes a request. Attachments attached to a record are turned into links above the size limit. Attachments added in the composer are always embedded.
- **Header limits.** Cloudflare allows 20 custom headers, 16 KB of headers in total and 2,048 bytes per value. Odoo trims the oldest `References` entries first.
- **Refused `From` address.** A mail forced onto the Cloudflare server whose `From` is not on the onboarded domain is sent unchanged and refused. Odoo only rewrites `From` when it picks the server through FROM Filtering.
- **No body.** Cloudflare needs at least one non-empty text or HTML body.

### Webhook errors

Check the Odoo log first. Every rejection is logged with the relay ID from `X-Email-Relay-Id`.

| Symptom                          | Likely cause                                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 401                              | The relay holds an old secret (after _Regenerate Secret_), the body was altered in transit, or the clocks differ by more than 300 seconds. |
| 404                              | The key in the URL is wrong, the server is archived, or you did not click _Test & Confirm_.                                                |
| 422                              | No alias matches the routed address and the server has no fallback model. Set one or create the alias.                                     |
| 500                              | An unexpected error in Odoo. The relay retries with back-off. Read the traceback in the Odoo log.                                          |
| Confirmation refuses to proceed  | `web.base.url` is not `https://`. Fix it and confirm again.                                                                                |
| Nothing arrives and no log lines | The request never reached Odoo. Check Email Routing, the relay's tenant secret and your reverse proxy.                                     |

Replies that do not thread, and bounce messages that never reach Odoo, are explained under "Limitations" below.

## Limitations

- Cloudflare rewrites `Message-ID`, so Odoo's own ID survives only inside `References`. If a replying client strips `References`, the reply creates a new record instead of threading.
- Asynchronous bounces never reach the `bounce@` alias. They go to a Cloudflare-controlled address, and only the synchronous failures described above are visible to Odoo.
- The 5 MiB message limit is Cloudflare's.
- A stock SMTP server pointed at `smtp.mx.cloudflare.net` on port 465 (SSL/TLS, user `api_token`, password the token) is a sending-only alternative that needs no module. It gives no per-recipient result, and it has not been verified whether `Message-ID` survives it.

## Run the module's tests

The module's own test suite never contacts Cloudflare. It scripts the API responses and signs real HTTP requests against a running test server. To run it from an odoo-nix dev shell, turn the dev mail catcher off first. It is server-wide and would swallow every send the tests make:

```bash
ODOO_MAILCATCH_ENABLED=0 python odoo/odoo-bin -c odoo.conf -d mc_test -i mail_cloudflare --test-enable --test-tags /mail_cloudflare --stop-after-init
```

## Related

- [Adapters overview](README.md): the steps shared by every adapter.
- [Frappe and ERPNext](frappe-erpnext.md): the same suite for Frappe 16.
- [Inbound contract](../reference/inbound-contract.md): the request the relay sends to this module.
- The module's own [README](https://github.com/Avunu/avunu-odoo-addons/blob/18.0/mail_cloudflare/README.md), the authority for its current version.
