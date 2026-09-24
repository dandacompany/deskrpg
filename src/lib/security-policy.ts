// Pure policy values shared by the client and server.
// **Don't import a server-only module like `node:crypto` here** —
// a `"use client"` page pulls this file's constants in, so it lands directly in the client bundle.
// Anything that needs random numbers lives in `invite-code.ts`.

export const ACCOUNT_PASSWORD_MIN_LENGTH = 8;
export const CHANNEL_PASSWORD_MIN_LENGTH = 8;

export function isAccountPasswordValid(password: string): boolean {
  return password.length >= ACCOUNT_PASSWORD_MIN_LENGTH;
}

export function isChannelPasswordValid(password: string): boolean {
  return password.length >= CHANNEL_PASSWORD_MIN_LENGTH;
}
