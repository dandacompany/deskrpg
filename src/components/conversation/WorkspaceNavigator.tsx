"use client";

import { useEffect, useState } from "react";
import { sortRooms, type RoomSummary } from "@/lib/chat-rooms-policy";
import { roomMessagePreview } from "@/components/rooms/room-message-preview";
import type { DmThreadEntry } from "@/lib/dm-threads";
import { useT } from "@/lib/i18n";
import { useRoomApprovalCounts } from "@/components/approvals/ToolApprovalsProvider";
import ParticipantRow from "./ParticipantRow";

/**
 * A clocked-in employee as the game screen tracks it. A clocked-in employee always has a
 * spot: a desk seat number, or "standing" when the desks are full.
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

export type NavigatorNpc = RosterNpc & {
  role?: string;
  motion: "idle" | "moving" | "waiting" | "resting" | "unplaced";
  response?: "queued" | "thinking" | "streaming" | "failed";
  calledByViewer: boolean;
};

export type NavigatorPlayer = {
  id: string;
  name: string;
  online: boolean;
  self: boolean;
  appearance?: unknown;
};

export type NpcNavigatorAction =
  "call" | "return" | "place" | "profile" | "reset-chat" | "sleep" | "wake";

type Props = {
  workspaceName: string;
  rooms: RoomSummary[];
  currentRoomId: string | null;
  /**
   * A 1:1 conversation with a staff member. It's a (character, staff) pair in
   * `chat_messages` rather than a room, so it isn't in `rooms`; without an entry point
   * in this list, continuing the conversation required finding that staff member on
   * the map again.
   */
  dmThreads?: DmThreadEntry[];
  players: NavigatorPlayer[];
  npcs: NavigatorNpc[];
  selectedNpcId?: string | null;
  isOwner: boolean;
  onSelectRoom: (roomId: string) => void;
  /** Opens the DM from the list. **Opening it alone does not call the staff member** — sending a message does. */
  onSelectDm?: (npcId: string, npcName: string) => void;
  onSelectNpc: (npcId: string, npcName: string) => void;
  onSelectPlayer: (playerId: string) => void;
  onCompose: (presetNpcIds: string[]) => void;
  onNpcAction: (npcId: string, action: NpcNavigatorAction) => void;
  onInvitePeople?: () => void;
  onEditSelf?: () => void;
  onSetStartPosition?: () => void;
  onAddNpc?: () => void;
  addNpcDisabled?: boolean;
};

function npcDetail(npc: NavigatorNpc, t: ReturnType<typeof useT>): string {
  if (!npc.active || npc.motion === "resting") return t("workspace.status.resting");
  const prefix = npc.seatNumber
    ? t("game.roster.seatNumber", { number: npc.seatNumber })
    : t("game.roster.standing");
  if (!npc.placed || npc.motion === "unplaced") return prefix;
  if (npc.motion === "waiting")
    return `${prefix} · ${t(
      npc.calledByViewer ? "workspace.status.waitingForMe" : "workspace.status.waitingForOther",
    )}`;
  if (npc.motion === "moving") return `${prefix} · ${t("workspace.status.moving")}`;
  if (npc.response === "queued") return `${prefix} · ${t("workspace.status.queued")}`;
  if (npc.response === "thinking") return `${prefix} · ${t("workspace.status.thinking")}`;
  if (npc.response === "streaming") return `${prefix} · ${t("workspace.status.streaming")}`;
  if (npc.response === "failed") return `${prefix} · ${t("workspace.status.failed")}`;
  return npc.role
    ? `${prefix} · ${npc.role} · ${t("workspace.status.available")}`
    : `${prefix} · ${t("workspace.status.available")}`;
}

