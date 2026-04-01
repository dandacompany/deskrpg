/**
 * In-process RPC registry.
 *
 * When the socket server and Next.js run in the same process (dev), the socket
 * server registers a handler here. internalRpc() finds it and calls it directly
 * — no HTTP, no port dependency.
 *
 * In production the two servers are separate processes so the registry is empty
 * and internalRpc() falls back to HTTP (PORT+1, as server.js expects).
 */

type RpcHandler = (
  channelId: string,
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

const KEY = "__deskrpg_rpc_handler__";
const g = globalThis as typeof globalThis & Record<string, RpcHandler | undefined>;

export function registerRpcHandler(handler: RpcHandler): void {
  g[KEY] = handler;
}

export function getLocalRpcHandler(): RpcHandler | undefined {
  return g[KEY];
}
