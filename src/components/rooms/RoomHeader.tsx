"use client";

import { useState } from "react";
import { useT } from "@/lib/i18n";
import type { RoomSummary } from "@/lib/chat-rooms-policy";
import RosterAvatar from "../RosterAvatar";

interface RoomHeaderProps {
  room: RoomSummary;
  /** Whether I created this room — only the creator can rename/delete it. */
  canManage: boolean;
  onBack: () => void;
  onClose: () => void;
  onInvite: () => void;
  onRename: (name: string) => void;
  onLeave: () => void;
  onDelete: () => void;
  /** Looks up a participant's appearance — if present, stacks avatars next to the room name. */
  avatarFor?: (who: { kind: "npc" | "user"; id?: string | null; name: string }) => unknown;
  /** People to show when the room has no separate member list (the whole office) — connected users and NPCs on shift. */
  fallbackParticipants?: Participant[];
}

type Participant = { kind: "npc" | "user"; id: string; name: string };

/** Number of avatars drawn in the header. Overflow collapses into `+N`. */
const MAX_HEADER_AVATARS = 5;

export default function RoomHeader({
  room,
  canManage,
  onBack,
  onClose,
  onInvite,
  onRename,
  onLeave,
  onDelete,
  avatarFor,
  fallbackParticipants = [],
}: RoomHeaderProps) {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(room.name);

  // The office room is the channel itself — invite/leave/delete don't apply.
  const isOffice = room.kind === "office";
  const memberLine = room.members.map((member) => member.name).join(", ");
  const participants: Participant[] = room.members.length > 0 ? room.members : fallbackParticipants;
  const shown = participants.slice(0, MAX_HEADER_AVATARS);
  const hidden = participants.length - shown.length;

  const commitRename = () => {
    const next = draft.trim();
    setRenaming(false);
    if (next && next !== room.name) onRename(next);
    else setDraft(room.name);
  };

  return (
    <div className="px-3 py-2 border-b border-border bg-surface/60">
      <div className="flex items-center gap-2">
        <button
          onClick={onBack}
          aria-label={t("room.list")}
          title={t("room.list")}
          className="text-text-muted hover:text-text text-sm whitespace-nowrap"
        >
          &#9664; {t("room.list")}
        </button>
        {renaming ? (
          <input
            type="text"
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitRename();
              if (event.key === "Escape") {
                setDraft(room.name);
                setRenaming(false);
              }
            }}
            className="flex-1 min-w-0 px-2 py-1 rounded bg-surface border border-border text-sm text-text"
          />
        ) : (
          <span className="flex-1 min-w-0 truncate text-sm font-bold text-text-secondary">
            {isOffice ? t("room.office") : room.name}
          </span>
        )}
        {avatarFor && shown.length > 0 && !renaming && (
          <span
            data-room-avatars
            className="flex shrink-0 items-center"
            title={participants.map((who) => who.name).join(", ")}
          >
            {shown.map((who, index) => (
              <span
                key={`${who.kind}:${who.id}`}
                data-room-avatar
                className={`rounded-full ring-2 ring-bg ${index > 0 ? "-ml-2" : ""}`}
              >
                <RosterAvatar appearance={avatarFor(who)} size={22} />
              </span>
            ))}
            {hidden > 0 && (
              <span data-room-avatar-more className="ml-1 text-[11px] text-text-muted">
                +{hidden}
              </span>
            )}
          </span>
        )}
        <button
          onClick={onClose}
          aria-label={t("common.close")}
          title={t("common.close")}
          className="text-text-muted hover:text-text text-lg px-1"
        >
          ×
        </button>
        {!isOffice && (
          <div className="relative">
            <button
              onClick={() => setMenuOpen((open) => !open)}
              className="text-text-muted hover:text-text text-sm px-1"
              title={t("chat.options")}
            >
              &#8943;
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-full mt-1 bg-surface border border-border rounded-lg shadow-xl py-1 min-w-[140px] z-50">
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    onInvite();
                  }}
                  className="w-full text-left px-3 py-2 text-sm text-text hover:bg-surface-raised"
                >
                  {t("room.invite")}
                </button>
                {canManage && (
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      setDraft(room.name);
                      setRenaming(true);
                    }}
                    className="w-full text-left px-3 py-2 text-sm text-text hover:bg-surface-raised"
                  >
                    {t("room.rename")}
                  </button>
                )}
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    onLeave();
                  }}
                  className="w-full text-left px-3 py-2 text-sm text-text-muted hover:bg-surface-raised"
                >
                  {t("room.leave")}
                </button>
                {canManage && (
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      onDelete();
                    }}
                    className="w-full text-left px-3 py-2 text-sm text-danger hover:bg-surface-raised"
                  >
                    {t("room.delete")}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      {memberLine && (
        <div className="mt-0.5 pl-5 text-[11px] text-text-dim truncate">{memberLine}</div>
      )}
    </div>
  );
}
