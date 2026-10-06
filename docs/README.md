---
title: Cloudflare Email
description: Business email without SMTP or IMAP for Frappe, ERPNext, Odoo and WordPress, built on the Cloudflare Email Sending API and a store-first relay Worker.
nav_title: Overview
order: 0
tags: [email, cloudflare, workers]
updated: 2026-10-06
---

Cloudflare Email is a set of four open-source projects that give business systems email without SMTP credentials or IMAP polling. Outgoing mail goes from your system straight to the Cloudflare Email Sending API. Incoming mail goes through Cloudflare Email Routing to a relay Worker, which stores every message in R2 before it delivers it to the Odoo or Frappe system that owns the recipient's domain as a signed HTTPS request. An outage on your side delays a message instead of losing it.

This site documents the whole suite. The relay is the project in this repository, [cloudflare-email-relay](https://github.com/Avunu/cloudflare-email-relay); the three adapters live in their own repositories and are covered by the [adapter guides](adapters/README.md).

## The four projects

| Project                                                                                 | What it does                                                                                                                                                |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [cloudflare-email-relay](https://github.com/Avunu/cloudflare-email-relay)               | The inbound Worker: stores each message in R2, then delivers it to the right system with signed retries. See [Deploying the relay](deploying-the-relay.md). |
| [cloudflare_email_delivery](https://github.com/Avunu/cloudflare_email_delivery)         | The Frappe and ERPNext adapter: sends through the API and receives from the relay. See [Frappe and ERPNext](adapters/frappe-erpnext.md).                    |
| [mail_cloudflare](https://github.com/Avunu/avunu-odoo-addons/tree/18.0/mail_cloudflare) | The Odoo adapter: sends through the API and receives from the relay. See [Odoo](adapters/odoo.md).                                                          |
| [wordpress-cloudflare-email](https://github.com/Avunu/wordpress-cloudflare-email)       | The WordPress plugin: sends every `wp_mail()` message through the API and keeps a log, outbound only. See [WordPress](adapters/wordpress.md).               |

Which ones you need depends on the system and on whether it must receive mail:

| System                | Sending                     | Receiving                                  |
| --------------------- | --------------------------- | ------------------------------------------ |
| Odoo 18               | `mail_cloudflare`           | `mail_cloudflare` plus the relay           |
| Frappe 16 and ERPNext | `cloudflare_email_delivery` | `cloudflare_email_delivery` plus the relay |
| WordPress             | `cloudflare-email` plugin   | Not supported: the plugin is send-only     |

## How a message travels

```text
OUTBOUND
  Odoo / Frappe / WordPress
    -> Cloudflare Email Sending API (one HTTPS call per message or recipient)
    -> the recipient's mail server

INBOUND
  sender's mail server
    -> Cloudflare Email Routing ("Send to a Worker")
    -> relay Worker: look up the domain, store the message in R2, queue it
    -> that tenant's Durable Object: signed HTTPS POST to the system
    -> Odoo or Frappe answers; the relay marks the message delivered,
       retries it later, or parks it for an operator
```

The ordering on the inbound path is the point of the design: the message is on disk before anything tries to deliver it. [How the suite works](how-it-works.md) explains each step and the limits to plan around.

## Start here

- **Understand the design first.** Read [How the suite works](how-it-works.md).
- **Stand up the relay.** Follow [Deploying the relay](deploying-the-relay.md), then describe each system as a tenant in [Tenants and secrets](reference/tenants.md).
- **Connect a system.** Pick the [Frappe and ERPNext](adapters/frappe-erpnext.md), [Odoo](adapters/odoo.md) or [WordPress](adapters/wordpress.md) guide.
- **Something is not arriving.** Go to [Troubleshooting](troubleshooting.md), which starts from the symptom.
- **Operate a running relay.** The [Ops API reference](reference/ops-api.md) lists every route, row field and log event.
- **Build another receiver.** The [Inbound contract](reference/inbound-contract.md) specifies the request the relay sends and the answers it understands.

## What you need

- A Cloudflare account with the domains you send and receive for. Email Routing can only hand mail to a Worker in the same account as the zone, which decides between a shared relay and a dedicated Worker for a client who owns their own Cloudflare account.
- The Workers Paid plan for the relay, because it uses Durable Objects. The Odoo and Frappe adapters also list the Workers Paid plan as a requirement for Email Sending.
- For the adapters: Odoo 18, Frappe 16, or WordPress 7.0 with PHP 8.4 (the versions the projects declare today).

> [!NOTE]
> Cloudflare's own documentation covers onboarding a domain for Email Sending and enabling Email Routing: see the [Cloudflare Email Service documentation](https://developers.cloudflare.com/email-service/). These guides cover the Avunu projects and link to Cloudflare for the rest.

## Need it set up?

Avunu runs this suite for clients as part of managed infrastructure and can wire it into an Odoo, ERPNext or WordPress site: see [avunu.net](https://avunu.net).
