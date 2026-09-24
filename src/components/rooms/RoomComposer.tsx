"use client";

import { useState } from "react";
import { useT } from "@/lib/i18n";

interface RoomComposerProps {
  mode: "create" | "invite";
  npcCandidates: { id: string; name: string }[];
  userCandidates: { id: string; name: string; online: boolean }[];
  presetNpcIds: string[];
  onSubmit: (args: { name: string; npcIds: string[]; userIds: string[] }) => void;
  onCancel: () => void;
}

/** Keeps only picked ones in candidate order — so the submitted value matches on-screen order. */
function ordered(candidates: { id: string }[], picked: Set<string>): string[] {
  return candidates
    .filter((candidate) => picked.has(candidate.id))
    .map((candidate) => candidate.id);
}

export default function RoomComposer({
  mode,
  npcCandidates,
  userCandidates,
  presetNpcIds,
  onSubmit,
  onCancel,
}: RoomComposerProps) {
  const t = useT();
  const [name, setName] = useState("");
  const [npcIds, setNpcIds] = useState<Set<string>>(() => new Set(presetNpcIds));
  const [userIds, setUserIds] = useState<Set<string>>(() => new Set());

  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  // Inviting means adding people to an existing room, so 0 NPCs is still valid (people-only invite).
  const needNpc = mode === "create" && npcIds.size === 0;
  const canSubmit = mode === "create" ? !needNpc : npcIds.size + userIds.size > 0;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
        {mode === "create" && (
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("room.name.placeholder")}
            className="w-full px-3 py-2 rounded-lg bg-surface border border-border text-sm text-text placeholder:text-text-dim"
          />
        )}

        <div>
          <div className="text-xs font-bold text-text-dim mb-1">{t("room.npcs")}</div>
          <div className="space-y-1">
            {npcCandidates.map((npc) => (
              <label
                key={npc.id}
                className="flex items-center gap-2 px-2 py-1.5 rounded bg-surface text-sm text-text cursor-pointer"
              >
                <input
                  type="checkbox"
                  data-npc-id={npc.id}
                  checked={npcIds.has(npc.id)}
                  onChange={() => setNpcIds((current) => toggle(current, npc.id))}
                />
                {npc.name}
              </label>
            ))}
          </div>
          {needNpc && <p className="mt-1 text-xs text-danger">{t("room.needNpc")}</p>}
        </div>

        {userCandidates.length > 0 && (
          <div>
            <div className="text-xs font-bold text-text-dim mb-1">{t("room.people")}</div>
            <div className="space-y-1">
              {userCandidates.map((user) => (
                <label
                  key={user.id}
                  className="flex items-center gap-2 px-2 py-1.5 rounded bg-surface text-sm text-text cursor-pointer"
                >
                  <input
                    type="checkbox"
                    data-user-id={user.id}
                    checked={userIds.has(user.id)}
                    onChange={() => setUserIds((current) => toggle(current, user.id))}
                  />
                  {user.name}
                  {user.online && (
                    <span className="ml-auto text-[11px] text-npc">{t("room.online")}</span>
                  )}
                </label>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 px-3 py-2 border-t border-border">
        <button
          onClick={onCancel}
          className="flex-1 px-3 py-2 rounded-lg bg-surface hover:bg-surface-raised text-sm text-text-muted"
        >
          {t("common.cancel")}
        </button>
        <button
          disabled={!canSubmit}
          onClick={() =>
            onSubmit({
              name: name.trim(),
              npcIds: ordered(npcCandidates, npcIds),
              userIds: ordered(userCandidates, userIds),
            })
          }
          className="flex-1 px-3 py-2 rounded-lg bg-primary text-sm font-medium text-white disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {mode === "create" ? t("room.create") : t("room.invite")}
        </button>
      </div>
    </div>
  );
}
