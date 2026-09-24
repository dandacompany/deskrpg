/**
 * The URL of the Hermes dashboard screen for logging in **as that profile**.
 *
 * Hermes logs in per NPC (profile) — since upstream #111724, profiles no longer inherit default's `auth.json`.
 * The dashboard picks the managed profile via `?profile=<name>`, so sending that value to the Keys screen (`/env`)
 * means the user doesn't have to change the top selector separately.
 *
 * Imported by client components — does not depend on server-only modules.
 */
export function profileLoginUrl(
  dashboardUrl: string | null | undefined,
  profile: string,
): string | null {
  if (!dashboardUrl || !profile) return null;
  let url: URL;
  try {
    url = new URL(dashboardUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const base = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  return `${base}/env?profile=${encodeURIComponent(profile)}`;
}
