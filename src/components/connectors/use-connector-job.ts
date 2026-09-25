"use client";
import { useCallback, useEffect, useRef, useState } from "react";

export type ConnectorJobState = "idle" | "running" | "done" | "timeout" | "failed";

/** Poll interval and give-up timeouts (spec §4.5 — 2s; connection test 90s, OAuth 6min). */
export const CONNECTOR_POLL_INTERVAL_MS = 2000;
export const CONNECTOR_TEST_TIMEOUT_MS = 90_000;
export const CONNECTOR_OAUTH_TIMEOUT_MS = 360_000;

/**
 * Repeats `poll` every `intervalMs` until it reports `done` or `timeoutMs` elapses. On unmount or
 * a new `start`, the previous run is discarded by generation number — a closed modal or another
 * NPC's result never overwrites the screen. A thrown `poll` ends the run as `failed`; the caller
 * keeps its own error.
 */
export function useConnectorJob(opts: { intervalMs?: number; timeoutMs: number }) {
  const interval = opts.intervalMs ?? CONNECTOR_POLL_INTERVAL_MS;
  const timeout = opts.timeoutMs;
  const [state, setState] = useState<ConnectorJobState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  const generation = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current += 1;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const stop = useCallback(() => {
    generation.current += 1;
    if (timer.current) clearTimeout(timer.current);
    if (alive.current) setState("idle");
  }, []);

  const start = useCallback(
    (poll: () => Promise<{ done: boolean }>) => {
      const gen = ++generation.current;
      const current = () => alive.current && gen === generation.current;
      if (timer.current) clearTimeout(timer.current);
      setState("running");
      const deadline = Date.now() + timeout;
      const tick = async () => {
        if (!current()) return;
        if (Date.now() > deadline) {
          setState("timeout");
          return;
        }
        try {
          const { done } = await poll();
          if (!current()) return;
          if (done) {
            setState("done");
            return;
          }
        } catch {
          if (current()) setState("failed");
          return;
        }
        timer.current = setTimeout(() => void tick(), interval);
      };
      void tick();
    },
    [interval, timeout],
  );

  return { state, start, stop };
}
