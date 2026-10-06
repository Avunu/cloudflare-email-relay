---
title: WordPress
description: Install the Cloudflare Email plugin to route every wp_mail() message through Cloudflare Email Sending, then use its log viewer, WP-CLI checks and updates.
order: 3
tags: [wordpress, adapter, wp-mail]
updated: 2026-10-06
---

[Cloudflare Email](https://github.com/Avunu/wordpress-cloudflare-email) is an Avunu plugin that sends every message WordPress produces through the Cloudflare Email Sending API instead of the server's own mail transport, and keeps a searchable log of what was sent. Use it when you want WordPress mail to leave from a verified domain without running an SMTP relay. For how it fits with the Odoo and Frappe adapters, see [How the suite works](../how-it-works.md).

The plugin has no settings screen. You configure it with constants in `wp-config.php`, and the only screen it adds is the log viewer. It is send-only: it does not receive mail, so it does not use the relay.

## How it works

The plugin does not replace `wp_mail()`. When WordPress is about to send a message, the plugin swaps the global PHPMailer object for a subclass of WordPress's own bundled PHPMailer. Core then parses the recipients, headers, subject, body and attachments as it always does. When core calls `send()`, the plugin posts the message to Cloudflare over the WordPress HTTP API instead of using SMTP or `mail()`.

Because core does the parsing, every plugin and theme that sends mail is routed automatically. Cc, Bcc, Reply-To, custom headers and inline images are preserved. The `wp_mail_succeeded` and `wp_mail_failed` actions still fire.

There is no fallback. If Cloudflare rejects a message, the send is logged as failed and `wp_mail()` returns `false`.

## Requirements

- WordPress 7.0 or later and PHP 8.4 or later. These are the values in the plugin header, which WordPress enforces.
- A Cloudflare account with Email Sending enabled for your sending domain. Onboarding the domain and its deliverability records (SPF, DKIM, DMARC) happens in Cloudflare: follow [Cloudflare's Email Service documentation](https://developers.cloudflare.com/email-service/) for that part. The plugin only sends.
- A Cloudflare API token that is allowed to send email, plus your Cloudflare account ID. The Odoo and Frappe adapters use a token with the **Email Sending: Edit** permission. The plugin's own README asks for "the Email Sending permission", so pick the Email Sending permission the dashboard offers.
- Optional: [WP-CLI](https://wp-cli.org/) for the verification commands below.

## Install the plugin

The plugin is distributed as a zip attached to each [GitHub release](https://github.com/Avunu/wordpress-cloudflare-email/releases). The zip bundles its PHP dependencies and the compiled log viewer, so you do not need Composer or Node on the server.

1. Download `cloudflare-email.zip` from the latest release.
2. In wp-admin, go to **Plugins**, then **Add New Plugin**, then **Upload Plugin**, and upload the zip. Alternatively, extract it into `wp-content/plugins/` so the folder is `wp-content/plugins/cloudflare-email/`.
3. Activate the plugin.

You can also install from the command line. Run this in the WordPress root:

```bash
wp plugin install https://github.com/Avunu/wordpress-cloudflare-email/releases/latest/download/cloudflare-email.zip --activate
```

Activation creates the log table and schedules a daily cleanup job. The plugin also creates the table on its own if it is missing, which covers in-place updates and databases imported from another environment.

> [!WARNING]
> Do not install from a source checkout or GitHub's "Source code" archive. Those do not contain `vendor/` or `build/`. Without `vendor/` the plugin shows an admin error asking you to run `composer install` or use the release zip, and does nothing else.

## Configure wp-config.php

Add the constants to `wp-config.php`, above the line that tells you to stop editing:

```php
// Required
define('CLOUDFLARE_EMAIL_ACCOUNT_ID', '<CLOUDFLARE_ACCOUNT_ID>');
define('CLOUDFLARE_EMAIL_API_TOKEN', '<CLOUDFLARE_API_TOKEN>');

// Recommended: the From domain must be onboarded to Cloudflare Email Sending
define('CLOUDFLARE_EMAIL_FROM', 'no-reply@example.com');
define('CLOUDFLARE_EMAIL_FROM_NAME', 'Example Site');

// Optional
define('CLOUDFLARE_EMAIL_LOG', false);
define('CLOUDFLARE_EMAIL_LOG_RETENTION_DAYS', 30);
```

| Constant                              | Required    | Behavior                                                                                     |
| ------------------------------------- | ----------- | -------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_EMAIL_ACCOUNT_ID`         | yes         | Your Cloudflare account ID.                                                                  |
| `CLOUDFLARE_EMAIL_API_TOKEN`          | yes         | The API token used to send.                                                                  |
| `CLOUDFLARE_EMAIL_FROM`               | recommended | Forces the From address through the `wp_mail_from` filter.                                   |
| `CLOUDFLARE_EMAIL_FROM_NAME`          | recommended | Forces the From name through the `wp_mail_from_name` filter.                                 |
| `CLOUDFLARE_EMAIL_LOG`                | no          | Set to `false` to stop logging successful sends. Defaults to on. Failures are always logged. |
| `CLOUDFLARE_EMAIL_LOG_RETENTION_DAYS` | no          | Days to keep log rows. Defaults to 30. `0` keeps them forever.                               |

Set the From address explicitly. If you do not, WordPress defaults to `wordpress@` plus your site's domain, which is usually not onboarded to Cloudflare, so Cloudflare is likely to reject the message.

> [!TIP]
> Keep the token out of version control. Because `wp-config.php` is plain PHP, you can pass the value in from the server environment, for example `define('CLOUDFLARE_EMAIL_API_TOKEN', getenv('CLOUDFLARE_API_TOKEN'));`. The plugin trims whitespace and treats an empty value as not configured.

### When the constants are missing

If the account ID or token is absent, the plugin does not intercept anything and WordPress mail continues through its normal transport. In production (`WP_ENVIRONMENT_TYPE` set to `production`, or not set at all, since that is WordPress's default), administrators with `manage_options` see a warning notice in wp-admin saying the plugin is not configured. In any other environment type the plugin stays quiet, because a development machine catching mail locally or a staging site with no Cloudflare account is the expected state.

The log viewer stays available even when the credentials are removed, so you can still review past sends.

### Adjust the outgoing payload

Cloudflare can reject a message for reasons the plugin cannot predict, such as a custom header it does not allow. The `cloudflare_email_payload` filter gives you the final payload, and the mailer object, just before it is sent:

```php
add_filter('cloudflare_email_payload', function (array $payload) {
    unset($payload['headers']['X-Some-Header']);
    return $payload;
});
```

## Verify the setup

With WP-CLI, run these from the WordPress root:

```bash
wp cloudflare-email verify
wp cloudflare-email send-test jane@example.com
```

`verify` prints the configured account ID and From address, then asks Cloudflare whether the token is active. It checks the token only. It does not prove that your From domain is onboarded, so a passing `verify` can still be followed by a rejected send.

`send-test` sends a small HTML message through the normal `wp_mail()` path, so it also exercises the From filters and the log. It requires a valid email address. After it runs, open **Tools**, then **Cloudflare Email** in wp-admin to see the entry.

## Use the log viewer

The log viewer is at **Tools**, then **Cloudflare Email**. It is visible to users with the `manage_options` capability, which means administrators on a standard install.

The table shows date, status, From and To, titled by subject. You can search across From, To and Subject, filter by status (`sent` or `failed`), sort by date, status, From or Subject, and page through the results. Each row has three actions:

- **View** opens the full record: status, resend count, recipients, Cc, Bcc, Reply-To, attachment names and the body. HTML bodies render in a sandboxed frame. A failed entry shows the error Cloudflare returned.
- **Resend** sends the logged message again through `wp_mail()`. The original row is updated with the new status and its resend count goes up. No duplicate row is created.
- **Delete** removes one entry, or several at once when you select multiple rows. It asks for confirmation and cannot be undone.

> [!NOTE]
> The log stores the full message body, so treat it as sensitive. Password-reset and similar emails are stored like any other. Lower `CLOUDFLARE_EMAIL_LOG_RETENTION_DAYS`, or set `CLOUDFLARE_EMAIL_LOG` to `false`, if that is a concern. Failures are logged regardless of the second setting.

### What a resend can and cannot restore

The log keeps attachment file paths, not file contents. A resend re-attaches a file only if it is still readable at that path. If it is gone, the message is resent without it. Attachments created from in-memory strings have no path and are not restored. A resend rebuilds the headers from what was logged: From, content type, Cc, Bcc, Reply-To and custom headers.

### Retention

Rows older than the retention window are deleted by a daily WP-Cron job named `cloudflare_email_prune`, which activation schedules. Cleanup depends on WP-Cron actually running, so if your site disables it in favor of a system cron, make sure that cron triggers WordPress's cron.

## Limits and behavior to know about

- A message needs at least one To recipient.
- To, Cc and Bcc together are limited to 50 recipients per message. The plugin refuses larger sends with an error before calling Cloudflare.
- Only the first Reply-To address is sent.
- HTML messages are sent as HTML, with the plain-text alternative included when WordPress provides one. Other messages are sent as text.
- An attachment that cannot be read, or is empty, is skipped rather than failing the send.
- Inline images keep their `cid:` references.
- The API call has a 30 second timeout.

## Updates

The plugin updates itself from GitHub releases using the [plugin-update-checker](https://github.com/YahnisElsts/plugin-update-checker) library. New versions show up in the normal WordPress update screens, and the update downloads the `cloudflare-email.zip` asset from the release rather than GitHub's source archive. That asset is the one with the dependencies and the built log viewer inside. Releases are cut from the repository's `main` branch through Release Please, which tags the version and attaches the zip.

## Troubleshooting

For errors that span platforms, such as sender domains, token errors and Cloudflare limits, see [Troubleshooting](../troubleshooting.md).

- **Mail still goes out the old way.** The plugin only intercepts mail when both required constants are non-empty. Run `wp cloudflare-email verify`. If it says the plugin is not configured, check that the constants are in `wp-config.php` and spelled exactly as shown.
- **A send is logged as failed.** Open the entry with **View** and read the error. It is Cloudflare's own message, prefixed with `Cloudflare API error` and the HTTP status. The usual causes are a From domain that is not onboarded to Email Sending (set `CLOUDFLARE_EMAIL_FROM` to an address on one that is), an invalid token or one without permission (run `wp cloudflare-email verify`), or a custom header Cloudflare rejected (remove it with the `cloudflare_email_payload` filter). A network error, such as a blocked outbound HTTPS connection, appears in the log as the underlying WordPress HTTP error message.
- **A plugin error about missing dependencies.** You installed from source or a repository archive. Reinstall from the release zip.
- **The log viewer shows an error about missing assets.** The built viewer files in `build/` are missing. Reinstall from the release zip.
- **Entries disappear sooner than expected.** The default retention is 30 days. Set `CLOUDFLARE_EMAIL_LOG_RETENTION_DAYS` to a larger number, or `0` to keep entries forever.
- **Successful sends are missing from the log.** Check whether `CLOUDFLARE_EMAIL_LOG` is set to `false`. Only failures are recorded in that mode.

## Related

- [Adapters overview](README.md): the steps shared by every adapter.
- [How the suite works](../how-it-works.md): the architecture and its limits.
- The plugin's own [README](https://github.com/Avunu/wordpress-cloudflare-email#readme), the authority for its current version.
