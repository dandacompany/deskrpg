/**
 * Only lets paths on the same origin through. Blocks open redirects.
 *
 * Browsers read `//evil.com` and `/\evil.com` as a **protocol-relative URL** — letting
 * something through just because its first character is `/` sends the user off to
 * someone else's site. A value with an embedded newline is also blocked, since it can
 * split the response when it goes out as a header.
 *
 * A tab (U+0009) is blocked too. Because a browser's URL parser **strips** tabs and
 * newlines from a URL, `/\t/evil.com` would pass all three checks above and still be
 * read as `//evil.com`. The last line is belt-and-braces for that whole family: it
 * actually feeds the value into a URL parser and checks the origin comes out unchanged.
 */
export function safeReturnTo(value: string | null | undefined, fallback = "/channels"): string {
  if (!value) return fallback;
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return fallback;
  if (/[\r\n\t]/.test(value)) return fallback;
  try {
    if (new URL(value, "http://x").origin !== "http://x") return fallback;
  } catch {
    return fallback;
  }
  return value;
}
