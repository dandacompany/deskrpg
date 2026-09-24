"use client";
/**
 * A single line of structured notice (R29/R30). The server doesn't know the locale and
 * only ships `notice`; the sentence is built here in the viewer's language.
 *
 * - `card_done` / `card_blocked` / `card_review`: a card-title-centered sentence + "Open
 *   card" (opens the Kanban modal to that card).
 * - `cron_result`: a "Cron result · {jobName}" header (with a failure badge) + the body
 *   as-is + "Open history".
 * - `card_proposal`: the proposal body + two choice buttons (before resolution) / the
 *   decision result (after). `content` matches the title, so it isn't rendered again.
 * - An unknown kind: falls back to `content` — the notice itself is never swallowed.
 *
 * The sender name uses `notice.npcName` (falling back to senderName). The server prefixes
 * the NPC name onto a system message's `content` (R22), but since the sentence is built
 * from notice here, that prefix isn't used.
 */
import type { RoomMessage, RoomNotice } from "@/lib/chat-rooms-policy";
import { useT } from "@/lib/i18n";

import MarkdownContent from "../ui/MarkdownContent";
import CardProposalNotice from "./CardProposalNotice";

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** The body sentence for a card notice. A pure function — tests pin it down per locale. */
export function cardNoticeText(
  notice: Extract<RoomNotice, { kind: "card_done" | "card_blocked" | "card_review" }>,
  t: Translate,
): string {
  const key =
    notice.kind === "card_done"
      ? "notice.cardDone"
      : notice.kind === "card_review"
        ? "notice.cardReview"
        : "notice.cardBlocked";
  return t(key, { title: notice.cardTitle });
}

/**
 * Whether this is a kind we can build a sentence for here — otherwise it falls back to
 * `content`. The supported list is written positively via `Extract`: a new kind added to
 * the union that isn't listed here automatically falls back, so `Exclude` exceptions don't
 * pile up per kind.
 */
export function isKnownNotice(notice: RoomNotice | null | undefined): notice is Extract<
  RoomNotice,
  {
    kind:
      | "card_done"
      | "card_blocked"
      | "card_review"
      | "approval_requested"
      | "cron_result"
      | "card_proposal"
      | "meeting_outcome";
  }
> {
  return (
    !!notice &&
    (notice.kind === "card_done" ||
      notice.kind === "card_blocked" ||
      notice.kind === "card_review" ||
      notice.kind === "approval_requested" ||
      notice.kind === "cron_result" ||
      notice.kind === "card_proposal" ||
      notice.kind === "meeting_outcome")
  );
}

export interface RoomNoticeMessageProps {
  message: RoomMessage;
  onOpenCard?: (cardId: string, boardSlug: string) => void;
  onOpenCronJob?: (jobId: string) => void;
  onOpenApproval?: (approvalId: string) => void;
  /** A meeting-outcome notice — opens that meeting's minutes (the follow-up task registration screen). No button if omitted. */
  onOpenMinutes?: (minutesId: string) => void;
  /** The choice for a proposal notice. If omitted, the proposal shows only its body, with no buttons (read-only). */
  onResolveProposal?: (proposalId: string, choice: "card" | "inline") => void;
  /** Whether that proposal currently has a server call in flight. */
  proposalPending?: boolean;
  /** The reason (code) that proposal last failed. The buttons remain as-is. */
  proposalError?: string | null;
}

