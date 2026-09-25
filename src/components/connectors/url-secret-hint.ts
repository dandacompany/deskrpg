/** Covers token, key, apikey, api_key, secret, password, access_token, and auth (substring, any case). */
const SECRET_KEY = /token|key|secret|password|auth/i;

/**
 * True when a URL's query carries a non-empty value under a secret-looking name. Hermes logs
 * MCP HTTP request URLs with their query at INFO level, so such a value ends up in plain text
 * in the gateway log; the add form warns (without blocking) and points at the Bearer option.
 */
export function hasSecretQuery(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return false;
  }
  for (const [name, value] of parsed.searchParams) {
    if (value && SECRET_KEY.test(name)) return true;
  }
  return false;
}
