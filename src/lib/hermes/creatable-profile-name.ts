/**
 * Strict name grammar used only when **creating a new Hermes profile**.
 *
 * This file and `profile-name.ts` (`PROFILE_NAME_RE`) are different validators for different
 * flows — do not confuse them:
 *
 *   - `profile-name.ts` (lenient) — used when discovering/registering **already existing** profiles.
 *     Names with uppercase letters and dots that older Hermes allowed may already be on disk, so
 *     tightening it would silently reject such existing profiles on the registration screen.
 *   - `creatable-profile-name.ts` (this file, strict) — validates names to be **newly** created.
 *     They must be names the Hermes server actually accepts, so it follows the grammar the server
 *     requires exactly.
 *
 * Regex / reserved-name source (server source measured in review round 1):
 *   hermes_cli/profiles.py:51   _PROFILE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
 *   hermes_cli/profiles.py:265  _RESERVED_NAMES = {hermes, test, tmp, root, sudo}  ← rejected
 *                               ("default" passes as a special case on the server, but we never create a new
 *                                profile with that name, so here it is rejected along with the reserved names.)
 */

export const CREATABLE_PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const RESERVED_PROFILE_NAMES: ReadonlySet<string> = new Set([
  "hermes",
  "test",
  "tmp",
  "root",
  "sudo",
]);

export function isCreatableProfileName(name: string): boolean {
  if (name === "default") return false;
  if (RESERVED_PROFILE_NAMES.has(name)) return false;
  return CREATABLE_PROFILE_NAME_RE.test(name);
}
