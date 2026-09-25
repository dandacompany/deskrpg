"use client";
/**
 * The "Cards" tab in the staff dialog — the list of Kanban cards this NPC is assigned to.
 * Follows the same layout as the cron tab (`CronPanel`).
 *
 * **Does not fetch on its own.** The parent (`ChatPanel`, Task 6) passes in `board` (or
 * `error`), and this component only renders what `assignedCards` picks out — testable
 * without a DB or network, and never crosses the client bundle boundary.
 *
 * **Never treats an unconfirmed state as an empty list.** Before the fetch finishes
 * (`board` and `error` both `null`), it only shows a skeleton. "No assigned cards" is a
 * statement made **only once it's a confirmed fact.** Once the board has arrived, loading
 * is over — the skeleton doesn't keep spinning just because `npcProfile` is unknown.
 *
 * **Distinguishes an empty state from an error.** If a gate block (missing plugin, needs
 * upgrade, gateway not connected, etc.) is shown as "no assigned cards", the user can't
 * tell why. The error text reuses the `@/lib/gate-failure` classification and
 * `wizard-error-codes` messages that cron and Kanban already use.
 */
import { useMemo } from "react";

import { useT } from "@/lib/i18n";
import type { KanbanBoard } from "@/lib/hermes/deskrpg-plugin-types";
import { classifyGateFailure } from "@/lib/gate-failure";
import { getWizardErrorMessage } from "@/components/hermes/wizard-error-codes";
import { assignedCards } from "@/lib/npc-assigned-cards";
import { failureLine } from "@/components/kanban/kanban-view-model";

export interface NpcCardsTabProps {
  /** Basis for determining the assignee — the Hermes profile name (`KanbanTask.assignee`). Empty string if unknown. */
  npcProfile: string;
  /** The already-fetched board. `null` if the fetch hasn't finished yet. */
  board: KanbanBoard | null;
  /** Reason the board couldn't be fetched (plugin gate code, etc.). If present, it takes priority over `board` and renders the error. */
  error?: string | null;
  onOpenCard: (taskId: string) => void;
  /**
   * Cards this NPC is running right now, across every board of the channel — `sources.runningCards`
   * of `npc:working`, the same number the map badge shows. Never recounted from `board`, which
   * holds a single board. Hidden when 0 or unknown.
   */
  runningCards?: number;
}

