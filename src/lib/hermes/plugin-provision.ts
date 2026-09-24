import type { WorkerPluginCreateResult } from "./deskrpg-plugin-types";
/**
 * Profile provisioning — keys issued by the plugin are handled **only on the server**.
 *
 * The `POST /deskrpg/profiles` response carries the new profile's `API_SERVER_KEY` exactly
 * once (there's no way to look it up again). That value is encrypted and stored immediately and
 * removed from the body sent to the browser.
 *
 * Review verdict B: `registerHermesProfile` returns `{ error: "forbidden" }` **if the caller isn't
 * the gateway owner**. The route only checks `system_admin`, so
 * when a non-owner admin calls it the profile gets created but key storage can silently
 * fail — that result isn't swallowed but carried to the screen as `keyStored`.
 */

import type { CreateProfilePayload } from "./plugin-client";

export type SafeCreateResult = {
  name: string;
  keyIssued: boolean;
  keyError?: string;
  /** Worker plugin apply result — no secrets, so it's passed through (the hire-complete screen uses it for the
   * opt-in guidance). */
  workerPlugin?: WorkerPluginCreateResult;
};

/** Shape safe to send to the browser. Never includes `apiKey`. */
export function stripApiKey(payload: CreateProfilePayload): SafeCreateResult {
  const out: SafeCreateResult = { name: payload.name, keyIssued: payload.keyIssued };
  if (payload.keyError !== undefined) out.keyError = payload.keyError;
  const wp = payload.workerPlugin;
  if (wp && typeof wp === "object") {
    if ("skipped" in wp && wp.skipped === "propagation_disabled")
      out.workerPlugin = { skipped: wp.skipped };
    else if ("error" in wp && typeof wp.error === "string") out.workerPlugin = { error: wp.error };
    else if ("profile" in wp && typeof wp.profile === "string")
      out.workerPlugin = {
        profile: wp.profile,
        link: String(wp.link),
        enabled: String(wp.enabled),
      };
  }
  return out;
}

/**
 * Result of storing the issued key in our DB. `reason` is an **error code** — not a sentence.
 *
 * Final review M-3: this value is carried to the screen as `keyStoredError` and rendered. Previously
 * a Korean sentence was put here directly, out of line with the rest of this branch (`errorCode` + 4 locales),
 * so en/ja/zh users saw Korean. Now codes registered in `wizard-error-codes.ts`
 * (`key_missing_after_issue`/`key_store_forbidden`) are put in, and the screen translates them via that dictionary.
 */
export type KeyStorageResult = { ok: true } | { ok: false; reason: string };

export type ProvisionedProfile = SafeCreateResult & { keyStored: boolean; keyStoredError?: string };

/**
 * Adds whether storage succeeded on top of the `stripApiKey` result.
 *
 * If `stored` is `null`, no key was issued in the first place (`keyIssued: false`), meaning
 * storage wasn't attempted — in that case `keyError` already holds the reason,
 * so `keyStoredError` isn't filled separately.
 */
export function attachKeyStorage(
  safe: SafeCreateResult,
  stored: KeyStorageResult | null,
): ProvisionedProfile {
  if (stored === null) return { ...safe, keyStored: false };
  if (stored.ok) return { ...safe, keyStored: true };
  return { ...safe, keyStored: false, keyStoredError: stored.reason };
}
