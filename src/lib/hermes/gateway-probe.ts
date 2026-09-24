import { transportFetch } from "./setup/transport";
/**
 * Gateway-level reachability probe.
 *
 * In Hermes, auth applies at profile scope (named profiles fail closed and require their own
 * API_SERVER_KEY), so all that can be checked at the gateway level is
 * "is a Hermes API Server up at this address". Whether the token is right is checked by the profile
 * test (validateHermesProfile) — not duplicated here.
 *
 * **`/health` alone is not enough.** That endpoint is unauthenticated, and the Hermes dashboard
 * also returns 200. The dashboard is an SPA that returns 200 + HTML for any path via catch-all, so
 * status codes alone can't distinguish it from the real API Server — confirmed by measurement:
 *
 *     API Server (8643)  /health 200 · /v1/models 401 application/json
 *     dashboard  (9119)  /health 200 · /v1/models 200 text/html
 *
 * So we poke `/v1/models` once more and decide by **whether the content-type is JSON**.
 * No token needed — the real API Server rejects unauthenticated requests with JSON.
 */
export type GatewayProbeResult =
  | { kind: "hermes"; status: number }
  /** The response is Hermes but not the API Server (dashboard etc.). What to fix is the port, not the token. */
  | { kind: "dashboard"; status: number }
  | { kind: "not-hermes"; status: number }
  | { kind: "unreachable"; error: string };

// This was 8 seconds and was raised to 25 after measurement. `/health` is a handler returning a constant
// (api_server.py:2999-3001) so it seems like it'd be fast, but a multiplexing gateway carries every served
// profile's platforms in one process. If one of them locks up with synchronous blocking
// (measured: IMAP adapters of several profiles timing out at 30 seconds each), the event loop stalls and
// even returning a constant is delayed. At 8 seconds that was misjudged as "the gateway is dead".
// 25 seconds has no effect on healthy gateways (a few ms), and gives slow gateways enough time
// not to be called dead.
const DEFAULT_TIMEOUT_MS = 25000;

export async function probeHermesGateway(
  baseUrl: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; profile?: string } = {},
): Promise<GatewayProbeResult> {
  const fetchImpl = opts.fetchImpl ?? transportFetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = baseUrl.replace(/\/+$/, "");
  // Profile scope is the /p/<name>/ prefix. The name is encoded — there is a path (remote validation)
  // where names that haven't passed validation come in as-is.
  const prefix = opts.profile ? `${base}/p/${encodeURIComponent(opts.profile)}` : base;
  const url = `${prefix}/health`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const health = await fetchImpl(url, { method: "GET", signal: controller.signal });
    if (!health.ok) return { kind: "not-hermes", status: health.status };

    // From here is where the dashboard and the API Server are told apart (see comment above).
    const models = await fetchImpl(`${prefix}/v1/models`, {
      method: "GET",
      signal: controller.signal,
    });
    const contentType = models.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("json")) {
      return { kind: "dashboard", status: models.status };
    }
    return { kind: "hermes", status: health.status };
  } catch (err) {
    // AbortError also lands here — for the caller there's no benefit in distinguishing it from "couldn't reach".
    return { kind: "unreachable", error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
