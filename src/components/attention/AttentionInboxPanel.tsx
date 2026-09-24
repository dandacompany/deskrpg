"use client";
/**
 * The attention inbox — a screen showing only the things a human needs to answer.
 *
 * The approve button sends **the same decision to the same route** as the room notice's
 * button. To keep the two in sync, we reload the list after clicking so the server stays
 * the source of truth (no optimistic update).
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { AttentionRow } from "@/lib/attention-inbox";
import { parseRequester } from "@/lib/approval-requester";
import { useT } from "@/lib/i18n";

import { createAttentionApi, type AttentionInbox } from "./attention-api";

export interface AttentionInboxPanelProps {
  channelId: string;
  onOpenCard?: (taskId: string) => void;
  onOpenCronJob?: (jobId: string) => void;
  /** Stands in for the real fetch in tests/stories. */
  api?: ReturnType<typeof createAttentionApi>;
}

export default function AttentionInboxPanel({
  channelId,
  onOpenCard,
  onOpenCronJob,
  api,
}: AttentionInboxPanelProps) {
  const t = useT();
  const client = useRef(api ?? createAttentionApi(channelId));
  const [inbox, setInbox] = useState<AttentionInbox | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setInbox(await client.current.load());
    } catch (e) {
      setInbox(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = useCallback(
    async (
      row: AttentionRow,
      decision: "approve" | "reject" | "request_revision",
      note: string,
    ) => {
      setBusy(row.id);
      try {
        await client.current.decide(row.id, { decision, ...(note ? { note } : {}) });
        // The server is the source of truth — the screen doesn't guess the result of the click.
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  if (error)
    return (
      <div className="p-4 text-body text-text-secondary" data-attention-error>
        <div className="mb-2 break-words">{error}</div>
        <button
          type="button"
          className="text-caption font-semibold text-primary hover:underline"
          onClick={() => void load()}
        >
          {t("attention.retry")}
        </button>
      </div>
    );
  if (!inbox) return <div className="p-4 text-body text-text-muted">{t("attention.loading")}</div>;
  if (inbox.rows.length === 0)
    return (
      <div className="p-4 text-body text-text-muted" data-attention-empty>
        {t("attention.empty")}
      </div>
    );

  return (
    <div className="flex flex-col gap-2 p-3" data-attention-panel>
      {inbox.rows.map((row) => (
        <AttentionRowView
          key={`${row.kind}:${row.id}`}
          row={row}
          busy={busy === row.id}
          onDecide={decide}
          onOpenCard={onOpenCard}
          onOpenCronJob={onOpenCronJob}
        />
      ))}
    </div>
  );
}

function AttentionRowView({
  row,
  busy,
  onDecide,
  onOpenCard,
  onOpenCronJob,
}: {
  row: AttentionRow;
  busy: boolean;
  onDecide: (row: AttentionRow, d: "approve" | "reject" | "request_revision", note: string) => void;
  onOpenCard?: (taskId: string) => void;
  onOpenCronJob?: (jobId: string) => void;
}) {
  const t = useT();
  const [note, setNote] = useState("");
  const requester = row.requestedBy ? parseRequester(row.requestedBy) : null;

  return (
    <div
      className="rounded-lg border border-border bg-surface-raised px-3 py-2"
      data-attention-row={row.kind}
      data-row-id={row.id}
    >
      <div className="flex items-center gap-2 text-caption text-text-muted">
        <span className="font-semibold">{t(`attention.kind.${row.kind}`)}</span>
        {row.count > 1 && <span>{t("attention.taskCount", { count: row.count })}</span>}
        {requester && (
          <span>
            {requester.kind === "profile"
              ? t("attention.requestedByProfile", { name: requester.profileName })
              : t("attention.requestedByUser")}
          </span>
        )}
      </div>
      <div className="mt-0.5 break-words text-body text-text">{row.title}</div>

      {row.kind === "approval" ? (
        <div className="mt-2 flex flex-col gap-2">
          <input
            className="rounded border border-border bg-surface px-2 py-1 text-caption text-text"
            placeholder={t("attention.note")}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-label={t("attention.note")}
          />
          <div className="flex gap-2">
            {(["approve", "reject", "request_revision"] as const).map((decision) => (
              <button
                key={decision}
                type="button"
                disabled={busy}
                data-decision={decision}
                className="rounded px-2 py-1 text-caption font-semibold text-primary hover:underline disabled:opacity-50"
                onClick={() => onDecide(row, decision, note.trim())}
              >
                {t(
                  decision === "approve"
                    ? "attention.approve"
                    : decision === "reject"
                      ? "attention.reject"
                      : "attention.requestRevision",
                )}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="mt-1 text-caption font-semibold text-primary hover:underline"
          onClick={() =>
            row.kind === "cron_failed" ? onOpenCronJob?.(row.id) : onOpenCard?.(row.id)
          }
        >
          {t(row.kind === "cron_failed" ? "attention.openHistory" : "attention.openCard")}
        </button>
      )}
    </div>
  );
}
