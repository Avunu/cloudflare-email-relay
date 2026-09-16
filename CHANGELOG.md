# Changelog

## [2.0.0](https://github.com/Avunu/cloudflare-email-relay/compare/cloudflare-email-relay-v1.1.0...cloudflare-email-relay-v2.0.0) (2026-09-16)


### ⚠ BREAKING CHANGES

* the package has no default export — build the handler with createRelay({ tenants }) and re-export its InboxQueue; the ODOO_* and tunable env vars are gone; delivery headers are X-Email-Relay-*; ops routes moved under /tenants/:slug.
* the package is renamed; the fleet pins the new name.

### Features

* implement worker scaffolding ([ce6f4d9](https://github.com/Avunu/cloudflare-email-relay/commit/ce6f4d968ff4512cce2cfaf51908418f7b617352))
* multi-tenant relay with one Durable Object per tenant ([cae5f84](https://github.com/Avunu/cloudflare-email-relay/commit/cae5f84a367a9c84bf033255ecc0918d7890edb3))
* **worker:** signing, RFC 5322 envelope headers, backoff and utility primitives ([fa12f07](https://github.com/Avunu/cloudflare-email-relay/commit/fa12f07cbdf28faebab5ceef59dd299e3cb72aa7))


### Bug Fixes

* **worker:** retain vitest 4 ([0982f29](https://github.com/Avunu/cloudflare-email-relay/commit/0982f2974765dc49f9cd74a8cb4e06504e584e48))


### Miscellaneous Chores

* move to Avunu/cloudflare-email-relay as @avunu/cloudflare-email-relay ([12dfde3](https://github.com/Avunu/cloudflare-email-relay/commit/12dfde30f2cc7a8c2a6d1599e79e4d32f7b8b044))

## [1.1.0](https://github.com/Avunu/odoo-cloudflare-email/compare/mail-cloudflare-worker-v1.0.0...mail-cloudflare-worker-v1.1.0) (2026-09-15)


### Features

* bidirectional Cloudflare email transport (mail_cloudflare + Email Worker) ([fcfa010](https://github.com/Avunu/odoo-cloudflare-email/commit/fcfa01061ac7d952ed3f1a5eb3959739828db36e))
* implement worker scaffolding ([c0d50de](https://github.com/Avunu/odoo-cloudflare-email/commit/c0d50de111e947e56eb13b06c32d6adcaea2b4a4))
* **worker:** signing, RFC 5322 envelope headers, backoff and utility primitives ([e99355a](https://github.com/Avunu/odoo-cloudflare-email/commit/e99355a4444111dc875eb69d0650ed27af0488cc))

## Changelog
