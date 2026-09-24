/**
 * SSRF guard for the link-preview proxy.
 *
 * A preview requires **the server** to read someone else's site. At that moment the server
 * becomes a tool that sends a request to whatever address the user gives it, so without a
 * block, any logged-in user could read internal-network or cloud metadata
 * (`169.254.169.254`) through our server.
 *
 * Blocked in three layers.
 *   1. The address itself — http(s) only, no credentials, standard ports only, reject if
 *      the host is a private-IP literal.
 *   2. The name-resolution result — check **every** address DNS returns (DNS rebinding).
 *   3. Redirects — follow manually, re-checking 1 and 2 at every hop (`fetchGuarded`).
 *
 * Why 1 and 2 are split: 1 is a pure function so testing it is cheap, while 2 is I/O and
 * slow. Having only one of them is a hole — with only 1, `internal.example.com` can still
 * resolve to 10.x; with only 2, `file://` or a non-standard port would go straight through.
 */
import { isIPv4, isIPv6 } from "node:net";

const ALLOWED_PORTS = new Set(["", "80", "443"]);

/** The octet array if this is a dotted-quad IPv4 string, else null. */
function ipv4Octets(host: string): number[] | null {
  if (!isIPv4(host)) return null;
  return host.split(".").map(Number);
}

/**
 * Expands an IPv6 string into 16 bytes. null if it can't be parsed.
 *
 * Judging IPv6 with a string regex will always be beaten — the WHATWG URL parser
 * normalizes `[::ffff:127.0.0.1]` into its **hex form** `[::ffff:7f00:1]`
 * (measured 2026-09-20: in that form, loopback, private networks, and 169.254 all got
 * through). Don't compare notations — expand to bytes and judge those.
 */
