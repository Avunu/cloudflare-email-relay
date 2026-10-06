---
title: Adapters
description: The Frappe and ERPNext app, the Odoo module and the WordPress plugin that connect a system to Cloudflare Email, and how each one fits with the relay.
order: 0
tags: [adapters, frappe, odoo, wordpress]
updated: 2026-10-06
---

An adapter is the part of the suite that lives inside your business system. It does two jobs, and only the first one is mandatory:

- **Send.** It replaces the system's SMTP connection with a call to the Cloudflare Email Sending API, using an account ID and an API token.
- **Receive.** It exposes a signed webhook that the [relay](../deploying-the-relay.md) posts incoming mail to, and feeds each message into the system's own inbound mail path.

Each adapter is its own open-source project with its own repository, releases and issue tracker. The guides in this section cover installing and configuring them with the relay; the repository is authoritative for anything version-specific.

| System                | Adapter                                                                                 | Sends | Receives | Guide                                   |
| --------------------- | --------------------------------------------------------------------------------------- | ----- | -------- | --------------------------------------- |
| Frappe 16 and ERPNext | [cloudflare_email_delivery](https://github.com/Avunu/cloudflare_email_delivery)         | Yes   | Yes      | [Frappe and ERPNext](frappe-erpnext.md) |
| Odoo 18               | [mail_cloudflare](https://github.com/Avunu/avunu-odoo-addons/tree/18.0/mail_cloudflare) | Yes   | Yes      | [Odoo](odoo.md)                         |
| WordPress 7.0         | [wordpress-cloudflare-email](https://github.com/Avunu/wordpress-cloudflare-email)       | Yes   | No       | [WordPress](wordpress.md)               |

## Connecting a system, end to end

The steps are the same for Odoo and Frappe. WordPress stops after step 3 because it only sends.

1. **Cloudflare.** Onboard every sending domain for Email Sending and create an API token with the **Email Sending: Edit** permission. Note the Cloudflare account ID. Cloudflare adds the bounce, SPF, DKIM and DMARC records when you onboard a domain, so deliverability is managed in one place.
2. **Adapter, sending.** Put the account ID and the token into the adapter: an outgoing mail server in Odoo, an Email Domain in Frappe, two constants in `wp-config.php` for WordPress.
3. **Test sending.** Each adapter has a way to check the token and send a test message, described in its guide.
4. **Adapter, receiving.** Create the incoming side. The adapter generates a **webhook URL**, which carries a per-server key, and a **webhook secret**.
5. **Relay.** Add the system as a [tenant](../reference/tenants.md): a row in `tenants.json` with its domains, and a `TENANT_<SLUG>` secret holding the webhook URL as `inboundUrl` and the webhook secret as `secret`. Redeploy for the row; the secret needs no redeploy.
6. **Routing.** In the zone's Email Routing, send the addresses (or the catch-all) to the relay Worker.
7. **Test receiving.** Send a message to a routed address and watch its row reach `delivered` in the [ops API](../reference/ops-api.md).

> [!IMPORTANT]
> The webhook URL embeds a key and the secret signs every delivery. Treat both as credentials: do not paste them into tickets, chat or Git.

## What the adapters have in common

- **Headers.** Cloudflare allows a closed list of headers plus anything starting with `X-`. The Odoo and Frappe adapters pass the threading headers, the `List-*` headers, `Precedence`, `Auto-Submitted` and the `X-*` headers, and drop the rest, because one disallowed header fails the whole request. The WordPress plugin sends custom headers as given.
- **Reply threading.** Cloudflare replaces the `Message-ID` of outbound mail. Odoo and Frappe add their own ID to `References`, and replies thread because mainstream mail clients copy `References` into a reply.
- **Limits.** 5 MiB per encoded message and 50 recipients (To, Cc and Bcc combined). The Odoo and Frappe adapters also enforce 20 custom headers of at most 2,048 bytes each and 16 KB in total. The numbers and the messages you see are in [Troubleshooting](../troubleshooting.md).
- **No async bounces.** Bounces for mail that Cloudflare accepted go to a Cloudflare-controlled address and never reach the ERP. Only recipients Cloudflare rejects at send time are reported back.
- **Licences.** The relay, the Frappe app and the WordPress plugin are MIT licensed. The Odoo module declares AGPL-3 in its manifest.
