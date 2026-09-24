import { safeReturnTo } from "@/lib/return-to";

/**
 * Turn `?returnTo=` into a link target the screen can use.
 *
 * Without a value, `null` — with nowhere to go back to, the link itself is not shown. With a value it
 * must pass through `safeReturnTo`. Kept inside page.tsx this one line could not be verified without
 * rendering, and nobody would see whether a value like `//evil.com` went out as a link.
 */
export function backLinkTarget(returnTo: string | null | undefined): string | null {
  return returnTo ? safeReturnTo(returnTo) : null;
}
