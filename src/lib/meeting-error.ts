// Normalizes an NPC response failure during a meeting into the shape sent out over the
// socket.
// The broker's onError passes through whatever value the adapter threw as-is (HermesError,
// Error, an arbitrary object), and shipping that as-is would render the screen as
// `meeting: [object Object]`. At the server boundary it's converted into a string code and
// a short human-readable reason, and the client never uses a non-string value as the code.
//
// This file is also bundled into the browser, so hermes-client isn't imported — HermesError
// is instead recognized by its name/code/status shape.

export type MeetingFailureCode =
  | "backend_usage_limit"
  | "gateway_busy"
  | "backend_unavailable"
  | "backend_unauthorized"
  | "npc_response_failed";

export type MeetingFailure = { error: MeetingFailureCode; detail: string | null };

const DETAIL_MAX = 160;

// The model provider's account/billing limit. What the user needs to do differs from the
// gateway's concurrent-run limit (HTTP 429).
const USAGE_LIMIT = /\b429\b|usage limit|rate[ _-]?limit|quota|insufficient[ _]credits?/i;

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function rawMessage(err: unknown): string | null {
  if (typeof err === "string") return err;
  const message = field(err, "message");
  if (typeof message === "string" && message) return message;
  return null;
}

function sanitize(text: string | null): string | null {
  if (!text) return null;
  const oneLine = text
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  if (!oneLine) return null;
  return oneLine.length > DETAIL_MAX ? `${oneLine.slice(0, DETAIL_MAX - 1)}…` : oneLine;
}

export function describeMeetingFailure(err: unknown): MeetingFailure {
  const detail = sanitize(rawMessage(err));
  const code = field(err, "code");
  const status = field(err, "status");

  let error: MeetingFailureCode = "npc_response_failed";
  if (code === "run_failed" && detail && USAGE_LIMIT.test(detail)) error = "backend_usage_limit";
  else if (status === 429) error = "gateway_busy";
  else if (code === "unreachable") error = "backend_unavailable";
  else if (code === "unauthorized") error = "backend_unauthorized";
  else if (!code && detail && USAGE_LIMIT.test(detail)) error = "backend_usage_limit";

  return { error, detail };
}

/** Uses the error field received over the socket as a code only when it's usable as one. */
export function meetingErrorCode(value: unknown): string {
  return typeof value === "string" && value ? value : "unknown";
}

/**
 * The phrase rendered in the meeting chat. A code with a translation gets translated; an old
 * string error with none ("Permission denied") is shown as-is. detail is only appended in
 * parentheses when it's a string.
 */
export function meetingErrorMessage(
  data: { error?: unknown; detail?: unknown },
  t: (key: string) => string,
): string {
  const code = meetingErrorCode(data.error);
  const key = `meeting.reason.${code}`;
  const translated = t(key);
  const reason = translated === key ? code : translated;
  const detail = typeof data.detail === "string" && data.detail ? data.detail : null;
  return detail ? `${reason} (${detail})` : reason;
}
