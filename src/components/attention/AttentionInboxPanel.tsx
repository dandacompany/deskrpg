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

import {
  createApprovalPolicyApi,
  type ApprovalPolicyClientApi,
} from "../approvals/approval-policy-api";
import { createAttentionApi, type AttentionInbox } from "./attention-api";

/**
 * The fields of an `approval_blocked` row — an unattended cron/kanban run that the NPC's run
 * policy blocked. Read defensively from the row: the server assembles it (`attention-inbox.ts`).
 */
export type ApprovalBlockedFields = {
  npcId: string;
  /** The blocked-run notice; sent with an allowlist add so the server resolves it. */
  messageId?: string;
  /** The blocked command (Hermes-redacted), or the MCP tool for `blockKind: "mcp"`. */
  subtitle: string;
  /** The dangerous-pattern rule key; the allowlist holds these keys, not commands. */
  patternKey: string | null;
  /** The viewer owns the gateway and may change the NPC's run policy. */
  canAllowlist: boolean;
  source: "cron" | "kanban";
  jobName?: string;
  taskTitle?: string;
  blockKind: "command" | "mcp";
  tool?: string;
};

export function approvalBlockedFields(row: AttentionRow): ApprovalBlockedFields | null {
  if ((row.kind as string) !== "approval_blocked") return null;
  const r = row as unknown as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const npcId = str(r.npcId);
  if (!npcId) return null;
  return {
    npcId,
    messageId: str(r.messageId),
    subtitle: str(r.subtitle) ?? "",
    patternKey: str(r.patternKey) ?? null,
    canAllowlist: r.canAllowlist === true,
    source: r.source === "kanban" ? "kanban" : "cron",
    jobName: str(r.jobName),
    taskTitle: str(r.taskTitle),
    blockKind: r.blockKind === "mcp" ? "mcp" : "command",
    tool: str(r.tool),
  };
}

export interface AttentionInboxPanelProps {
  channelId: string;
  onOpenCard?: (taskId: string) => void;
  onOpenCronJob?: (jobId: string) => void;
  /** Opens the NPC's unattended run policy modal (owner, blocked row without a rule key). */
  onOpenApprovalPolicy?: (npcId: string) => void;
  /** Stands in for the real fetch in tests/stories. */
  api?: ReturnType<typeof createAttentionApi>;
  /** Stands in for the run policy API in tests. */
  policyApi?: (npcId: string) => ApprovalPolicyClientApi;
}

export default function AttentionInboxPanel({
  channelId,
  onOpenCard,
  onOpenCronJob,
  onOpenApprovalPolicy,
  api,
  policyApi,
}: AttentionInboxPanelProps) {
  const t = useT();
  const client = useRef(api ?? createAttentionApi(channelId));
  const [inbox, setInbox] = useState<AttentionInbox | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const policyFor = useCallback(
    (npcId: string) => (policyApi ? policyApi(npcId) : createApprovalPolicyApi(channelId, npcId)),
    [policyApi, channelId],
  );

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
          onOpenApprovalPolicy={onOpenApprovalPolicy}
          policyFor={policyFor}
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
  onOpenApprovalPolicy,
  policyFor,
}: {
  row: AttentionRow;
  busy: boolean;
  onDecide: (row: AttentionRow, d: "approve" | "reject" | "request_revision", note: string) => void;
  onOpenCard?: (taskId: string) => void;
  onOpenCronJob?: (jobId: string) => void;
  onOpenApprovalPolicy?: (npcId: string) => void;
  policyFor: (npcId: string) => ApprovalPolicyClientApi;
}) {
  const t = useT();
  const blocked = approvalBlockedFields(row);
  if (blocked) {
    return (
      <ApprovalBlockedRowView
        row={row}
        fields={blocked}
        onOpenApprovalPolicy={onOpenApprovalPolicy}
        policyFor={policyFor}
      />
    );
  }
  return (
    <DecisionRowView
      row={row}
      busy={busy}
      onDecide={onDecide}
      onOpenCard={onOpenCard}
      onOpenCronJob={onOpenCronJob}
      t={t}
    />
  );
}

