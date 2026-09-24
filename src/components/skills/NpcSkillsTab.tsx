"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pin, Settings2 } from "lucide-react";

import { useT } from "@/lib/i18n";
import { SKILL_ADMIN_MIN_VERSION } from "@/lib/hermes/deskrpg-plugin-types";
import type { SkillRow } from "@/lib/hermes/plugin-client-types";

import { skillErrorText } from "./skill-error-text";
import { SkillsApiError, createSkillsApi, type SkillListView, type SkillsApi } from "./skills-api";
import { groupSkills } from "./skills-view-model";

export type NpcSkillsTabProps = {
  channelId: string;
  npcId: string;
  /** Opens the manager modal. If `skillName` is given, opens it with that skill selected (a row's [Edit]). */
  onOpenManager(skillName?: string): void;
  api?: SkillsApi;
};

/**
 * The [Skills] tab of the NPC chat window — shows the skills this NPC (Hermes profile) has,
 * grouped by origin. Members get read-only access; the gateway owner (`canManage`) gets the
 * enable/disable switches. Editing, adding, and cleanup all belong to the manager modal.
 */
export default function NpcSkillsTab({
  channelId,
  npcId,
  onOpenManager,
  api: injected,
}: NpcSkillsTabProps) {
  const t = useT();
  const api = useMemo(
    () => injected ?? createSkillsApi(channelId, npcId),
    [injected, channelId, npcId],
  );
  const [view, setView] = useState<SkillListView | null>(null);
  const [loadError, setLoadError] = useState<SkillsApiError | Error | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  // Prevents a late response for the previous NPC from overwriting the list right after switching NPCs.
  const sequence = useRef(0);

  const load = useCallback(async () => {
    const seq = ++sequence.current;
    try {
      const next = await api.list();
      if (seq !== sequence.current) return;
      setView(next);
      setLoadError(null);
    } catch (e) {
      if (seq !== sequence.current) return;
      setView(null);
      setLoadError(e instanceof Error ? e : new Error(String(e)));
    }
  }, [api]);

  useEffect(() => {
    setView(null);
    void load();
  }, [load]);

  const toggle = async (row: SkillRow) => {
    setBusy(row.name);
    setActionError(null);
    try {
      await api.setEnabled(row.name, row.disabled);
    } catch (e) {
      setActionError(skillErrorText(t, e));
    } finally {
      setBusy(null);
      await load();
    }
  };

  if (loadError) {
    const gateway = loadError instanceof SkillsApiError && loadError.status === 409;
    return (
      <p className="p-3 text-sm text-danger">
        {t(gateway ? "skills.gateway" : "skills.error.generic")}
      </p>
    );
  }
  if (!view) return null;
  const groups = groupSkills(view.skills, q);

  return (
    <div className="flex h-full flex-col text-sm">
      <div className="flex items-center gap-2 border-b border-border p-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("skills.search")}
          aria-label={t("skills.search")}
          className="min-w-0 flex-1 rounded bg-surface-raised px-2 py-1 text-text"
        />
        {view.capabilityReady && (
          <button
            type="button"
            data-testid="open-skill-manager"
            onClick={() => onOpenManager()}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-primary hover:bg-surface-raised"
          >
            <Settings2 className="h-3.5 w-3.5" />
            {t("skills.openManager")}
          </button>
        )}
      </div>
      {!view.capabilityReady && (
        <p className="px-3 py-2 text-xs text-text-muted">
          {t("skills.upgrade", { version: SKILL_ADMIN_MIN_VERSION })}
        </p>
      )}
      {view.canManage && view.sharedChannelCount > 0 && (
        <p className="px-3 py-2 text-xs text-text-muted">
          {t("skills.shared", { count: view.sharedChannelCount })}
        </p>
      )}
      {actionError && <p className="px-3 py-1 text-xs text-danger">{actionError}</p>}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {groups.length === 0 && <p className="p-3 text-text-dim">{t("skills.empty")}</p>}
        {groups.map((g) => (
          <section key={g.key} className="mt-2">
            <h4 className="px-1 text-[11px] font-semibold text-text-muted">
              {t(`skills.group.${g.key}`)}
            </h4>
            {g.rows.map((row) => (
              <div key={row.name} className="rounded px-1 py-1 hover:bg-surface-raised">
                <div className="flex items-center gap-2">
                  {view.canManage ? (
                    <button
                      type="button"
                      role="switch"
                      aria-checked={!row.disabled}
                      aria-label={row.name}
                      disabled={row.essential || busy !== null}
                      onClick={() => void toggle(row)}
                      className={`relative h-4 w-7 flex-shrink-0 rounded-full transition-colors disabled:opacity-50 ${
                        row.disabled ? "bg-border" : "bg-primary"
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 h-3 w-3 rounded-full bg-surface transition-all ${
                          row.disabled ? "left-0.5" : "left-3.5"
                        }`}
                      />
                    </button>
                  ) : (
                    <span className="w-7 flex-shrink-0 text-[10px] text-text-muted">
                      {row.disabled ? t("skills.off") : t("skills.on")}
                    </span>
                  )}
                  <button
                    type="button"
                    data-skill-row={row.name}
                    aria-expanded={open === row.name}
                    onClick={() => setOpen(open === row.name ? null : row.name)}
                    className="min-w-0 flex-1 truncate text-left text-text"
                  >
                    {row.name}
                  </button>
                  {row.pinned && (
                    <Pin className="h-3 w-3 text-text-muted" aria-label={t("skills.pinned")} />
                  )}
                  {row.state === "stale" && (
                    <span className="text-[10px] text-text-muted">{t("skills.stale")}</span>
                  )}
                  {row.essential && (
                    <span className="text-[10px] text-text-muted">{t("skills.essential")}</span>
                  )}
                </div>
                <p className="pl-9 text-[11px] text-text-dim">
                  {t("skills.usage", { use: row.useCount ?? 0, view: row.viewCount ?? 0 })}
                </p>
                {open === row.name && (
                  <div className="pl-9 text-xs text-text-muted">
                    <p>{row.description}</p>
                    {row.lastUsedAt && (
                      <p className="text-text-dim">
                        {t("skills.lastUsed", { at: row.lastUsedAt.slice(0, 10) })}
                      </p>
                    )}
                    {view.capabilityReady && (
                      <button
                        type="button"
                        data-action="edit-in-manager"
                        onClick={() => onOpenManager(row.name)}
                        className="mt-1 text-primary"
                      >
                        {t(view.canManage ? "skills.edit" : "skills.openManager")}
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
