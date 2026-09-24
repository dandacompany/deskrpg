/**
 * The **source of truth** for profile-name syntax. Every place that builds a filesystem path or gateway URL
 * segment from a profile name imports this — it lives in `src/lib/` so that both the API route layer
 * (re-exported by `app/api/gateways/[id]/profiles/validation.ts`) and the library layer
 * (`local-profiles.ts`) can depend on it.
 *
 * It requires at least one alphanumeric character, so names made only of dots/dashes/underscores (e.g. "..")
 * do not pass. `HermesClient.url()` splices the name verbatim into the `/p/<name>/` path segment,
 * `encodeURIComponent` does not escape ".", and URL
 * normalization folds ".." into a traversal segment — the profile scope then silently
 * disappears and the request goes to the gateway's default profile route.
 *
 * Final review I2: this regex used to be copied into three files. If someone loosening the rule fixed only one
 * copy, a silent asymmetry would appear where registration passes but discovery/probing rejects.
 */
export const PROFILE_NAME_RE = /^[A-Za-z0-9._-]*[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidProfileName(name: string): boolean {
  return PROFILE_NAME_RE.test(name);
}
