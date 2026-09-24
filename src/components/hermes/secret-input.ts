/**
 * Attributes attached to every API key input field — so a password manager doesn't mistake
 * this field for a "login."
 *
 * With only `type="password"` and `autoComplete="off"`, Bitwarden/1Password/Chrome see the
 * form submission as a login and offer "save/update login" (observed in staging 2026-09-19
 * — accepting it overwrites this site's password with the API key). `new-password` is the
 * standard hint that excludes a field from save suggestions, and the rest are per-manager
 * ignore flags.
 */
export const SECRET_INPUT_PROPS = {
  type: "password",
  autoComplete: "new-password",
  spellCheck: false,
  "data-bwignore": "true",
  "data-1p-ignore": "true",
  "data-lpignore": "true",
  "data-form-type": "other",
} as const;
