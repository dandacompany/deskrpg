export type GatewayRuntimeStatus =
  | "unbound"
  | "valid"
  | "pairing_required"
  | "forbidden"
  | "unreachable"
  | "error";

export interface GatewayRuntimeState {
  gatewayId: string;
  status: GatewayRuntimeStatus;
  checkedAt: number;
  expiresAt: number;
  requestId?: string | null;
  error?: string | null;
  details?: unknown;
}

const runtimeCache = new Map<string, GatewayRuntimeState>();

function getTtlMs(status: GatewayRuntimeStatus) {
  switch (status) {
    case "valid":
      return 60_000;
    case "pairing_required":
      return 30_000;
    case "forbidden":
      return 60_000;
    case "unreachable":
      return 15_000;
    case "error":
      return 15_000;
    case "unbound":
    default:
      return 5_000;
  }
}

export function getCachedGatewayRuntimeState(gatewayId: string) {
  const cached = runtimeCache.get(gatewayId);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    runtimeCache.delete(gatewayId);
    return null;
  }
  return cached;
}

export function setGatewayRuntimeState(
  gatewayId: string,
  input: Omit<GatewayRuntimeState, "gatewayId" | "checkedAt" | "expiresAt"> & { ttlMs?: number },
) {
  const checkedAt = Date.now();
  const ttlMs = input.ttlMs ?? getTtlMs(input.status);
  const state: GatewayRuntimeState = {
    gatewayId,
    status: input.status,
    checkedAt,
    expiresAt: checkedAt + ttlMs,
    requestId: input.requestId ?? null,
    error: input.error ?? null,
    details: input.details,
  };
  runtimeCache.set(gatewayId, state);
  return state;
}

export function invalidateGatewayRuntimeState(gatewayId: string) {
  runtimeCache.delete(gatewayId);
}