function ipv6Bytes(host: string): Uint8Array | null {
  if (!isIPv6(host)) return null;
  let text = host;
  // A form with a dotted-quad IPv4 tail (`::ffff:127.0.0.1`) is converted to two hex groups.
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (tail) {
    const v4 = ipv4Octets(tail[1]);
    if (!v4) return null;
    const hex = `${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
    text = text.slice(0, tail.index) + hex;
  }
  const [left, right, ...extra] = text.split("::");
  if (extra.length > 0) return null;
  const head = left ? left.split(":") : [];
  const tailGroups = right === undefined ? [] : right ? right.split(":") : [];
  const fill = 8 - head.length - tailGroups.length;
  if (right === undefined ? head.length !== 8 : fill < 0) return null;
  const groups = right === undefined ? head : [...head, ...Array(fill).fill("0"), ...tailGroups];

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const value = Number.parseInt(groups[i] || "0", 16);
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) return null;
    bytes[i * 2] = value >> 8;
    bytes[i * 2 + 1] = value & 0xff;
  }
  return bytes;
}

/** IPv4 is judged with a blocklist — the public range is far larger, so the list is short. */
function isBlockedIpv4(octets: number[]): boolean {
  const [a, b, c] = octets;
  if (a === 0 || a === 127 || a === 10) return true; // this host · loopback · private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local (cloud metadata)
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF protocol assignment · documentation
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // documentation
  if (a === 203 && b === 0 && c === 113) return true; // documentation
  if (a >= 224) return true; // multicast · reserved · broadcast
  return false;
}

/** Do the first `bits` bits match the prefix? */
function hasPrefix(bytes: Uint8Array, prefix: number[], bits: number): boolean {
  for (let i = 0; i < bits; i++) {
    const bit = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
    const want = (prefix[i >> 3] >> (7 - (i & 7))) & 1;
    if (bit !== want) return false;
  }
  return true;
}

/** The embedded IPv4 if this is an IPv6 range that carries one, else null. */
function embeddedIpv4(bytes: Uint8Array): number[] | null {
  const last4 = [bytes[12], bytes[13], bytes[14], bytes[15]];
  // ::ffff:0:0/96 (IPv4-mapped) · ::/96 (IPv4-compatible) · ::ffff:0:0:0/96 (IPv4-translated)
  const first10Zero = bytes.slice(0, 10).every((b) => b === 0);
  if (
    first10Zero &&
    ((bytes[10] === 0xff && bytes[11] === 0xff) || (bytes[10] === 0 && bytes[11] === 0))
  ) {
    return last4;
  }
  if (bytes.slice(0, 8).every((b) => b === 0) && bytes[8] === 0xff && bytes[9] === 0xff)
    return last4;
  // 64:ff9b::/96 · 64:ff9b:1::/48 (NAT64)
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b)
    return last4;
  // 2002::/16 (6to4) — the embedded v4 is the real destination.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return [bytes[2], bytes[3], bytes[4], bytes[5]];
  return null;
}

/**
 * IPv6 is judged with an **allowlist** — a blocklist gets beaten every time a new notation
 * shows up. Only global unicast (`2000::/3`) is let through, and within that, ranges that
 * carry a v4 or are for special use are separately excluded.
 */
function isBlockedIpv6(bytes: Uint8Array): boolean {
  const v4 = embeddedIpv4(bytes);
  if (v4) return isBlockedIpv4(v4);
  if (!hasPrefix(bytes, [0x20], 3)) return true; // anything outside 2000::/3 is blocked entirely
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return true; // 2001::/32 Teredo
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true; // 2001:db8::/32 documentation
  return false;
}

/**
 * Should we not go out to this address? Takes only IP strings (hostnames are resolved
 * before being passed in). A string that can't be judged is **blocked** — letting the
 * unknown through is the riskier choice.
 */
export function isBlockedAddress(address: string): boolean {
  let host = address.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  // A scope identifier (`fe80::1%en0`) is not part of the address — strip it before judging.
  const percent = host.indexOf("%");
  if (percent !== -1) host = host.slice(0, percent);
  if (!host) return true;

  const v4 = ipv4Octets(host);
  if (v4) return isBlockedIpv4(v4);

  const bytes = ipv6Bytes(host);
  if (bytes) return isBlockedIpv6(bytes);

  return true; // neither IPv4 nor IPv6 — an unresolved name
}

/**
 * Is this an address we may attempt to preview? If it passes, returns the normalized URL
 * (hash stripped). The resolution result of the hostname is not looked at here —
 * `fetchGuarded` handles that.
 */
/**
 * Checks shape only — http(s), no credentials, hash stripped. Doesn't look at where the
 * address and port actually point (`parsePreviewTarget` does that). Split out because
 * building a cache key needs normalization to happen before address judgment.
 */
export function normalizePreviewUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (!url.hostname) return null;
  url.hash = "";
  return url;
}

export function parsePreviewTarget(raw: string): URL | null {
  const url = normalizePreviewUrl(raw);
  if (!url) return null;
  // Standard ports only. Allowing arbitrary ports would turn the proxy into an internal-network port scanner.
  if (!ALLOWED_PORTS.has(url.port)) return null;

  let host = url.hostname.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!host) return null;
  // Judge right now if it arrived as an address rather than a name. `localhost` doesn't need to wait for resolution.
  if (host === "localhost" || host.endsWith(".localhost")) return null;
  // Judge right now if it arrived as an address rather than a name (an IPv6 literal arrives with the brackets stripped).
  const literal = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (isIPv4(literal) || isIPv6(literal)) {
    if (isBlockedAddress(literal)) return null;
  }
  return url;
}

/**
 * Is this an image type the proxy is allowed to return to the browser?
 *
 * Letting all of `image/*` through would also admit **SVG**. SVG is not an image but a
 * document — it can carry a `<script>`, and since it's opened from our origin
 * (`/api/link-preview/image`), that becomes XSS reaching our cookies and DOM. Preview
 * thumbnails don't need vector formats either, so only raster types are allowed through.
 */
const SAFE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
]);

export function isSafeImageType(contentType: string): boolean {
  const base = contentType.split(";")[0].trim().toLowerCase();
  return SAFE_IMAGE_TYPES.has(base);
}
