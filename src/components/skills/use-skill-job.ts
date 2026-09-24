"use client";
import { useCallback, useEffect, useRef, useState } from "react";

import type { SkillJob } from "@/lib/hermes/plugin-client-types";

import { SkillsApiError, type SkillsApi } from "./skills-api";

export type SkillJobState = "idle" | "running" | "succeeded" | "failed" | "unknown" | "busy";

/** Poll interval and give-up timeout for install/update/curator-run jobs (design §4.4 — 2s, 5min). */
export const SKILL_JOB_INTERVAL_MS = 2000;
export const SKILL_JOB_TIMEOUT_MS = 300_000;

/**
 * Polls a plugin's async job (202 `{jobId}`) until it finishes. On unmount or starting a new job,
 * the previous poll is discarded by generation number — a closed modal or another employee's
 * result never overwrites the screen.
 * `busy` if starting returns 409 `job_busy`; `unknown` if polling returns 404 `job_unknown`
 * (gateway restarted) or the timeout is exceeded.
 */
export function useSkillJob(
  api: SkillsApi,
  opts: { intervalMs?: number; timeoutMs?: number } = {},
) {
  const interval = opts.intervalMs ?? SKILL_JOB_INTERVAL_MS;
  const timeout = opts.timeoutMs ?? SKILL_JOB_TIMEOUT_MS;
  const [job, setJob] = useState<SkillJob | null>(null);
  const [state, setState] = useState<SkillJobState>("idle");
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

  const start = useCallback(
    async (kind: "hub" | "curator", launch: () => Promise<string>) => {
      const gen = ++generation.current;
      const current = () => alive.current && gen === generation.current;
      if (timer.current) clearTimeout(timer.current);
      setJob(null);
      setState("running");
      let jobId: string;
      try {
        jobId = await launch();
      } catch (e) {
        if (current()) {
          setState(e instanceof SkillsApiError && e.code === "job_busy" ? "busy" : "failed");
        }
        return;
      }
      const deadline = Date.now() + timeout;
      const tick = async () => {
        if (!current()) return;
        try {
          const j = await api.job(kind, jobId);
          if (!current()) return;
          setJob(j);
          if (j.state !== "running") {
            setState(j.state);
            return;
          }
        } catch (e) {
          if (current()) {
            setState(
              e instanceof SkillsApiError && e.code === "job_unknown" ? "unknown" : "failed",
            );
          }
          return;
        }
        if (Date.now() > deadline) {
          setState("unknown");
          return;
        }
        timer.current = setTimeout(() => void tick(), interval);
      };
      await tick();
    },
    [api, interval, timeout],
  );

  return { job, state, start };
}
