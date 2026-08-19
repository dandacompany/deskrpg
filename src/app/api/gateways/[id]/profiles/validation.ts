/** Hermes rejects profile-scoped keys under 16 chars (hermes_cli.auth.has_usable_secret). */
const MIN_TOKEN_LENGTH = 16;
// Requires at least one alphanumeric character so dot/dash/underscore-only names (e.g.
// "..") can't slip through. HermesClient.url() interpolates the name unescaped-by-dots
// into a `/p/<name>/` path segment (encodeURIComponent doesn't escape "."), and URL
// normalization collapses ".." as a traversal segment — silently dropping the profile
// scope and sending the request to the gateway's default-profile route instead.
const PROFILE_NAME_RE = /^[A-Za-z0-9._-]*[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The single source of truth for "is this a syntactically legal profile name" —
 * every other caller that builds a filesystem path or a gateway URL segment out of a
 * profile name (local-discovery route, probe route, readProfileToken) must reuse this,
 * not redefine the pattern. */
export function isValidProfileName(name: string): boolean {
  return PROFILE_NAME_RE.test(name);
}

export type RegistrationValidation =
  | { ok: true; profileName: string; token: string }
  | { ok: false; errorCode: "invalid_profile_name" | "invalid_token" };

export function validateProfileRegistration(input: {
  profileName?: unknown;
  token?: unknown;
}): RegistrationValidation {
  const profileName =
    typeof input.profileName === "string" ? input.profileName.trim() : "";
  const token = typeof input.token === "string" ? input.token.trim() : "";

  if (!profileName || !isValidProfileName(profileName)) {
    return { ok: false, errorCode: "invalid_profile_name" };
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    return { ok: false, errorCode: "invalid_token" };
  }
  return { ok: true, profileName, token };
}
