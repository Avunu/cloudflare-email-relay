// ---------------------------------------------------------------------------
// The one piece of Worker-level configuration: the ops token. Everything that
// concerns a tenant is in the tenant table and the tenant's own secret
// (tenant-schema.ts / tenants.ts).
// ---------------------------------------------------------------------------

/** Anything shorter is a typo or a test value, not a credential. */
const MIN_OPS_TOKEN_CHARS = 32;

/**
 * The ops token, or null when the API is disabled. Wrangler has no way to express "unset" in a
 * `.dev.vars` file or a dashboard form other than leaving the value blank, so blank means unset —
 * the API answers 404 rather than opening itself to the empty bearer token. A token that is too
 * short to be a credential is treated the same way (and logged by the caller), so a truncated paste
 * never protects a production relay with eight characters.
 */
export function opsTokenOf(env: { OPS_TOKEN?: string | undefined }): string | null {
	const value = env.OPS_TOKEN;
	if (typeof value !== "string") {
		return null;
	}
	const token = value.trim();
	return token.length >= MIN_OPS_TOKEN_CHARS ? token : null;
}
