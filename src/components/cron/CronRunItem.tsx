"use client";

import { useLayoutEffect, useRef, useState } from "react";

import MarkdownContent from "@/components/ui/MarkdownContent";
import type { CronRun } from "@/lib/hermes/deskrpg-plugin-types";
import { useLocale, useT } from "@/lib/i18n";

import { isAutoRunTitle, runStatusKey } from "./cron-run-view";
import { formatLocalDateTime } from "./cron-schedule";

/**
 * One run-history row: when it ran, how it ended and what it produced. The result is rendered as
 * markdown like the chat's result notice, folded to a few lines, and the toggle appears only when
 * the folded text actually overflows. A run with no result body says where the result went instead.
 */
export default function CronRunItem({ run }: { run: CronRun }) {
  const t = useT();
  const { locale } = useLocale();
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const result = run.result_text.trim();

  // Measured folded: a one-line result used to offer "show all" that changed nothing.
  useLayoutEffect(() => {
    const el = body.current;
    if (!el || open) return;
    setOverflows(el.scrollHeight > el.clientHeight + 1);
  }, [result, open]);

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
          {t(runStatusKey(run.status))}
        </span>
      </div>
      {run.summary && !isAutoRunTitle(run.summary) && (
        <p data-testid="cron-run-summary" className="mt-0.5 text-[11px] text-text-dim break-words">
          {run.summary}
        </p>
      )}
      {result ? (
        <>
          <div
            ref={body}
            data-testid="cron-run-result"
            className={`mt-1 text-text break-words ${
              open ? "max-h-80 overflow-y-auto" : "line-clamp-3"
            }`}
          >
            <MarkdownContent content={result} />
          </div>
          {(overflows || open) && (
            <button
              type="button"
              data-testid="cron-run-toggle"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
              className="mt-1 text-[11px] text-primary hover:underline"
            >
              {open ? t("cron.runs.collapse") : t("cron.runs.expand")}
            </button>
          )}
        </>
      ) : (
        run.status !== "running" && (
          <p className="mt-1 text-[11px] text-text-dim">{t("cron.runs.noResult")}</p>
        )
      )}
    </li>
  );
}