export default function RoomNoticeMessage({
  message,
  onOpenCard,
  onOpenCronJob,
  onOpenApproval,
  onOpenMinutes,
  onResolveProposal,
  proposalPending = false,
  proposalError = null,
}: RoomNoticeMessageProps) {
  const t = useT();
  const notice = message.notice ?? null;
  const name = (notice && "npcName" in notice && notice.npcName) || message.senderName;

  if (!isKnownNotice(notice)) {
    // An unknown kind — just content, like a regular NPC/system line.
    return (
      <div className="flex justify-start" data-room-notice="unknown">
        <div className="max-w-[85%] px-3 py-2 rounded-lg text-body bg-surface-raised text-text-secondary">
          {name && <div className="text-caption font-semibold text-npc mb-0.5">{name}</div>}
          <div className="whitespace-pre-wrap break-words">{message.content}</div>
        </div>
      </div>
    );
  }

  const linkClass = "text-caption font-semibold text-primary hover:underline";

  if (notice.kind === "card_proposal") {
    return (
      <div className="flex justify-start" data-room-notice={notice.kind}>
        <div className="max-w-[85%] w-full px-3 py-2 rounded-lg text-body bg-surface-raised text-text-secondary border border-border">
          {name && <div className="text-caption font-semibold text-npc mb-0.5">{name}</div>}
          <CardProposalNotice
            notice={notice}
            onResolve={(choice) => onResolveProposal?.(notice.proposalId, choice)}
            pending={proposalPending}
            unavailable={!onResolveProposal}
            error={proposalError}
          />
        </div>
      </div>
    );
  }

  if (notice.kind === "cron_result") {
    const failed = notice.status === "error";
    return (
      <div
        className="flex justify-start"
        data-room-notice={notice.kind}
        data-status={notice.status}
      >
        <div className="max-w-[85%] w-full px-3 py-2 rounded-lg text-body bg-surface-raised text-text-secondary border border-border">
          {name && <div className="text-caption font-semibold text-npc mb-0.5">{name}</div>}
          <div className="flex items-center gap-1.5 flex-wrap text-caption text-text-muted mb-1">
            <span className="font-semibold">
              {t("notice.cronResult", { jobName: notice.jobName })}
            </span>
            {failed && (
              <span
                data-testid="notice-cron-failed"
                className="px-1.5 py-0.5 rounded bg-danger-bg text-danger font-semibold"
              >
                {t("notice.cronFailed")}
              </span>
            )}
          </div>
          {message.content.trim() ? (
            <MarkdownContent content={message.content} />
          ) : (
            <p className="text-text-muted">
              {t(failed ? "room.cronResult.failed" : "room.cronResult.empty")}
            </p>
          )}
          {onOpenCronJob && (
            <button
              type="button"
              className={`${linkClass} mt-1`}
              onClick={() => onOpenCronJob(notice.jobId)}
            >
              {t("notice.openHistory")}
            </button>
          )}
        </div>
      </div>
    );
  }

  if (notice.kind === "meeting_outcome") {
    // Once registered, the same line states the result. That's the renderer reading `resolved` — the client isn't hiding anything.
    const registered = notice.resolved;
    return (
      <div className="flex justify-start" data-room-notice={notice.kind}>
        <div className="max-w-[85%] px-3 py-2 rounded-lg text-body bg-surface-raised text-text-secondary border border-border">
          <div className="break-words">
            {t(notice.recommended ? "notice.meetingOutcome.recommended" : "notice.meetingOutcome", {
              topic: notice.topic,
              count: notice.followUpCount,
            })}
          </div>
          {registered && (
            <div className="text-caption text-text-muted mt-1" data-meeting-outcome-resolved>
              {t("notice.meetingOutcome.registered", { count: registered.taskCount })}
            </div>
          )}
          {onOpenMinutes && (
            <button
              type="button"
              data-meeting-outcome-open={registered ? "view" : "register"}
              className={`${linkClass} mt-1`}
              onClick={() => onOpenMinutes(notice.minutesId)}
            >
              {t(registered ? "notice.meetingOutcome.view" : "notice.meetingOutcome.register")}
            </button>
          )}
        </div>
      </div>
    );
  }

  if (notice.kind === "approval_requested") {
    // Once decided, the result renders instead of the button. **The renderer reads the
    // resolved state** — the client isn't hiding it — so it looks the same after a
    // refresh and in other tabs.
    return (
      <div className="flex justify-start" data-room-notice={notice.kind}>
        <div className="max-w-[85%] px-3 py-2 rounded-lg text-body bg-surface-raised text-text-secondary border border-border">
          {name && <div className="text-caption font-semibold text-npc mb-0.5">{name}</div>}
          <div className="break-words">
            {t("notice.approvalRequested", {
              title: notice.title,
              count: notice.targetCount,
            })}
          </div>
          {notice.resolved ? (
            <div className="text-caption text-text-muted mt-1" data-approval-resolved>
              {t(`notice.approval.${notice.resolved.decision}`)}
            </div>
          ) : (
            onOpenApproval && (
              <button
                type="button"
                className={`${linkClass} mt-1`}
                onClick={() => onOpenApproval(notice.approvalId)}
              >
                {t("notice.openApproval")}
              </button>
            )
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start" data-room-notice={notice.kind}>
      <div className="max-w-[85%] px-3 py-2 rounded-lg text-body bg-surface-raised text-text-secondary border border-border">
        {name && <div className="text-caption font-semibold text-npc mb-0.5">{name}</div>}
        <div className="break-words">{cardNoticeText(notice, t)}</div>
        {onOpenCard && (
          <button
            type="button"
            className={`${linkClass} mt-1`}
            onClick={() => onOpenCard(notice.cardId, notice.boardSlug)}
          >
            {t("notice.openCard")}
          </button>
        )}
      </div>
    </div>
  );
}
