/** Hermes rejects profile-scoped keys under 16 chars (hermes_cli.auth.has_usable_secret). */
const MIN_TOKEN_LENGTH = 16;
const PROFILE_NAME_RE = /^[A-Za-z0-9._-]+$/;

export type RegistrationValidation =
  | { ok: true; profileName: string; token: string }
  | { ok: false; errorCode: "invalid_profile_name" | "invalid_token" };

export function validateProfileRegistration(input: {
  profileName?: unknown;
  token?: unknown;
}): RegistrationValidation {
  const profileName = typeof input.profileName === "string" ? input.profileName.trim() : "";
  const token = typeof input.token === "string" ? input.token.trim() : "";

  if (!profileName || !PROFILE_NAME_RE.test(profileName)) {
    return { ok: false, errorCode: "invalid_profile_name" };
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    return { ok: false, errorCode: "invalid_token" };
  }
  return { ok: true, profileName, token };
}
