"use client";

import { useCallback, useState } from "react";

import { classifyGateFailure, type GateBlocker, type GateFailure } from "@/lib/gate-failure";

/**
 * Holds a single gate failure as screen state. For Kanban/artifacts, where callers are
 * scattered — cron catches it through a single channel (`cron-api.ts`), so it doesn't use this hook.
 */
export function useGateBlocker() {
  const [blocker, setBlocker] = useState<GateBlocker | null>(null);

  const show = useCallback((failure: GateFailure) => {
    setBlocker(classifyGateFailure(failure));
  }, []);

  /** Accepts an error object with status/code as-is. Falls through to `other` if the shape differs. */
  const showFromError = useCallback((err: unknown) => {
    const shape = err as {
      status?: unknown;
      code?: unknown;
      message?: unknown;
      minVersion?: unknown;
    };
    setBlocker(
      classifyGateFailure({
        status: typeof shape?.status === "number" ? shape.status : 0,
        code: typeof shape?.code === "string" ? shape.code : "unknown",
        message: typeof shape?.message === "string" ? shape.message : "",
        minVersion: typeof shape?.minVersion === "string" ? shape.minVersion : undefined,
      }),
    );
  }, []);

  const clear = useCallback(() => setBlocker(null), []);

  return { blocker, show, showFromError, clear };
}
