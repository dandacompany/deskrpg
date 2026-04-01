import { getLocalRpcHandler } from "./rpc-registry";
import internalTransport from "./internal-transport.js";

const { buildInternalAuthHeaders, getInternalSocketBaseUrl } = internalTransport as {
  buildInternalAuthHeaders: () => Record<string, string>;
  getInternalSocketBaseUrl: () => string;
};

/**
 * Calls the OpenClaw gateway RPC.
 *
 * - Same process (dev): delegates to the in-process handler registered by
 *   dev-server.ts via registerRpcHandler(). No HTTP, no port dependency.
 * - Separate process (production): HTTP POST to server.js on PORT+1.
 */
export async function internalRpc(
  channelId: string,
  method: string,
  params: Record<string, unknown> = {},
) {
  const local = getLocalRpcHandler();
  if (local) return local(channelId, method, params);

  // Production fallback: server.js runs Socket.io on PORT+1
  const res = await fetch(`${getInternalSocketBaseUrl()}/_internal/rpc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...buildInternalAuthHeaders(),
    },
    body: JSON.stringify({ channelId, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json();
  if (!data.ok) {
    const message = typeof data.error === "string" ? data.error : `RPC ${method} failed`;
    const error = new Error(message) as Error & {
      errorCode?: string;
      code?: string;
      requestId?: string;
      details?: unknown;
    };
    if (typeof data.errorCode === "string") {
      error.errorCode = data.errorCode;
      error.code = data.errorCode;
    }
    if (typeof data.requestId === "string") {
      error.requestId = data.requestId;
    }
    if ("details" in data) {
      error.details = data.details;
    }
    throw error;
  }
  return data.result;
}

export function getUserId(req: { headers: { get: (name: string) => string | null } }): string | null {
  return req.headers.get("x-user-id");
}