export default function NpcCardsTab({
  npcProfile,
  board,
  error = null,
  onOpenCard,
  runningCards = 0,
}: NpcCardsTabProps) {
  const t = useT();
  // Don't pick anything at all when the profile is unknown — if a card with
  // `assignee === ""` were treated as "assigned to this staff member", someone else's
  // card would show. Assignment only attaches via the profile name
  // (`KanbanTask.assignee`), so a staff member without a profile has no cards attached
  // either — the empty list is a fact, not a guess.
  const cards = useMemo(
    () => (board && npcProfile ? assignedCards(board, npcProfile) : []),
    [board, npcProfile],
  );

  return (
    <div data-testid="npc-cards-tab" className="flex flex-col min-h-0 h-full bg-bg text-text">
      {runningCards > 0 && (
        <p data-testid="cards-running-count" className="px-3 pt-2 text-xs font-medium text-primary">
          {t("cards.runningCount", { count: runningCards })}
        </p>
      )}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-2">
        {error !== null ? (
          <CardsErrorNotice code={error} />
        ) : board === null ? (
          <div data-testid="cards-loading" aria-busy="true" className="space-y-1 py-2">
            <div className="h-9 rounded-lg bg-surface" />
            <div className="h-9 rounded-lg bg-surface" />
          </div>
        ) : cards.length === 0 ? (
          <p data-testid="cards-empty" className="text-sm text-text-dim py-4 text-center">
            {t("cards.empty")}
          </p>
        ) : (
          <ul role="list" className="space-y-1">
            {cards.map((card) => (
              <li key={card.id} role="listitem">
                <button
                  type="button"
                  data-card-id={card.id}
                  onClick={() => onOpenCard(card.id)}
                  className="w-full text-left px-3 py-2 rounded-lg border bg-surface border-border hover:bg-surface-raised"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-medium truncate flex-1">{card.title}</span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-text-muted">
                    {t(`kanban.column.${card.status}`)}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * Gate notice — gives **every** kind `classifyGateFailure` can emit its own message.
 *
 * Patching codes one at a time lets the same defect resurface in the next code (fixing
 * only `board_unavailable` once let the more common `plugin_absent` fall back to "unknown
 * error"). All the text is reused — the Kanban board's board-unavailable line
 * (`failureLine`), the cron tab's gateway/upgrade notices, and the gate checklist's step
 * text. No new i18n keys are created.
 *
 * The `classifyGateFailure` and `wizard-error-codes` tables are left untouched — the
 * server is the single source of judgment and that table belongs to the wizard. The
 * fallback stays in place: a future new code should never break the screen.
 */
function CardsErrorNotice({ code }: { code: string }) {
  const t = useT();

  // The 503 board-not-ready case (`kanban-access.ts`) isn't in `classifyGateFailure`'s
  // table — reuse the message the Kanban board already uses.
  if (code === "board_unavailable") {
    return (
      <Notice tone="neutral" title={t("kanban.blocker.boardTitle")}>
        <p className="text-text-muted break-words">{failureLine({ code, message: code })}</p>
      </Notice>
    );
  }

  const blocker = classifyGateFailure({ status: 0, code, message: code });

  switch (blocker.kind) {
    case "gateway_not_bound":
      return <Notice tone="neutral">{t("cron.error.gatewayNotBound")}</Notice>;
    case "plugin_absent":
      return (
        <Notice tone="warn" title={t("gateChecklist.step.plugin")}>
          <p className="text-text-muted">{t("gateChecklist.hint.plugin")}</p>
          <Command command={blocker.command} />
        </Notice>
      );
    case "plugin_unauthorized":
      return (
        <Notice tone="warn" title={t("gateChecklist.step.ownerKey")}>
          <p className="text-text-muted">{t("gateChecklist.hint.ownerKey")}</p>
        </Notice>
      );
    case "plugin_upgrade_required":
      return (
        <Notice
          tone="warn"
          title={t("cron.error.upgradeRequired", { minVersion: blocker.minVersion })}
        >
          <p className="text-text-muted">{t("cron.error.upgradeHint")}</p>
          <Command command={blocker.command} />
        </Notice>
      );
    // `plugin_unknown` also lands here — there's nothing different for the user to do.
    case "unreachable":
      return <Notice tone="neutral">{t("gateChecklist.unreachable")}</Notice>;
    case "timeout":
      return <Notice tone="neutral">{t("gateChecklist.timeout")}</Notice>;
    default:
      return (
        <Notice tone="error">
          <p>{getWizardErrorMessage(t, code)}</p>
          <p className="font-mono text-[11px] text-text-muted break-all">{code}</p>
        </Notice>
      );
  }
}

/** Notice box — classes are kept as literals (dynamic assembly isn't generated by Tailwind). */
function Notice({
  tone,
  title,
  children,
}: {
  tone: "neutral" | "warn" | "error";
  title?: string;
  children: React.ReactNode;
}) {
  const box =
    tone === "warn"
      ? "border-amber-600/60 bg-amber-900/20"
      : tone === "error"
        ? "border-red-700/60 bg-red-900/20"
        : "border-border bg-surface";
  return (
    <div
      role="alert"
      data-testid="cards-error"
      className={`p-3 rounded border text-xs text-text space-y-1.5 ${box}`}
    >
      {title && <p className="font-semibold">{title}</p>}
      {children}
    </div>
  );
}

function Command({ command }: { command: string }) {
  return (
    <code className="block px-2 py-1.5 bg-bg border border-border rounded font-mono text-[11px] break-all select-all">
      {command}
    </code>
  );
}
