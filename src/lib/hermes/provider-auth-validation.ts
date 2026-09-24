/**
 * Input validation for the provider auth proxy routes (key PUT/DELETE, OAuth start/poll/cancel/disconnect).
 * The plugin is the authority on format — here we only check whether it's safe to put in the path
 * and the body shape.
 *
 * Error results never carry the input value (so key values don't leak into responses or logs).
 */

const AUTH_SEGMENT_RE = /^[A-Za-z0-9_.-]{1,128}$/;
// encodeURIComponent does not escape ".". If "." / ".." go into the path as-is,
// URL normalization collapses the scope of `/p/{name}/deskrpg/...` — segments made only of dots
// are rejected even if the regex allows them.
const DOTS_ONLY_RE = /^\.+$/;

export const PROVIDER_KEY_MAX_LENGTH = 1024;

/** Validates provider and sessionId path segments. */
export function validateAuthSegment(value: string): boolean {
  return typeof value === "string" && AUTH_SEGMENT_RE.test(value) && !DOTS_ONLY_RE.test(value);
}

export type KeyBodyResult = { ok: true; value: string } | { ok: false; errorCode: "bad_request" };

/** Accepts only a key PUT body `{ value: string }` (1–1024 chars). */
export function validateKeyBody(input: unknown): KeyBodyResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errorCode: "bad_request" };
  }
  const value = (input as { value?: unknown }).value;
  if (typeof value !== "string" || value.length < 1 || value.length > PROVIDER_KEY_MAX_LENGTH) {
    return { ok: false, errorCode: "bad_request" };
  }
  return { ok: true, value };
}

// 0.10.0 — tool provider selection body. The plugin only accepts that row's key names (we check shape only here).
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{0,127}$/;
const PROVIDER_NAME_MAX = 128;
const ENV_ENTRIES_MAX = 16;

export type ToolProviderBodyResult =
  | { ok: true; provider: string; env: Record<string, string> }
  | { ok: false; errorCode: "bad_request" };

/** Accepts only `{ provider: string, env?: { KEY: string } }`. Values are never put in errors. */
export function validateToolProviderBody(input: unknown): ToolProviderBodyResult {
  const bad = { ok: false, errorCode: "bad_request" } as const;
  if (typeof input !== "object" || input === null || Array.isArray(input)) return bad;
  const { provider, env } = input as { provider?: unknown; env?: unknown };
  if (
    typeof provider !== "string" ||
    provider.trim() === "" ||
    provider.length > PROVIDER_NAME_MAX
  ) {
    return bad;
  }
  const out: Record<string, string> = {};
  if (env !== undefined && env !== null) {
    if (typeof env !== "object" || Array.isArray(env)) return bad;
    const entries = Object.entries(env as Record<string, unknown>);
    if (entries.length > ENV_ENTRIES_MAX) return bad;
    for (const [key, value] of entries) {
      if (!ENV_KEY_RE.test(key)) return bad;
      if (typeof value !== "string" || value.length > PROVIDER_KEY_MAX_LENGTH) return bad;
      out[key] = value;
    }
  }
  return { ok: true, provider, env: out };
}
