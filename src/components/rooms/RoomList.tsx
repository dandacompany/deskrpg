"use client";

import { useLocale, useT } from "@/lib/i18n";
import { sortRooms, type RoomSummary } from "@/lib/chat-rooms-policy";
import { roomMessagePreview } from "@/components/rooms/room-message-preview";

interface RoomListProps {
  rooms: RoomSummary[];
  currentRoomId: string | null;
  onOpen: (roomId: string) => void;
  onNew: () => void;
}

const MINUTE = 60_000;
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["minute", MINUTE],
  ["hour", 60 * MINUTE],
  ["day", 24 * 60 * MINUTE],
];

/**
 * A short relative-time snippet. Uses only `Intl.RelativeTimeFormat` to avoid pulling in
 * a dedicated library. Under 1 minute collapses to an empty string since "0 minutes ago" is awkward.
 */
export function relativeTime(iso: string | null, locale: string, now = Date.now()): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const diff = now - at;
  if (diff < MINUTE) return "";
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  let unit: Intl.RelativeTimeFormatUnit = "minute";
  let size = MINUTE;
  for (const [candidate, ms] of UNITS) {
    if (diff >= ms) {
      unit = candidate;
      size = ms;
    }
  }
  return format.format(-Math.floor(diff / size), unit);
}

/** Member name line: up to 3 names + `+N`. */
function memberLine(room: RoomSummary): string {
  const names = room.members.map((member) => member.name);
  if (names.length === 0) return "";
  const head = names.slice(0, 3).join(", ");
  return names.length > 3 ? `${head} +${names.length - 3}` : head;
}

export default function RoomList({ rooms, currentRoomId, onOpen, onNew }: RoomListProps) {
  const t = useT();
  const { locale } = useLocale();

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-xs font-bold text-text-dim">{t("room.list")}</span>
        <button
          onClick={onNew}
          className="text-xs px-2 py-1 rounded bg-surface-raised hover:brightness-125 text-npc font-medium"
        >
          + {t("room.new")}
        </button>
      </div>
      <div role="list" className="flex-1 overflow-y-auto px-2 py-2 space-y-1">
        {sortRooms(rooms).map((room) => {
          const members = memberLine(room);
          const when = relativeTime(room.lastMessageAt, locale);
          return (
            <div
              key={room.id}
              role="listitem"
              tabIndex={0}
              onClick={() => onOpen(room.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") onOpen(room.id);
              }}
              className={`cursor-pointer rounded-lg px-3 py-2 transition ${
                room.id === currentRoomId
                  ? "bg-surface-raised"
                  : "bg-surface hover:bg-surface-raised"
              }`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className={`shrink-0 w-2 h-2 rounded-full ${
                    room.kind === "office" ? "bg-npc" : "bg-primary"
                  }`}
                />
                <span className="text-sm font-medium text-text truncate">
                  {room.kind === "office" ? t("room.office") : room.name}
                </span>
                {when && <span className="ml-auto shrink-0 text-[11px] text-text-dim">{when}</span>}
              </div>
              {members && (
                <div className="mt-0.5 text-[11px] text-text-dim truncate">{members}</div>
              )}
              {room.lastMessage && (
                <div className="mt-0.5 text-xs text-text-muted truncate">
                  {room.lastMessage.senderName}: {roomMessagePreview(room.lastMessage, t)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
