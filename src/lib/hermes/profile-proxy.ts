/**
 * The one place where the `/api/gateways/[id]/plugin/profiles/[name]/*` proxy moves upstream failures into the body.
 *
 * The convention for this route family is **HTTP 200 + `{errorCode}` + ERROR_CODE_HEADER** (`catalog/route.ts`).
 * Routes added in 0.9.0 return 404 on older plugins, and that means not "the profile doesn't exist" but
 * "the plugin must be upgraded", so the code is changed — a signal for the screen to fall back to text input.
 */
import { isMissingPluginRoute, PROFILE_PICKER_MIN_VERSION } from "./plugin-capability";
import { pluginUpgradeRequired, type PluginFailure } from "./plugin-errors";

/**
 * The 404 body the Hermes multiplex middleware returns for an unknown `/p/{profile}` (gateway/platforms/api_server.py
 * `profile_prefix_middleware`, 0.21.3 ~line 1513: `{"error":"Unknown or unconfigured profile"}`).
 * It is a response issued before reaching any plugin route, so it has no code. `mapPluginFailure` now names it
 * `profile_not_found` itself; this check still catches a failure folded into `upstream_error` + that sentence
 * elsewhere. Reading it as "no route" would tell the user to "upgrade the plugin" when the profile is missing.
 */
const HERMES_UNKNOWN_PROFILE_RE = /^unknown or unconfigured profile$/i;

function isHermesUnknownProfile(res: { status: number; failure: PluginFailure }): boolean {
  return (
    res.status === 404 &&
    res.failure.code === "upstream_error" &&
    HERMES_UNKNOWN_PROFILE_RE.test(res.failure.message.trim())
  );
}

export function proxyFailureBody(res: { status: number; failure: PluginFailure }): {
  body: Record<string, unknown>;
  errorCode: string;
} {
  if (isHermesUnknownProfile(res)) {
    return {
      errorCode: "profile_not_found",
      body: {
        errorCode: "profile_not_found",
        error: res.failure.message,
        upstreamStatus: res.status,
      },
    };
  }
  if (isMissingPluginRoute(res)) {
    const upgrade = pluginUpgradeRequired({
      ok: false,
      minVersion: PROFILE_PICKER_MIN_VERSION,
      reason: "missing_route",
    });
    return {
      errorCode: upgrade.code,
      body: {
        errorCode: upgrade.code,
        error: "",
        upstreamStatus: res.status,
        details: upgrade.details,
      },
    };
  }
  return {
    errorCode: res.failure.code,
    body: { errorCode: res.failure.code, error: res.failure.message, upstreamStatus: res.status },
  };
}
