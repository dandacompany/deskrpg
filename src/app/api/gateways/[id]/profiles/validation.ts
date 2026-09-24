import { isValidProfileName } from "@/lib/hermes/profile-name";

/** Hermes rejects profile-scoped keys under 16 chars (hermes_cli.auth.has_usable_secret). */
const MIN_TOKEN_LENGTH = 16;

/** The single source of truth for profile name grammar is `src/lib/hermes/profile-name.ts` — every place that turns
 * profile names into filesystem paths or gateway URL segments (the local-discovery
 * route, the probe route, readProfileToken) imports it. Here it is only re-exported
 * for existing callers. Do not copy the rules themselves here. */
export { isValidProfileName };

export type RegistrationValidation =
  | { ok: true; profileName: string; token: string }
  | { ok: false; errorCode: "invalid_profile_name" | "invalid_token" };

export function validateProfileRegistration(input: {
  profileName?: unknown;
  token?: unknown;
}): RegistrationValidation {
  const profileName = typeof input.profileName === "string" ? input.profileName.trim() : "";
  const token = typeof input.token === "string" ? input.token.trim() : "";

  if (!profileName || !isValidProfileName(profileName)) {
    return { ok: false, errorCode: "invalid_profile_name" };
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    return { ok: false, errorCode: "invalid_token" };
  }
  return { ok: true, profileName, token };
}
