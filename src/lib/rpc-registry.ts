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

type GatewayConfigUpdatedHandler = (channelId: string) => Promise<void> | void;

const KEY = "__deskrpg_rpc_handler__";
const GATEWAY_CONFIG_UPDATED_KEY = "__deskrpg_gateway_config_updated_handler__";
const g = globalThis as typeof globalThis & Record<string, RpcHandler | GatewayConfigUpdatedHandler | undefined>;

export function registerRpcHandler(handler: RpcHandler): void {
  g[KEY] = handler;
}

export function getLocalRpcHandler(): RpcHandler | undefined {
  return g[KEY];
}

export function registerGatewayConfigUpdatedHandler(handler: GatewayConfigUpdatedHandler): void {
  g[GATEWAY_CONFIG_UPDATED_KEY] = handler;
}

export function getGatewayConfigUpdatedHandler(): GatewayConfigUpdatedHandler | undefined {
  const handler = g[GATEWAY_CONFIG_UPDATED_KEY];
  return typeof handler === "function" ? handler as GatewayConfigUpdatedHandler : undefined;
}
