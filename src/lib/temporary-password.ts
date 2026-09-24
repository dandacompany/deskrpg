import { randomBytes } from "node:crypto";

/**
 * Server-only — pulls in `node:crypto`. It isn't kept next to `security-policy.ts` for the same
 * reason as `invite-code.ts`: that file is imported by a `"use client"` page for its constants.
 *
 * A temporary password issued by an admin or the CLI. The plaintext appears only once, in the
 * issuance response — it isn't stored or logged.
 */
export function generateTemporaryPassword(): string {
  // base64url of 16 bytes = 22 chars. Comfortably over the account minimum length (8 chars).
  return randomBytes(16).toString("base64url");
}
