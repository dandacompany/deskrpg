/**
 * Streams a plugin byte response to the browser. The body stays a `ReadableStream` — not collected.
 * Only allowlisted headers are copied (so cookies/internal headers added in front of the gateway do not leak). Range
 * (206/416) keeps the status and `content-range` as-is. The token was used only on the request side and is not here (hard gate 2).
 *
 * `content-security-policy: sandbox` and `x-content-type-options: nosniff` are always enforced no matter what the
 * upstream sends — the last line of defense against inline-rendering user-uploaded HTML/SVG on the DeskRPG origin
 * while holding cookies (never trust the upstream).
 */
import { NextResponse } from "next/server";

import { cronError } from "@/lib/cron-access";
import type { RawPluginResponse } from "@/lib/hermes/plugin-client-types";

const PASS_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "content-disposition",
  "last-modified",
  "etag",
] as const;

export interface StreamProxyOptions {
  /** Always force download (for arbitrary user uploads like kanban attachments) — never allow inline. */
  forceAttachment?: boolean;
  /** Name to use in attachment when the upstream gives no filename parameter (RFC 6266 encoding). */
  filename?: string;
}

/** Changes only the type to attachment while preserving the existing disposition's filename parameter. */
function forceAttachmentDisposition(existing: string | null, filename: string | undefined): string {
  if (existing !== null) {
    const semiIdx = existing.indexOf(";");
    if (semiIdx !== -1) return `attachment${existing.slice(semiIdx)}`;
  }
  if (filename) return `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
  return "attachment";
}

export function streamProxyResponse(upstream: Response, opts?: StreamProxyOptions): Response {
  const headers = new Headers();
  for (const name of PASS_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set("content-security-policy", "sandbox");
  headers.set("x-content-type-options", "nosniff");
  headers.set("cache-control", "private, no-store");
  if (opts?.forceAttachment) {
    headers.set(
      "content-disposition",
      forceAttachmentDisposition(upstream.headers.get("content-disposition"), opts.filename),
    );
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

/** Same convention as `pluginFailureResponse` — the status is the plugin's; 503/504 when unreachable. */
export function rawFailureResponse(res: Extract<RawPluginResponse, { ok: false }>): NextResponse {
  const status = res.status > 0 ? res.status : res.failure.code === "timeout" ? 504 : 503;
  return cronError(status, res.failure.code, res.failure.message, res.failure.details);
}
