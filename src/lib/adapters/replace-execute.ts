import type { NpcAdapter } from "./types";

/**
 * The same adapter with a different `execute`. Adapters are class instances, so spreading one would
 * drop its prototype methods (`abort`, `steer`, …) — each optional one is forwarded explicitly.
 */
export function replaceExecute(adapter: NpcAdapter, execute: NpcAdapter["execute"]): NpcAdapter {
  const wrapped: NpcAdapter = {
    type: adapter.type,
    execute,
    testConnection: (config) => adapter.testConnection(config),
  };
  if (adapter.abort) wrapped.abort = (sessionKey) => adapter.abort!(sessionKey);
  if (adapter.steer) wrapped.steer = (text) => adapter.steer!(text);
  if (adapter.getSessionSummary)
    wrapped.getSessionSummary = (sessionKey) => adapter.getSessionSummary!(sessionKey);
  if (adapter.resetSession)
    wrapped.resetSession = (sessionKey) => adapter.resetSession!(sessionKey);
  if (adapter.getConfigSchema) wrapped.getConfigSchema = () => adapter.getConfigSchema!();
  return wrapped;
}
