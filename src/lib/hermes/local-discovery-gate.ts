/**
 * Pure functions deciding whether local profile discovery is **allowed**.
 *
 * Spec §4 defines "when is it local" in two stages.
 *
 *   Stage 1  Is the URL host loopback?          127.0.0.1 / localhost / ::1 / 0.0.0.0
 *   Stage 2  Does the profile root actually exist?
 *
 * Final review C1: the implementation lacked stage 1. As a result any authenticated user
 * could create a gateway record with an arbitrary URL via `POST /api/gateways`, own it,
 * opt in, then read the `.env` keys under `~/.hermes` on the **host machine** and send those keys
 * as `Authorization: Bearer` to their own URL. Stage 1 is not a performance optimization but
 * a **security gate** cutting that leak vector — tokens only go to a real local Hermes.
 *
 * On top of this sits one more instance-level gate. A gateway record's `isOwner` only means
 * "this record is mine", not "this machine is mine". DeskRPG is a multi-user
 * virtual office, so only the **operator** should be able to consent to reading secrets on the
 * host filesystem. Default is off, and when off the feature appears **absent** rather than
 * as an error (the same `available: false` as a container with no profile root).
 */

/** Instance-level switch the operator must turn on. Default off. */
export const LOCAL_DISCOVERY_ENV_FLAG = "DESKRPG_LOCAL_DISCOVERY_ENABLED";

const TRUTHY = new Set(["1", "true", "yes", "on"]);

export function isLocalDiscoveryEnabled(env: Record<string, string | undefined>): boolean {
  const raw = (env[LOCAL_DISCOVERY_ENV_FLAG] || "").trim().toLowerCase();
  return TRUTHY.has(raw);
}

/**
 * Whether a host string is loopback. Takes the URL's `hostname` as-is — for IPv6
 * WHATWG URL returns it bracketed ("[::1]"), so the brackets are stripped here.
 */
export function isLoopbackHost(host: string): boolean {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  // FQDN forms with the root label attached, like "localhost.", point to the same place.
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (!h) return false;
  if (h === "localhost") return true;
  // IPv4 loopback is all of 127.0.0.0/8. 0.0.0.0 means "all interfaces of this machine" and
  // the spec explicitly treats it as local.
  if (h === "0.0.0.0") return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(h)) {
    return h.split(".").every((o) => Number(o) <= 255);
  }
  // IPv6: ::1, and the IPv4-mapped form (::ffff:127.0.0.1).
  if (h === "::1" || h === "::") return true;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  if (mapped) return isLoopbackHost(mapped[1]);
  return false;
}

/** Whether baseUrl points at this machine's loopback. Unparseable means not local. */
export function isLoopbackBaseUrl(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return isLoopbackHost(url.hostname);
}

/**
 * The combination of both gates that must pass **before** touching the filesystem.
 * If it doesn't pass, the caller doesn't even check whether the profile root exists.
 */
export function localDiscoveryAllowed(input: {
  env: Record<string, string | undefined>;
  baseUrl: string;
}): boolean {
  return isLocalDiscoveryEnabled(input.env) && isLoopbackBaseUrl(input.baseUrl);
}
