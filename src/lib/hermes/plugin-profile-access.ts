/**
 * Picks the token to use for profile-scoped calls.
 *
 * **Never falls back to the default key.** Sending the default key to a profile-scoped path (`/p/{name}/...`)
 * makes Hermes fail closed with 401. The screen then shows
 * "the token is wrong", while the real cause is "this profile is not registered
 * with DeskRPG" — a diagnosis the user could never fix.
 */

export type ProfileTokenResult =
  { ok: true; profileToken: string } | { ok: false; reason: "no_profile" };

export function selectProfileToken(input: {
  rows: Array<{ profileName: string; tokenEncrypted: string }>;
  profileName: string;
  decrypt: (payload: string) => string;
}): ProfileTokenResult {
  const row = input.rows.find((r) => r.profileName === input.profileName);
  if (!row) return { ok: false, reason: "no_profile" };
  try {
    return { ok: true, profileToken: input.decrypt(row.tokenEncrypted) };
  } catch {
    // The key changed or the record is corrupted. Throwing would send a 500 and lose the diagnosis.
    return { ok: false, reason: "no_profile" };
  }
}