/**
 * A blocked unattended run. The owner can allow the rule that blocked it (the allowlist holds
 * rule keys); without a rule key (Tirith, execute_code, MCP) only the run policy's modes can
 * help, so the owner gets a shortcut to it. Others are told to ask the gateway owner.
 */
function ApprovalBlockedRowView({
  row,
  fields,
  onOpenApprovalPolicy,
  policyFor,
}: {
  row: AttentionRow;
  fields: ApprovalBlockedFields;
  onOpenApprovalPolicy?: (npcId: string) => void;
  policyFor: (npcId: string) => ApprovalPolicyClientApi;
}) {
  const t = useT();
  const [state, setState] = useState<"idle" | "busy" | "added" | "failed">("idle");
  const name = fields.source === "cron" ? fields.jobName : fields.taskTitle;
  const allow = async () => {
    if (!fields.patternKey) return;
    setState("busy");
    try {
      await policyFor(fields.npcId).addAllowlist(fields.patternKey, fields.messageId);
      setState("added");
    } catch {
      setState("failed");
    }
  };

  return (
    <div
      className="rounded-lg border border-border bg-surface-raised px-3 py-2"
      data-attention-row="approval_blocked"
      data-row-id={row.id}
    >
      <div className="flex items-center gap-2 text-caption text-text-muted">
        <span className="font-semibold">{t("attention.kind.approval_blocked")}</span>
        <span>{t(`attention.blockedRun.source.${fields.source}`)}</span>
      </div>
      <div className="mt-0.5 break-words text-body text-text">{name || row.title}</div>
      <div className="mt-0.5 break-all text-caption text-text-muted" data-blocked-subject>
        {fields.blockKind === "mcp" ? (
          t("attention.blockedRun.tool", { tool: fields.tool ?? fields.subtitle })
        ) : (
          <code className="font-mono">{fields.subtitle}</code>
        )}
      </div>
      {fields.canAllowlist && fields.patternKey ? (
        <div className="mt-1 flex items-center gap-2">
          {state === "added" ? (
            <span className="text-caption text-text-muted" data-allowlist-added>
              {t("attention.blockedRun.added")}
            </span>
          ) : (
            <button
              type="button"
              data-action="allowlist-add"
              disabled={state === "busy"}
              className="text-caption font-semibold text-primary hover:underline disabled:opacity-50"
              onClick={() => void allow()}
            >
              {t("attention.blockedRun.allow", { patternKey: fields.patternKey })}
            </button>
          )}
          {state === "failed" && (
            <span className="text-caption text-danger" data-error>
              {t("attention.blockedRun.failed")}
            </span>
          )}
        </div>
      ) : fields.canAllowlist ? (
        <div className="mt-1 flex flex-col gap-0.5">
          <span className="text-caption text-text-muted">{t("attention.blockedRun.noRule")}</span>
          <button
            type="button"
            data-action="open-policy"
            className="self-start text-caption font-semibold text-primary hover:underline"
            onClick={() => onOpenApprovalPolicy?.(fields.npcId)}
          >
            {t("attention.blockedRun.openPolicy")}
          </button>
        </div>
      ) : (
        <p className="mt-1 text-caption text-text-muted" data-ask-owner>
          {t("attention.blockedRun.askOwner")}
        </p>
      )}
    </div>
  );
}

function DecisionRowView({
  row,
  busy,
  onDecide,
  onOpenCard,
  onOpenCronJob,
  t,
}: {
  row: AttentionRow;
  busy: boolean;
  onDecide: (row: AttentionRow, d: "approve" | "reject" | "request_revision", note: string) => void;
  onOpenCard?: (taskId: string) => void;
  onOpenCronJob?: (jobId: string) => void;
  t: ReturnType<typeof useT>;
}) {
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
      {row.kind === "blocked" && row.failures ? (
        <div data-repeated-failure className="mt-0.5 text-caption text-danger">
          {t("attention.repeatedFailure", { count: row.failures })}
        </div>
      ) : null}

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
