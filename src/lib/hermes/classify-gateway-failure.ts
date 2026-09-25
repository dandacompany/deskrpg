import type { HermesErrorCode } from "./hermes-client";
import { runFailureCause, type RunFailureCause } from "../run-failure-cause";

/**
 * Folds an exception thrown by an adapter call into a **cause to show the user**.
 *
 * Previously, whether the gateway was down, the key was rejected, or there had been no response for 30 minutes,
 * the screen always showed the single line "AI 게이트웨이 오류". The real cause stayed only in the server console,
 * so even users self-hosting their own server couldn't tell what to fix.
 *
 * The order of checks is the rule:
 *   1. **Abort/timeout first.** `HermesClient.request` wraps everything `fetch` throws as
 *      `HermesError("unreachable")` (the `catch` around `fetch` in `HermesClient.request`), so cancellations and timeouts also
 *      arrive as "couldn't reach". Looking only at the code would always misdiagnose a timeout as unreachable.
 *   2. **Structured code** (`HermesError.code`). Always takes precedence over string matching.
 *      A `run_failed` (the gateway accepted the run, then the model provider failed it) is read
 *      further by `runFailureCause` — an expired provider sign-in must not read as "unknown".
 *   3. Message/`cause.code` heuristics only last — needed because there are paths where the adapter throws
 *      something other than `HermesError` (plugin client, raw `fetch`).
 */
export type GatewayFailureKind = "unreachable" | "auth" | "timeout" | "unknown" | RunFailureCause;

/** Recognizes `HermesError` by structure — importing the class would drag in the transport layer. */
function hermesCode(err: unknown): HermesErrorCode | null {
  if (typeof err !== "object" || err === null) return null;
  const record = err as { name?: unknown; code?: unknown };
  if (record.name !== "HermesError") return null;
  return typeof record.code === "string" ? (record.code as HermesErrorCode) : null;
}

/** `TypeError: fetch failed` hides the real cause in `cause.code` (ECONNREFUSED etc.). */
function causeCode(err: unknown): string {
  if (typeof err !== "object" || err === null) return "";
  const cause = (err as { cause?: unknown }).cause;
  if (typeof cause !== "object" || cause === null) return "";
  const code = (cause as { code?: unknown }).code;
  return typeof code === "string" ? code.toUpperCase() : "";
}

function errorName(err: unknown): string {
  if (typeof err !== "object" || err === null) return "";
  const name = (err as { name?: unknown }).name;
  return typeof name === "string" ? name : "";
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "";
}

const TIMEOUT_CAUSE_CODES = new Set([
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);

const UNREACHABLE_CAUSE_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "UND_ERR_SOCKET",
]);

const TIMEOUT_MESSAGE_RE = /\b(timed? ?out|timeout|aborted|abort)\b/i;
const AUTH_MESSAGE_RE =
  /\b(unauthorized|forbidden|invalid[ _-]?(api[ _-]?)?key|auth(entication|orization)?[ _-]?(failed|error))\b/i;
const UNREACHABLE_MESSAGE_RE =
  /\b(fetch failed|econnrefused|enotfound|network|unreachable|connection refused)\b/i;

export function classifyGatewayFailure(err: unknown): GatewayFailureKind {
  const cause = causeCode(err);
  const name = errorName(err);
  const message = errorMessage(err);

  // 1. Abort/timeout — before the code check (see module comment).
  if (name === "AbortError" || name === "TimeoutError") return "timeout";
  if (TIMEOUT_CAUSE_CODES.has(cause)) return "timeout";

  // 2. Structured code.
  const code = hermesCode(err);
  if (code === "unauthorized") return "auth";
  if (code === "unreachable") {
    if (TIMEOUT_MESSAGE_RE.test(message)) return "timeout";
    return "unreachable";
  }
  if (code === "run_failed") return runFailureCause(message) ?? "unknown";
  if (code === "unknown_profile" || code === "http_error") return "unknown";

  // 3. Heuristics — the non-HermesError exception path.
  if (UNREACHABLE_CAUSE_CODES.has(cause)) return "unreachable";
  if (AUTH_MESSAGE_RE.test(message)) return "auth";
  if (TIMEOUT_MESSAGE_RE.test(message)) return "timeout";
  if (UNREACHABLE_MESSAGE_RE.test(message)) return "unreachable";

  return "unknown";
}

/** Maps the classification result to the message code carried by `npc:response`. */
export const GATEWAY_FAILURE_MESSAGE_CODE = {
  unreachable: "gateway_unreachable",
  auth: "gateway_auth_failed",
  timeout: "gateway_timeout",
  unknown: "gateway_unknown_error",
  provider_auth: "provider_auth_expired",
  usage_limit: "provider_usage_limit",
  model_error: "provider_model_error",
} as const;

export type GatewayFailureMessageCode = (typeof GATEWAY_FAILURE_MESSAGE_CODE)[GatewayFailureKind];

export function gatewayFailureMessageCode(err: unknown): GatewayFailureMessageCode {
  return GATEWAY_FAILURE_MESSAGE_CODE[classifyGatewayFailure(err)];
}
