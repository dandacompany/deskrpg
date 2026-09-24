/**
 * The pure model for `ProviderAuthPanel` — the OAuth device login state machine, polling
 * interval, and link validation.
 *
 * Why this is kept apart from the screen: state must never be resurrected when a polling
 * response arrives late, after cancel or unmount. That rule (ignore poll/started events
 * received when not waiting) is pinned down here.
 */
import type { OAuthPollPayload } from "@/lib/hermes/plugin-client-types";

export type OAuthState =
  | { kind: "idle" }
  | { kind: "starting" }
  | {
      kind: "waiting";
      sessionId: string;
      userCode: string;
      verificationUrl: string;
      expiresAt: number; // epoch ms
    }
  | { kind: "done" }
  | { kind: "failed"; errorCode: string };

export type OAuthEvent =
  | { type: "start" }
  | {
      type: "started";
      sessionId: string;
      userCode: string;
      verificationUrl: string;
      expiresIn: number; // seconds
      now: number; // epoch ms
    }
  | { type: "poll"; status: OAuthPollPayload["status"]; error: string | null }
  | { type: "cancel" }
  | { type: "fail"; errorCode: string };

/** Poll status -> the panel's own error code. Codes are registered in `error-codes.ts` and localized. */
const POLL_FAILURE_CODES: Partial<Record<OAuthPollPayload["status"], string>> = {
  denied: "oauth_denied",
  expired: "oauth_expired",
  error: "oauth_error",
};

export function oauthReducer(state: OAuthState, event: OAuthEvent): OAuthState {
  switch (event.type) {
    case "start":
      return { kind: "starting" };
    case "started":
      if (state.kind !== "starting") return state;
      return {
        kind: "waiting",
        sessionId: event.sessionId,
        userCode: event.userCode,
        verificationUrl: event.verificationUrl,
        expiresAt: event.now + event.expiresIn * 1000,
      };
    case "poll": {
      if (state.kind !== "waiting") return state;
      if (event.status === "approved") return { kind: "done" };
      const errorCode = POLL_FAILURE_CODES[event.status];
      return errorCode ? { kind: "failed", errorCode } : state;
    }
    case "cancel":
      return { kind: "idle" };
    case "fail":
      if (state.kind !== "starting" && state.kind !== "waiting") return state;
      return { kind: "failed", errorCode: event.errorCode };
  }
}

const DEFAULT_POLL_MS = 2500;
const MIN_POLL_MS = 2000;

/** Plugin-supplied polling interval (seconds) -> wait ms. Falls back to 2.5s if missing or not a number, minimum 2s. */
export function pollDelayMs(pollInterval: number | undefined | null): number {
  if (typeof pollInterval !== "number" || !Number.isFinite(pollInterval)) return DEFAULT_POLL_MS;
  return Math.max(MIN_POLL_MS, pollInterval * 1000);
}

/** Only http(s) links are opened by the user — a scheme like `javascript:` never ends up in href. */
export function isSafeHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}