export default function WorkspaceNavigator(props: Props) {
  const t = useT();
  // A room approval raised while another view is open would otherwise go unseen until it expires.
  const roomApprovals = useRoomApprovalCounts();
  const [menuNpcId, setMenuNpcId] = useState<string | null>(null);
  useEffect(() => {
    if (!menuNpcId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuNpcId(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [menuNpcId]);
  const selectedNpc = props.npcs.find((npc) => npc.id === menuNpcId) ?? null;
  const action = (value: NpcNavigatorAction) => {
    if (!selectedNpc) return;
    props.onNpcAction(selectedNpc.id, value);
    setMenuNpcId(null);
  };

  return (
    <nav
      aria-label={t("workspace.nav.label")}
      className="flex h-full min-h-0 flex-col border-r border-border bg-bg/95"
    >
      <div className="border-b border-border px-4 py-4">
        <div className="text-[10px] font-semibold tracking-[0.18em] text-text-dim">
          {t("workspace.label")}
        </div>
        <h2 className="mt-1 truncate text-base font-bold text-text">{props.workspaceName}</h2>
        <div className="mt-1 text-xs text-text-muted">
          {t("workspace.summary", {
            players: props.players.filter((player) => player.online).length,
            npcs: props.npcs.filter((npc) => npc.active).length,
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        <section aria-labelledby="workspace-spaces-heading">
          <h3
            id="workspace-spaces-heading"
            className="px-2 pb-1 text-[11px] font-bold text-text-dim"
          >
            {t("workspace.spaces")}
          </h3>
          <div className="rounded-lg bg-surface-raised px-3 py-2 text-sm font-medium text-text">
            {props.workspaceName}
          </div>
        </section>

        <section className="mt-5" aria-labelledby="workspace-rooms-heading">
          <div className="flex items-center justify-between px-2 pb-1">
            <h3 id="workspace-rooms-heading" className="text-[11px] font-bold text-text-dim">
              {t("workspace.conversations")}
            </h3>
            <button
              type="button"
              onClick={() => props.onCompose([])}
              className="rounded px-2 py-1 text-[11px] font-medium text-primary hover:bg-surface-raised"
            >
              + {t("room.new")}
            </button>
          </div>
          <div className="space-y-1">
            {sortRooms(props.rooms).map((room) => {
              const roomName = room.kind === "office" ? t("room.office") : room.name;
              const approvals = room.id === props.currentRoomId ? 0 : (roomApprovals[room.id] ?? 0);
              const approvalBadge =
                approvals > 0 ? t("approvals.roomBadge", { n: approvals }) : null;
              return (
                <button
                  type="button"
                  key={room.id}
                  onClick={() => props.onSelectRoom(room.id)}
                  aria-current={room.id === props.currentRoomId ? "page" : undefined}
                  aria-label={approvalBadge ? `${roomName}, ${approvalBadge}` : roomName}
                  className={`w-full rounded-lg px-3 py-2 text-left ${
                    room.id === props.currentRoomId
                      ? "bg-surface-raised"
                      : "hover:bg-surface-raised/70"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <span className="block min-w-0 flex-1 truncate text-sm font-medium text-text">
                      {roomName}
                    </span>
                    {approvalBadge && (
                      <span
                        data-room-approvals={room.id}
                        className="shrink-0 rounded bg-npc/15 px-1.5 py-0.5 text-[10px] font-semibold text-npc-dark"
                      >
                        {approvalBadge}
                      </span>
                    )}
                  </span>
                  {room.lastMessage && (
                    <span className="mt-0.5 block truncate text-[11px] text-text-dim">
                      {room.lastMessage.senderName}: {roomMessagePreview(room.lastMessage, t)}
                    </span>
                  )}
                </button>
              );
            })}
            {(props.dmThreads ?? []).map((thread) => (
              <button
                type="button"
                key={`dm-${thread.npcId}`}
                onClick={() => props.onSelectDm?.(thread.npcId, thread.npcName)}
                aria-current={thread.npcId === props.selectedNpcId ? "page" : undefined}
                aria-label={t("workspace.dmLabel", { name: thread.npcName })}
                className={`w-full rounded-lg px-3 py-2 text-left ${
                  thread.npcId === props.selectedNpcId
                    ? "bg-surface-raised"
                    : "hover:bg-surface-raised/70"
                }`}
              >
                <span className="block truncate text-sm font-medium text-text">
                  {thread.npcName}
                  {!thread.active && (
                    <span className="ml-1 text-[11px] font-normal text-text-dim">
                      · {t("workspace.status.resting")}
                    </span>
                  )}
                </span>
                <span className="mt-0.5 block truncate text-[11px] text-text-dim">
                  {thread.lastMessage.role === "player" ? t("game.you") : thread.npcName}:{" "}
                  {thread.lastMessage.content}
                </span>
              </button>
            ))}
          </div>
        </section>

        <section className="mt-5" aria-labelledby="workspace-people-heading">
          <h3
            id="workspace-people-heading"
            className="px-2 pb-1 text-[11px] font-bold text-text-dim"
          >
            {t("workspace.people")}
          </h3>
          <div className="space-y-0.5">
            {props.players.map((player) => (
              <ParticipantRow
                key={player.id}
                name={player.name}
                detail={
                  player.self
                    ? t("game.you")
                    : player.online
                      ? t("room.online")
                      : t("workspace.status.offline")
                }
                appearance={player.appearance}
                onSelect={() => props.onSelectPlayer(player.id)}
              />
            ))}
            {props.npcs.map((npc) => (
              <ParticipantRow
                key={npc.id}
                name={npc.name}
                detail={npcDetail(npc, t)}
                appearance={npc.appearance ?? null}
                selected={npc.id === props.selectedNpcId}
                onSelect={() => props.onSelectNpc(npc.id, npc.name)}
                menuLabel={t("workspace.npc.menuLabel", { name: npc.name })}
                onOpenMenu={() => setMenuNpcId((current) => (current === npc.id ? null : npc.id))}
              />
            ))}
          </div>
        </section>
      </div>

      {selectedNpc && (
        <div role="menu" className="m-2 rounded-lg border border-border bg-surface p-1 shadow-xl">
          {selectedNpc.motion === "idle" && selectedNpc.active && selectedNpc.placed && (
            <button
              role="menuitem"
              onClick={() => action("call")}
              className="w-full rounded px-3 py-2 text-left text-sm hover:bg-surface-raised"
            >
              {t("workspace.action.call")}
            </button>
          )}
          {selectedNpc.motion === "waiting" && selectedNpc.calledByViewer && (
            <button
              role="menuitem"
              onClick={() => action("return")}
              className="w-full rounded px-3 py-2 text-left text-sm hover:bg-surface-raised"
            >
              {t("npc.return")}
            </button>
          )}
          {props.isOwner && (
            <>
              <button
                role="menuitem"
                onClick={() => action("place")}
                className="w-full rounded px-3 py-2 text-left text-sm hover:bg-surface-raised"
              >
                {t("npc.move")}
              </button>
              <button
                role="menuitem"
                onClick={() => action("profile")}
                className="w-full rounded px-3 py-2 text-left text-sm hover:bg-surface-raised"
              >
                {t("workspace.action.profile")}
              </button>
            </>
          )}
          <button
            role="menuitem"
            onClick={() => action("reset-chat")}
            className="w-full rounded px-3 py-2 text-left text-sm hover:bg-surface-raised"
          >
            {t("context.resetChat")}
          </button>
          {props.isOwner && (
            <button
              role="menuitem"
              onClick={() => action(selectedNpc.active ? "sleep" : "wake")}
              className="w-full rounded px-3 py-2 text-left text-sm text-danger hover:bg-surface-raised"
            >
              {selectedNpc.active ? t("npc.sleep") : t("npc.wake")}
            </button>
          )}
        </div>
      )}
      <div className="grid grid-cols-2 gap-1 border-t border-border p-2">
        {props.onInvitePeople && (
          <button
            type="button"
            onClick={props.onInvitePeople}
            className="rounded-md px-2 py-2 text-xs text-text-secondary hover:bg-surface-raised"
          >
            {t("workspace.action.invite")}
          </button>
        )}
        {props.onEditSelf && (
          <button
            type="button"
            onClick={props.onEditSelf}
            className="rounded-md px-2 py-2 text-xs text-text-secondary hover:bg-surface-raised"
          >
            {t("game.editCharacter")}
          </button>
        )}
        {props.isOwner && props.onSetStartPosition && (
          <button
            type="button"
            onClick={props.onSetStartPosition}
            className="rounded-md px-2 py-2 text-xs text-text-secondary hover:bg-surface-raised"
          >
            {t("game.setStartPosition")}
          </button>
        )}
        {props.isOwner && props.onAddNpc && (
          <button
            type="button"
            disabled={props.addNpcDisabled}
            onClick={props.onAddNpc}
            className="rounded-md px-2 py-2 text-xs text-primary hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("game.roster.hire")}
          </button>
        )}
      </div>
    </nav>
  );
}
