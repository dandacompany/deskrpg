"use client";
import { useCallback, useEffect, useState } from "react";

import { useT } from "@/lib/i18n";
import type { CuratorStatus } from "@/lib/hermes/plugin-client-types";

import { skillErrorText } from "./skill-error-text";
import type { SkillsApi } from "./skills-api";
import { useSkillJob } from "./use-skill-job";

export type CuratorBarProps = {
  api: SkillsApi;
  canManage: boolean;
  /** The run job finished — the list may have changed via archive/merge. */
  onRunFinished?(): void;
  /** Job polling interval (ms). Shortened in tests. */
  pollIntervalMs?: number;
};

/**
 * The auto-curation (curator) line at the top of the modal — status, last run, threshold days.
 * The owner gets pause/resume and run now. Running it can archive/merge curation-target skills,
 * so it asks for confirmation first. If the status fetch fails, the line renders nothing.
 */
export default function CuratorBar({
  api,
  canManage,
  onRunFinished,
  pollIntervalMs,
}: CuratorBarProps) {
  const t = useT();
  const [st, setSt] = useState<CuratorStatus | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const job = useSkillJob(api, { intervalMs: pollIntervalMs });

  const load = useCallback(async () => {
    try {
      setSt(await api.curator());
    } catch {
      setSt(null);
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);

  const finished = job.state === "succeeded" || job.state === "failed" || job.state === "unknown";
  useEffect(() => {
    if (!finished) return;
    void load();
    onRunFinished?.();
    // The parent recreates onRunFinished on every render — call it only once, when the job finishes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finished, load]);

  if (!st) return null;

  const togglePause = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.setCuratorPaused(!st.paused);
      await load();
    } catch (e) {
      setError(skillErrorText(t, e));
    } finally {
      setBusy(false);
    }
  };
  const run = async () => {
    setAsking(false);
    await job.start("curator", () => api.runCurator());
  };

  const state = !st.enabled
    ? t("skills.curator.off")
    : st.paused
      ? t("skills.curator.paused")
      : t("skills.curator.on");

  return (
    <div className="flex flex-shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-5 py-1.5 text-xs text-text-muted">
      <span>
        {t("skills.curator.status", {
          state,
          last: st.lastRunAt ? st.lastRunAt.slice(0, 16).replace("T", " ") : "—",
          stale: st.staleAfterDays ?? "—",
          archive: st.archiveAfterDays ?? "—",
        })}
      </span>
      {canManage && (
        <>
          <button
            type="button"
            data-action="curator-pause"
            disabled={busy}
            className="text-primary disabled:opacity-50"
            onClick={() => void togglePause()}
          >
            {t(st.paused ? "skills.curator.resume" : "skills.curator.pause")}
          </button>
          <button
            type="button"
            data-action="curator-run"
            disabled={job.state === "running"}
            className="text-primary disabled:opacity-50"
            onClick={() => setAsking(true)}
          >
            {t("skills.curator.run")}
          </button>
        </>
      )}
      {asking && (
        <span className="flex items-center gap-2 text-text">
          {t("skills.curator.runConfirm")}
          <button
            type="button"
            data-action="curator-run-confirm"
            className="text-danger"
            onClick={() => void run()}
          >
            {t("common.confirm")}
          </button>
          <button type="button" className="text-text-muted" onClick={() => setAsking(false)}>
            {t("common.cancel")}
          </button>
        </span>
      )}
      {error && <span className="text-danger">{error}</span>}
      {job.state !== "idle" && (
        <span data-job-state={job.state} className="text-text">
          {t(`skills.job.${job.state}`)}
        </span>
      )}
      {job.state === "failed" && job.job?.outputTail && (
        <pre className="max-h-24 w-full overflow-auto whitespace-pre-wrap rounded bg-surface-raised p-2">
          {job.job.outputTail}
        </pre>
      )}
    </div>
  );
}
