/**
 * Parses the address a user pastes after approving an MCP OAuth request. Hermes pins the
 * redirect to a loopback URL, so the browser lands on a "can't connect" page whose address
 * bar still holds `?code=&state=`. Pure function — used by both the browser (instant
 * feedback) and the server (authoritative check).
 */
export type OAuthPasteResult =
  | { ok: true; code: string; state: string; iss?: string }
  | { ok: false; reason: "invalid" | "denied"; error?: string };

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function parseOAuthPaste(raw: string): OAuthPasteResult {
  const text = raw
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (
    url.protocol !== "http:" ||
    !LOOPBACK.has(url.hostname) ||
    url.pathname.replace(/\/$/, "") !== "/callback"
  ) {
    return { ok: false, reason: "invalid" };
  }
  const error = url.searchParams.get("error");
  if (error) return { ok: false, reason: "denied", error: error.slice(0, 100) };
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return { ok: false, reason: "invalid" };
  const iss = url.searchParams.get("iss");
  return iss ? { ok: true, code, state, iss } : { ok: true, code, state };
}
