---
title: Inbound contract
description: The signed HTTPS request the Cloudflare Email relay sends to an ERP for each message, the headers it carries, how to verify it and the answers the relay understands.
order: 2
tags: [webhook, hmac, reference]
updated: 2026-10-06
---

This page specifies what the relay sends to a tenant's `inboundUrl` and how the receiver should answer. The Odoo and Frappe adapters already implement it. Read it when you debug a delivery, test an adapter in isolation or write a receiver for another system.

## The request

Each delivery attempt is `POST <inboundUrl>` with the stored message as the body and `redirect: manual`. The body is the raw RFC 5322 message exactly as it was stored in R2, and it already contains `Delivered-To` (the envelope recipient) and `Return-Path` (`<>` for a bounce) as its first two header lines.

| Header                              | Value                                                                                           |
| ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| `Content-Type`                      | `message/rfc822`                                                                                |
| `X-Email-Relay-Id`                  | The row's ULID. It is stable across attempts, so the ERP may deduplicate on it.                 |
| `X-Email-Relay-Tenant`              | The tenant slug.                                                                                |
| `X-Email-Relay-Timestamp`           | Unix seconds, fresh on every attempt.                                                           |
| `X-Email-Relay-Signature`           | `v1=` followed by the hex HMAC-SHA256 of `"<timestamp>." + body`, keyed with the tenant secret. |
| `X-Email-Relay-Envelope-From`       | The SMTP envelope sender. Empty for a bounce.                                                   |
| `X-Email-Relay-Envelope-To`         | The SMTP envelope recipient: the routed address.                                                |
| `X-Email-Relay-Attempt`             | The 1-based attempt number.                                                                     |
| `User-Agent`                        | `cloudflare-email-relay/<VERSION>`                                                              |
| `CF-Access-Client-Id` and `-Secret` | Only when the tenant's secret carries a Cloudflare Access service token.                        |

The envelope values are percent-encoded when they are not printable ASCII, so an address with non-ASCII characters arrives legible instead of failing the request.

## Verifying the signature

The signed payload is the UTF-8 timestamp string, a dot, and then the body bytes, untouched:

```python
import hashlib
import hmac
import time

expected = hmac.new(secret.encode(), f"{timestamp}.".encode() + body, hashlib.sha256).hexdigest()
ok = hmac.compare_digest(signature, f"v1={expected}") and abs(time.time() - int(timestamp)) <= 300
```

Three rules keep verification reliable:

- Sign and compare the **raw body bytes**, never a re-serialized or re-decoded copy. Anything between the relay and the ERP that rewrites the body breaks the signature.
- Use the timestamp string **exactly as received**.
- Compare in constant time, and reject a timestamp more than 300 seconds from your own clock. A receiver whose clock is wrong rejects every delivery with 401.

The cross-implementation test vector every side pins: `HMAC("key", 1700000000, b"hello")` gives

```text
v1=4d583a269f4f276a3fa80ff31b5a01879a848096983222a17893d198418939aa
```

The `v1=` prefix exists so that a `v2=` that also signs the relay ID can be introduced later without a flag day.

Replay protection is the timestamp window. Within it a replayed request must be a no-op, which is why a receiver deduplicates: Odoo ignores a message whose `Message-ID` it has already processed, and Frappe recognises a push it has already processed by `X-Email-Relay-Id`.

## What a receiver should do

1. Look the tenant up by the key in the URL. An unknown key answers 404.
2. Verify the signature and the timestamp before anything else. Answer 401 on failure and never say which check failed.
3. Check that the `Delivered-To` domain is one the receiver owns. This is the defence against a shared relay misrouting mail. The Frappe adapter does it and answers 422 when the domain is not the account's.
4. Hand the message to the system's normal inbound mail path.
5. Answer with a status code that tells the relay what to do next.

## What the relay does with the answer

The status code decides the row's fate:

