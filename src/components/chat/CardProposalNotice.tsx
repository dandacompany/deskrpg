"use client";
/**
 * A single line for a task card proposal an NPC put up. It's not a card yet — the user
 * picks either `register card` or `handle here` here, and the choice is kept in
 * `notice.resolved`.
 *
 * The single source of truth for whether the buttons show is `notice.resolved`. It's not
 * the client remembering a click and hiding — the notice itself carries its resolved
 * state, so it looks the same after a refresh or in another tab.
 * `error` never removes the buttons — if the server rejected, we show why and let the user pick again.
 */
import type { RoomNotice } from "@/lib/chat-rooms-policy";
import { useT } from "@/lib/i18n";

export type CardProposal = Extract<RoomNotice, { kind: "card_proposal" }>;

export interface CardProposalNoticeProps {
  notice: CardProposal;
  /** The user's choice. The server call and optimistic update are the caller's job. */
  onResolve: (choice: "card" | "inline") => void;
  /** A call is in flight — keep the buttons but disable them. The server's 409 is the source of truth for de-duping. */
  pending: boolean;
  /** This screen can't handle the proposal (no handler wired up). A different state from `pending` (in flight). */
  unavailable?: boolean;
  /** The reason (code) the server rejected. If present, show it and leave the buttons as-is. */
  error: string | null;
}

export default function CardProposalNotice({
  notice,
  onResolve,
  pending,
  unavailable = false,
  error,
}: CardProposalNoticeProps) {
  const t = useT();
  const resolved = notice.resolved;

  return (
    <div
      className="flex flex-col gap-1"
      data-testid="card-proposal"
      data-proposal-id={notice.proposalId}
    >
      <div className="text-caption font-semibold text-text-muted">
        {t("notice.cardProposal.title")}
      </div>
      <div className="font-semibold break-words">{notice.title}</div>
      {notice.summary && (
        <div className="text-body text-text-secondary whitespace-pre-wrap break-words">
          {notice.summary}
        </div>
      )}
      {notice.body && (
        <div className="text-caption text-text-muted whitespace-pre-wrap break-words">
          {notice.body}
        </div>
      )}
      {notice.acceptance && (
        // The acceptance condition is not the body — a label sets it apart (same distinction as the card body's `## Acceptance` section).
        <div className="text-caption text-text-muted mt-0.5" data-testid="card-proposal-acceptance">
          <span className="font-semibold">{t("notice.cardProposal.acceptanceLabel")}</span>{" "}
          <span className="whitespace-pre-wrap break-words">{notice.acceptance}</span>
        </div>
      )}

      {resolved ? (
        <div
          className="text-caption font-semibold text-text-muted mt-1"
          data-testid="card-proposal-resolved"
          data-choice={resolved.choice}
        >
          {resolved.choice === "card"
            ? t("notice.cardProposal.registered")
            : t("notice.cardProposal.handledHere")}
          {resolved.choice === "card" && resolved.taskId ? ` · ${resolved.taskId}` : ""}
        </div>
      ) : (
        <>
          {error && (
            <div
              className="text-caption text-danger bg-danger-bg rounded px-1.5 py-0.5 mt-1 break-words"
              data-testid="card-proposal-error"
            >
              {/* For a 409, "why" matters — this happens when the notice write failed and
                  the still-unresolved proposal is clicked again. A bare code leaves the
                  user unsure what to do. */}
              {error === "already_resolved"
                ? t("notice.cardProposal.alreadyResolved")
                : error === "plugin_upgrade_required"
                  ? t("notice.cardProposal.upgradeRequired")
                  : t("notice.cardProposal.failed", { reason: error })}
            </div>
          )}
          {unavailable && (
            // Leaving the buttons merely disabled looks like loading and the user waits forever — state the reason.
            <div
              className="text-caption text-text-muted mt-1"
              data-testid="card-proposal-unavailable"
            >
              {t("notice.cardProposal.unavailable")}
            </div>
          )}
          <div className="flex gap-1.5 flex-wrap mt-1">
            <button
              type="button"
              disabled={pending || unavailable}
              onClick={() => onResolve("card")}
              className="px-2 py-1 rounded text-caption font-semibold bg-primary text-white disabled:opacity-50"
            >
              {t("notice.cardProposal.registerCard")}
            </button>
            <button
              type="button"
              disabled={pending || unavailable}
              onClick={() => onResolve("inline")}
              className="px-2 py-1 rounded text-caption font-semibold bg-surface-raised text-text-secondary border border-border disabled:opacity-50"
            >
              {t("notice.cardProposal.handleHere")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
