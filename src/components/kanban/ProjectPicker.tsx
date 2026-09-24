"use client";

/**
 * The header's project (= board) picker.
 *
 * If a channel has only one board, this **renders nothing** — a picker with nothing to pick from
 * just clutters the screen. It only appears with two or more.
 *
 * The chosen value persists per-user in `localStorage` (decision B-1). It isn't kept on the
 * server because people viewing the same channel need to be able to have different projects open.
 * Switching devices resets to the default project — that's an accepted trade-off.
 */

import { useCallback, useState } from "react";
import { FolderKanban } from "lucide-react";

import { useT } from "@/lib/i18n";

export type ProjectOption = {
  id: string;
  boardSlug: string;
  name: string | null;
  status: string;
  isEventCarrier: boolean;
  /**
   * `YYYY-MM-DD` or null. The picker doesn't use this, but it comes in the same response, and the
   * timeline's target-date line reads this value. The server (`ProjectView`) had been sending it
   * from the start.
   */
  targetDate?: string | null;
};

const STORAGE_PREFIX = "deskrpg:kanban:board:";

/** Browser storage throws in private mode or with blocked settings. The screen must still render even if this can't be read. */
function readStored(channelId: string): string | null {
  try {
    return window.localStorage.getItem(STORAGE_PREFIX + channelId);
  } catch {
    return null;
  }
}

function writeStored(channelId: string, boardSlug: string | null) {
  try {
    if (boardSlug === null) window.localStorage.removeItem(STORAGE_PREFIX + channelId);
    else window.localStorage.setItem(STORAGE_PREFIX + channelId, boardSlug);
  } catch {
    // Even if this can't be saved, the choice still shows correctly for this session.
  }
}

/**
 * Returns the chosen board. If the stored value isn't in the current list (the board disappeared,
 * or it's a value from another device), falls back to the default board and clears the stored
 * value — continuing to request a nonexistent board only yields 404s.
 */
export function useSelectedBoard(channelId: string, options: ProjectOption[]) {
  // Storage is read once, on the first render. The chosen value must survive even while the list
  // is still empty — that way, reopening the modal doesn't briefly flash the default board before
  // showing the project you'd been viewing.
  const [stored, setStored] = useState<string | null>(() =>
    typeof window === "undefined" ? null : readStored(channelId),
  );
  const [channel, setChannel] = useState(channelId);
  if (channel !== channelId) {
    // When the channel changes, switch to that channel's value (state swap during render — one beat ahead of an effect).
    setChannel(channelId);
    setStored(typeof window === "undefined" ? null : readStored(channelId));
  }

  // If the stored value isn't in the current list (the board disappeared, or it's another
  // device's value), fall back to the default board **at the derivation step** — continuing to
  // request a nonexistent board only yields 404s.
  //
  // The stored value itself is not cleared here. This is so a momentarily empty list (a fetch
  // failure) doesn't permanently erase the user's choice — once that board reappears in the list,
  // the selection comes right back. A board that's truly gone gets overwritten by the next choice.
  const known = options.length === 0 || options.some((o) => o.boardSlug === stored);

  const select = useCallback(
    (boardSlug: string | null) => {
      setStored(boardSlug);
      writeStored(channelId, boardSlug);
    },
    [channelId],
  );

  return { selected: known ? stored : null, select };
}

export function ProjectPicker({
  options,
  selected,
  onSelect,
}: {
  options: ProjectOption[];
  /** null means the default (event-carrier) board */
  selected: string | null;
  onSelect(boardSlug: string | null): void;
}) {
  const t = useT();
  if (options.length < 2) return null;

  const fallback = options.find((o) => o.isEventCarrier) ?? options[0];
  const value = selected ?? fallback.boardSlug;

  return (
    <label className="flex items-center gap-1 text-xs text-text-secondary">
      <FolderKanban className="w-3.5 h-3.5" aria-hidden />
      <span className="sr-only">{t("kanban.project.pick")}</span>
      <select
        data-project-picker
        value={value}
        onChange={(e) => {
          const next = e.target.value;
          onSelect(next === fallback.boardSlug ? null : next);
        }}
        className="bg-surface-raised text-text-primary rounded-md px-2 py-1 max-w-[180px] truncate"
      >
        {options.map((option) => (
          <option key={option.boardSlug} value={option.boardSlug}>
            {option.name ?? option.boardSlug}
          </option>
        ))}
      </select>
    </label>
  );
}