| ERP answers                                       | Row becomes | Why                                                                                                              |
| ------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------- |
| Any 2xx                                           | `delivered` | The remote reference is recorded when the answer carries one.                                                    |
| 408, 429, any 5xx, a timeout or a network error   | `pending`   | Transient. The row is retried on the tenant's schedule and becomes `dead` once `maxAttempts` attempts are spent. |
| Any other 4xx (401, 404, 422 and so on), or a 3xx | `rejected`  | The ERP answered but will not take the message, and retrying does not help. The row is parked for an operator.   |

Redirects are never followed: replaying a signed body to an origin nobody vetted would be unsafe, so a 3xx means the `inboundUrl` is wrong and the row is parked.

### The response body

On success the ERP answers with JSON:

```json
{ "ok": true, "remote_ref": "<record id or name>", "id": "<relay id>" }
```

`remote_ref` is the ERP's reference to the record it created or matched, or `null` when it deliberately ignored the message (a duplicate, a bounce, or its own outgoing mail looping back). The relay stores it on the row. It also understands Frappe's `{"message": ...}` wrapper and the older `thread_id` (Odoo) and `communication` (Frappe) fields.

On failure the ERP answers `{"ok": false, "error": "<one line>"}`. The relay keeps a short description of every non-2xx answer in the row's `lastError`, as `HTTP <status>: <line>`, where the line is the `error` field, or the first line of Frappe's `exception`, or the first line of whatever came back (a proxy's error page, say), cut to 200 characters. The ops API shows it, so write errors for the operator who will read them.

## The ERP-side URLs

The URLs embed a per-server key generated by the ERP, so the URL is itself a secret:

| Platform | Inbound URL                                                                      |
| -------- | -------------------------------------------------------------------------------- |
| Odoo     | `https://<ODOO_HOST>/mail_cloudflare/inbound/<KEY>`                              |
| Frappe   | `https://<SITE_HOST>/api/method/cloudflare_email_delivery.api.inbound?key=<KEY>` |

## Testing a receiver without the relay

This script signs a small message the way the relay does and posts it, which separates an ERP problem from a relay problem. Run it from any machine with the real webhook URL and secret:

```python
import hashlib
import hmac
import time
import urllib.error
import urllib.request

URL = "<INBOUND_URL>"
SECRET = "<SHARED_SECRET>"
body = (
    b"From: jane@example.org\r\n"
    b"To: support@example.com\r\n"
    b"Subject: Webhook test\r\n"
    b"Message-ID: <webhook-test-1@example.org>\r\n"
    b"\r\n"
    b"Hello from a manual test.\r\n"
)

timestamp = str(int(time.time()))
digest = hmac.new(SECRET.encode(), f"{timestamp}.".encode() + body, hashlib.sha256).hexdigest()

request = urllib.request.Request(URL, data=body, method="POST", headers={
    "Content-Type": "message/rfc822",
    "X-Email-Relay-Id": "manual-test",
    "X-Email-Relay-Timestamp": timestamp,
    "X-Email-Relay-Signature": f"v1={digest}",
    "X-Email-Relay-Envelope-From": "jane@example.org",
    "X-Email-Relay-Envelope-To": "support@example.com",
})
try:
    with urllib.request.urlopen(request) as response:
        print(response.status, response.read().decode())
except urllib.error.HTTPError as error:
    print(error.code, error.read().decode())
```

Replace `support@example.com` with an address on the tenant's own domain, or the receiver answers 422. A routed message answers 200 with `"ok": true`. If no Odoo alias matches and the server has no fallback model, you get a 422, which is the correct result. Sending the same message twice is harmless: Odoo answers 200 with a `null` `remote_ref` the second time because it recognises the `Message-ID`, and Frappe answers 200 with the first record because it recognises the relay ID.

> [!NOTE]
> The script is a sketch that follows this contract. It is not a shipped tool, and it posts a real message into the system you point it at.

## Related

- [Odoo](../adapters/odoo.md) and [Frappe and ERPNext](../adapters/frappe-erpnext.md): the two receivers and the answers each one gives.
- [Troubleshooting](../troubleshooting.md): what each rejected status means on each platform.
- [Tenants and secrets](tenants.md): where `inboundUrl` and `secret` are configured.
