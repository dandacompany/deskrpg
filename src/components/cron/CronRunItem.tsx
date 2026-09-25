"use client";

import { useState } from "react";

import type { CronRun } from "@/lib/hermes/deskrpg-plugin-types";
import { useLocale, useT } from "@/lib/i18n";

import { formatLocalDateTime } from "./cron-schedule";

const STATUS_KEYS: Record<string, string> = {
  ok: "cron.runs.status.ok",
  error: "cron.runs.status.error",
  running: "cron.runs.status.running",
};

/**
 * One run-history row: when it ran, how it ended and what it produced. The result is folded to a
 * few lines and opens in place — before, only the session title showed and the result lived in the
 * chat notice alone. A run with no result body says where the result went instead.
 */
export default function CronRunItem({ run }: { run: CronRun }) {
  const t = useT();
  const { locale } = useLocale();
  const [open, setOpen] = useState(false);
  const result = run.result_text.trim();
  const statusKey = STATUS_KEYS[run.status] ?? "cron.runs.status.unknown";

  return (
    <li
      role="listitem"
      data-testid="cron-run"
      className="p-2 rounded bg-surface border border-border"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px]">{formatLocalDateTime(run.started_at, locale)}</span>
        <span
          data-status={run.status}
          className={`text-[10px] px-1.5 py-0.5 rounded ${
            run.status === "error"
              ? "bg-danger/10 text-danger"
              : "bg-surface-raised text-text-muted"
          }`}
        >
          {t(statusKey)}
        </span>
      </div>
      {run.summary && <p className="mt-0.5 text-[11px] text-text-dim break-words">{run.summary}</p>}
      {result ? (
        <>
          <p
            data-testid="cron-run-result"
            className={`mt-1 text-text whitespace-pre-wrap break-words ${
              open ? "max-h-80 overflow-y-auto" : "line-clamp-3"
            }`}
          >
            {result}
          </p>
          <button
            type="button"
            data-testid="cron-run-toggle"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="mt-1 text-[11px] text-primary hover:underline"
          >
            {open ? t("cron.runs.collapse") : t("cron.runs.expand")}
          </button>
        </>
      ) : (
        run.status !== "running" && (
          <p className="mt-1 text-[11px] text-text-dim">{t("cron.runs.noResult")}</p>
        )
      )}
    </li>
  );
}
