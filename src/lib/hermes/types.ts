// Shapes returned by the Hermes API Server (gateway/platforms/api_server.py).

export type HermesCapabilities = {
  features: Record<string, unknown>;
  endpoints: Record<string, { method: string; path: string }>;
};

export type HermesRunEventName =
  | "run.started" | "message.started"
  // 회의 경로(/v1/runs)는 assistant.* 대신 message.* 를 쓴다 — 같은 서버, 다른 방언.
  | "assistant.delta" | "message.delta" | "tool.progress"
  | "tool.started" | "tool.completed" | "tool.failed"
  | "assistant.completed" | "message.completed"
  | "run.completed" | "run.cancelled" | "run.failed" | "error" | "done";

/** Every event payload carries these (api_server.py:_event_payload setdefault). */
export type HermesEventEnvelope = {
  run_id?: string;
  session_id?: string;
  seq?: number;
  ts?: number;
};

const TERMINAL = new Set(["run.completed", "run.cancelled", "run.failed", "error", "done"]);

export function isTerminalEvent(name: string): boolean {
  return TERMINAL.has(name);
}

/** Fail-closed: an unreachable /v1/capabilities disables the feature. */
export function readCapability(caps: HermesCapabilities | null, key: string): boolean {
  return caps?.features?.[key] === true;
}

const DEFAULT_MAX_CONCURRENT_RUNS = 4;

export function readMaxConcurrentRuns(caps: HermesCapabilities | null): number {
  const raw = caps?.features?.max_concurrent_runs;
  return typeof raw === "number" && raw > 0 ? raw : DEFAULT_MAX_CONCURRENT_RUNS;
}
