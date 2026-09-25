"use client";
import { useEffect, useState } from "react";
import { Hourglass, ShieldAlert } from "lucide-react";

import { useT } from "@/lib/i18n";
import type { ToolApprovalChoice } from "@/lib/tool-approval-types";

import {
  useToolApprovals,
  type ApprovalCardState,
  type ToolApprovalSocket,
} from "./use-tool-approvals";

/** `m:ss`, rounded up so the last second still reads 0:01. */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export type ToolApprovalCardProps = {
  card: ApprovalCardState;
  npcName: string;
  onDecide(choice: ToolApprovalChoice): void;
};

/**
 * One Hermes approval, shown only to the person who asked for the work. The command text is
 * what Hermes already redacted. Buttons follow the request's choices (never `always`); once the
 * countdown hits zero Hermes has denied it on its own, so the card just says it timed out.
 */
export function ToolApprovalCard({ card, npcName, onDecide }: ToolApprovalCardProps) {
  const t = useT();
  const { request, status, deciding } = card;
  const now = useNow(status === "pending");
  const remaining = request.expiresAt - now;
  const shown = status === "pending" && remaining <= 0 ? "expired" : status;

  return (
    <div
      data-testid="tool-approval-card"
      data-key={request.key}
      data-status={shown}
      className="rounded-lg border border-primary/40 bg-surface-raised p-2.5 text-xs"
    >
      <div className="flex items-center gap-1.5">
        <ShieldAlert className="h-3.5 w-3.5 flex-shrink-0 text-primary" />
        <span className="font-semibold text-text">
          {t("approvals.card.title", { npc: npcName })}
        </span>
        <span className="text-text-muted">{t(`approvals.kind.${request.kind}`)}</span>
        {shown === "pending" && (
          <span data-approval-remaining className="ml-auto tabular-nums text-text-muted">
            {t("approvals.card.remaining", { time: formatRemaining(remaining) })}
          </span>
        )}
      </div>
      <code
        data-approval-command
        className="mt-1.5 block max-h-24 overflow-y-auto whitespace-pre-wrap break-all rounded bg-bg px-2 py-1 text-[11px] text-text"
      >
        {request.command}
      </code>
      {request.description && request.description !== request.command && (
        <p className="mt-1 text-text-muted">{request.description}</p>
      )}
      {shown === "pending" ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {request.choices.map((choice) => (
            <button
              key={choice}
              type="button"
              data-choice={choice}
              disabled={deciding}
              onClick={() => onDecide(choice)}
              className={`rounded px-2.5 py-1 disabled:opacity-50 ${
                choice === "deny"
                  ? "border border-border text-text hover:bg-bg"
                  : "bg-primary text-white"
              }`}
            >
              {t(`approvals.choice.${choice}`)}
            </button>
          ))}
          {deciding && (
            <span className="self-center text-text-muted">{t("approvals.deciding")}</span>
          )}
        </div>
      ) : (
        <p
          className={`mt-2 ${shown === "approved_once" || shown === "approved_session" ? "text-success" : "text-text-muted"}`}
        >
          {t(`approvals.status.${shown}`)}
        </p>
      )}
    </div>
  );
}

export type ToolApprovalStackProps = {
  socket: ToolApprovalSocket | null | undefined;
  channelId: string;
  context: "dm" | "meeting";
  /** DM only: the NPC whose chat is open. */
  npcId?: string;
  npcNames: Record<string, string>;
  collapseMs?: number;
};

/**
 * The approval cards (and, in a meeting, the "waiting for approval" lines other participants
 * see) for one chat. Which sockets receive a request is the server's decision; this only
 * filters what arrived down to the chat being shown.
 */
export default function ToolApprovalStack({
  socket,
  channelId,
  context,
  npcId,
  npcNames,
  collapseMs,
}: ToolApprovalStackProps) {
  const t = useT();
  const { cards, waiting, decide } = useToolApprovals(socket, { collapseMs });
  const shown = cards.filter(
    (c) =>
      c.request.channelId === channelId &&
      c.request.context === context &&
      (npcId === undefined || c.request.npcId === npcId),
  );
  const lines =
    context === "meeting" ? waiting.filter((w) => !cards.some((c) => c.request.key === w.key)) : [];
  if (shown.length === 0 && lines.length === 0) return null;

  return (
    <div data-testid="tool-approvals" className="flex flex-col gap-2 px-3 pb-2">
      {shown.map((card) => (
        <ToolApprovalCard
          key={card.request.key}
          card={card}
          npcName={npcNames[card.request.npcId] ?? ""}
          onDecide={(choice) => decide(card.request.key, choice)}
        />
      ))}
      {lines.map((line) => (
        <p
          key={line.key}
          data-approval-pending
          className="flex items-center gap-1.5 text-xs text-text-muted"
        >
          <Hourglass className="h-3.5 w-3.5" />
          {t("approvals.pending", {
            npc: npcNames[line.npcId] ?? "",
            approver: line.approverName,
          })}
        </p>
      ))}
    </div>
  );
}
