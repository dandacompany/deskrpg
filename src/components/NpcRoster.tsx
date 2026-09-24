"use client";

import { useState } from "react";
import { UserPlus, Users } from "lucide-react";
import { useT } from "@/lib/i18n";
import RosterAvatar from "./RosterAvatar";

/**
 * NPC roster (who's clocked in).
 *
 * A clocked-in employee always has a spot: a number for a desk seat, or "standing" when
 * the desks are full. Both are buttons, and clicking one enters seat-change mode (owner only).
 */
export type RosterNpc = {
  id: string;
  name: string;
  appearance?: unknown;
  active: boolean;
  placed: boolean;
  seatNumber?: number | null;
  profile?: { ownerUserId?: string; profileName?: string } | null;
};

export type NpcRosterProps = {
  npcs: RosterNpc[];
  /** NPCs seated in an ongoing discussion — clocking one out leaves its turn with nowhere to go. */
  meetingNpcIds: Set<string>;
  isOwner: boolean;
  currentUserId: string;
  onToggle: (npcId: string, active: boolean) => void;
  onPlace: (npcId: string) => void;
  onHire: () => void;
  /** With no gateway on the channel, there's nowhere to create a new employee. */
  hireDisabled?: boolean;
  /** Action menu opened on row click (chat, summon, etc). Without it, the row isn't a button. */
  onOpenMenu?: (anchor: HTMLElement, npc: RosterNpc) => void;
  /** When present, shows a "select multiple" toggle in the header and starts a group chat with the checked clocked-in NPCs. */
  onStartGroupChat?: (npcIds: string[]) => void;
};

export default function NpcRoster({
  npcs,
  meetingNpcIds,
  isOwner,
  currentUserId,
  onToggle,
  onPlace,
  onHire,
  hireDisabled = false,
  onOpenMenu,
  onStartGroupChat,
}: NpcRosterProps) {
  const t = useT();
  const seatLabel = (npc: RosterNpc) =>
    npc.seatNumber
      ? t("game.roster.seatNumber", { number: npc.seatNumber })
      : t("game.roster.standing");
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const toggleSelectMode = () => {
    setSelectMode((prev) => !prev);
    setSelectedIds(new Set());
  };

  const toggleSelected = (npcId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(npcId)) next.delete(npcId);
      else next.add(npcId);
      return next;
    });
  };

  const startGroupChat = () => {
    if (!onStartGroupChat || selectedIds.size === 0) return;
    onStartGroupChat([...selectedIds]);
    setSelectMode(false);
    setSelectedIds(new Set());
  };

  return (
    <div>
      <div className="px-3 py-2 border-b border-border text-caption text-text-dim flex items-center justify-between gap-2">
        <span>{t("game.roster.title")}</span>
        <div className="flex items-center gap-1">
          {onStartGroupChat && (
            <button
              onClick={toggleSelectMode}
              className={`flex items-center gap-1 px-2 py-1 rounded-md text-micro font-semibold ${
                selectMode
                  ? "bg-primary/80 hover:bg-primary text-white"
                  : "bg-surface-raised hover:brightness-125 text-text-secondary"
              }`}
            >
              <Users className="w-3 h-3" />
              <span>{t("game.roster.selectMode")}</span>
            </button>
          )}
          {isOwner && (
            <button
              onClick={onHire}
              disabled={hireDisabled}
              title={hireDisabled ? t("game.roster.needsGateway") : undefined}
              className="flex items-center gap-1 px-2 py-1 rounded-md bg-primary/80 hover:bg-primary text-white text-micro font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <UserPlus className="w-3 h-3" />
              <span>{t("game.roster.hire")}</span>
            </button>
          )}
        </div>
      </div>
      <div className="max-h-64 overflow-y-auto py-1">
        {npcs.length === 0 ? (
          <div className="px-3 py-3 text-caption text-text-dim">{t("game.noNpcsAtWork")}</div>
        ) : (
          npcs.map((npc) => {
            const inMeeting = meetingNpcIds.has(npc.id);
            // If we don't know who "I" am (empty string), assert nothing — comparing while
            // unknown would mark everything as "shared".
            const shared =
              !!currentUserId &&
              !!npc.profile?.ownerUserId &&
              npc.profile.ownerUserId !== currentUserId;
            return (
              <div
                key={npc.id}
                className="px-3 py-2 flex items-center gap-2 text-body text-text-secondary"
              >
                {selectMode && npc.active && (
                  <input
                    type="checkbox"
                    data-npc-id={npc.id}
                    checked={selectedIds.has(npc.id)}
                    onChange={() => toggleSelected(npc.id)}
                    className="shrink-0"
                  />
                )}
                <RosterAvatar appearance={npc.appearance ?? null} />
                {onOpenMenu ? (
                  <button
                    onClick={(event) => onOpenMenu(event.currentTarget, npc)}
                    className="truncate text-left hover:underline"
                  >
                    {npc.name}
                  </button>
                ) : (
                  <span className="truncate">{npc.name}</span>
                )}
                {shared && (
                  <span className="text-micro text-text-dim shrink-0">
                    {t("game.roster.shared")}
                  </span>
                )}
                <div className="ml-auto flex items-center gap-1 shrink-0">
                  {!npc.active ? (
                    <span className="text-micro text-text-dim">{t("game.roster.dormant")}</span>
                  ) : isOwner ? (
                    <button
                      data-testid={`seat-${npc.id}`}
                      onClick={() => onPlace(npc.id)}
                      className="text-micro px-2 py-0.5 rounded bg-surface-raised hover:brightness-125 text-primary-light"
                    >
                      {seatLabel(npc)}
                    </button>
                  ) : (
                    <span className="text-micro text-text-dim">{seatLabel(npc)}</span>
                  )}
                  {isOwner && (
                    <button
                      data-testid={`toggle-${npc.id}`}
                      onClick={() => onToggle(npc.id, !npc.active)}
                      disabled={inMeeting}
                      title={inMeeting ? t("game.roster.inMeeting") : undefined}
                      className="text-micro px-2 py-0.5 rounded bg-surface-raised hover:brightness-125 text-text-secondary disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {npc.active ? t("npc.sleep") : t("npc.wake")}
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
      {selectMode && onStartGroupChat && (
        <div className="px-3 py-2 border-t border-border">
          <button
            onClick={startGroupChat}
            disabled={selectedIds.size === 0}
            className="w-full px-2 py-1.5 rounded-md bg-primary/80 hover:bg-primary text-white text-micro font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {t("game.roster.startGroupChat")}
          </button>
        </div>
      )}
    </div>
  );
}
