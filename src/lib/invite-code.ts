import { randomBytes } from "node:crypto";

/**
 * Server-only — it pulls in `node:crypto`.
 *
 * Split out of `security-policy.ts`. That file holds values a `"use client"` page imports
 * just for a single constant, so if this function lived in the same file, the client bundle
 * would end up referencing `node:crypto` too. The bundler currently strips unused imports,
 * but the same category of bug has already blanked out a screen once before
 * (`plugin-capability.ts` dragged in `@/db`, sending pg/better-sqlite3 to the browser). We
 * don't rely on luck here.
 */
export function generateChannelInviteCode(): string {
  return randomBytes(12).toString("base64url");
}
