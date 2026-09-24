"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Sparkles, X } from "lucide-react";

import { useT } from "@/lib/i18n";

import CuratorBar from "./CuratorBar";
import LearningGraph from "./LearningGraph";
import SkillAddPane from "./SkillAddPane";
import SkillArchivePane from "./SkillArchivePane";
import SkillDetailPane from "./SkillDetailPane";
import { skillErrorText } from "./skill-error-text";
import { SkillsApiError, createSkillsApi, type SkillListView, type SkillsApi } from "./skills-api";
import {
  groupSkills,
  isValidSkillName,
  skillTemplate,
  unusedSkillNames,
} from "./skills-view-model";

type Tab = "installed" | "archive" | "graph" | "add";
type AddMode = "new" | "hub" | "url";
type Bulk = { enable: string[]; disable: string[] };

export type SkillManagerModalProps = {
  channelId: string;
  npcId: string;
  npcName: string;
  onClose(): void;
  /** Skill to preselect when opening — comes from [Edit] on the chat window's [Skills] tab. */
  initialSkill?: string | null;
  api?: SkillsApi;
};

/**
 * Skill manager modal for a single employee. [Installed] shows a left list / right detail pane;
 * [Archive] · [Learning graph] · [Add] are separate tabs. Any channel member can view, but change
 * buttons are only rendered for `canManage` (gateway owner) — the server also blocks with 403.
 */
export default function SkillManagerModal({
  channelId,
  npcId,
  npcName,
  onClose,
  initialSkill = null,
  api: injected,
}: SkillManagerModalProps) {
  const t = useT();
  const api = useMemo(
    () => injected ?? createSkillsApi(channelId, npcId),
    [injected, channelId, npcId],
  );
  const [view, setView] = useState<SkillListView | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [tab, setTab] = useState<Tab>("installed");
  const [selected, setSelected] = useState<string | null>(initialSkill);
  const [archivedCount, setArchivedCount] = useState<number | null>(null);
  const [bulk, setBulk] = useState<Bulk | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [addMode, setAddMode] = useState<AddMode | null>(null);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");

  const load = useCallback(async () => {
    // The archive count is just a number next to the tab name, so a failure here doesn't block the list.
    void api.listArchived().then(
      (rows) => setArchivedCount(rows.length),
      () => setArchivedCount(null),
    );
    try {
      setView(await api.list());
      setLoadError(null);
    } catch (e) {
      setLoadError(e);
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Don't close if a higher layer inside the modal (e.g. a zoomed view) already handled and preventDefault'd it.
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (e) {
      setActionError(skillErrorText(t, e));
    } finally {
      setBusy(false);
    }
  };

  const applyBulk = (b: Bulk) =>
    run(async () => {
      await api.setEnabledBulk(b.enable, b.disable);
      setBulk(null);
      await load();
    });
  const create = () =>
    run(async () => {
      await api.create(newName, undefined, skillTemplate(newName, newDesc.trim()));
      setAddMode(null);
      setNewName("");
      setNewDesc("");
      setTab("installed");
      setSelected(newName);
      await load();
    });

  const canManage = view?.canManage ?? false;
  const tabs: Tab[] = canManage
    ? ["installed", "archive", "graph", "add"]
    : ["installed", "archive", "graph"];
  const all = view?.skills ?? [];
  const bulkCount = bulk ? bulk.enable.length + bulk.disable.length : 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="skill-manager-title"
        className="flex h-[88dvh] w-[96vw] max-w-[1200px] flex-col rounded-xl border border-border bg-bg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex flex-shrink-0 items-center gap-3 border-b border-border px-5 py-3">
          <h2 id="skill-manager-title" className="flex items-center gap-1.5 text-sm font-bold">
            <Sparkles className="h-4 w-4" />
            {t("skills.manager.title", { name: npcName })}
          </h2>
          <nav className="flex gap-1 text-xs" role="tablist">
            {tabs.map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                data-tab={k}
                aria-selected={tab === k}
                onClick={() => setTab(k)}
                className={`flex items-center gap-1 rounded px-2 py-1 ${
                  tab === k ? "text-primary" : "text-text-muted hover:text-text"
                }`}
              >
                {k === "add" && <Plus className="h-3 w-3" />}
                {k === "add" ? t("skills.add") : t(`skills.tab.${k}`)}
                {k === "archive" && archivedCount !== null && archivedCount > 0 && (
                  <span data-badge="archive" className="text-text-dim">
                    {archivedCount}
                  </span>
                )}
              </button>
            ))}
          </nav>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="text-text-muted hover:text-text"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        {loadError !== null ? (
          <p className="p-5 text-sm text-danger">
            {t(
              loadError instanceof SkillsApiError && loadError.status === 409
                ? "skills.gateway"
                : "skills.error.generic",
            )}
          </p>
        ) : !view ? null : (
          <>
            <CuratorBar api={api} canManage={canManage} onRunFinished={() => void load()} />
            {actionError && <p className="px-5 py-1 text-xs text-danger">{actionError}</p>}
            {tab === "installed" && (
              <div className="flex min-h-0 flex-1">
                <aside className="w-72 flex-shrink-0 overflow-y-auto border-r border-border p-2 text-sm">
                  {canManage && view.sharedChannelCount > 0 && (
                    <p className="mb-2 px-1 text-[11px] text-text-muted">
                      {t("skills.shared", { count: view.sharedChannelCount })}
                    </p>
                  )}
                  {canManage && (
                    <div className="mb-2 flex flex-wrap gap-2 px-1 text-xs">
                      <button
                        type="button"
                        data-action="enable-all"
                        className="text-primary"
                        onClick={() =>
                          setBulk({
                            enable: all.filter((r) => r.disabled).map((r) => r.name),
                            disable: [],
                          })
                        }
                      >
                        {t("skills.bulk.enableAll")}
                      </button>
                      <button
                        type="button"
                        data-action="disable-all"
                        className="text-primary"
                        onClick={() =>
                          setBulk({
                            enable: [],
                            disable: all
                              .filter((r) => !r.disabled && !r.essential)
                              .map((r) => r.name),
                          })
                        }
                      >
                        {t("skills.bulk.disableAll")}
                      </button>
                      <button
                        type="button"
                        data-action="disable-unused"
                        className="text-primary"
                        onClick={() => setBulk({ enable: [], disable: unusedSkillNames(all) })}
                      >
                        {t("skills.bulk.disableUnused")}
                      </button>
                    </div>
                  )}
                  {bulk && (
                    <div className="mb-2 rounded border border-border p-2 text-xs">
                      {bulkCount === 0 ? (
                        <p className="text-text-muted">{t("skills.bulk.nothing")}</p>
                      ) : (
                        <>
                          <p className="text-text">
                            {t("skills.bulk.confirm", { count: bulkCount })}
                          </p>
                          <p className="mt-1 break-words text-text-muted">
                            {[...bulk.enable, ...bulk.disable].join(", ")}
                          </p>
                        </>
                      )}
                      <div className="mt-2 flex gap-3">
                        {bulkCount > 0 && (
                          <button
                            type="button"
                            data-action="confirm-bulk"
                            disabled={busy}
                            className="text-primary disabled:opacity-50"
                            onClick={() => void applyBulk(bulk)}
                          >
                            {t("common.confirm")}
                          </button>
                        )}
                        <button
                          type="button"
                          className="text-text-muted"
                          onClick={() => setBulk(null)}
                        >
                          {t("common.cancel")}
                        </button>
                      </div>
                    </div>
                  )}
                  {all.length === 0 && <p className="p-2 text-text-dim">{t("skills.empty")}</p>}
                  {groupSkills(all, "").map((g) => (
                    <section key={g.key}>
                      <h4 className="mt-2 px-1 text-[11px] font-semibold text-text-muted">
                        {t(`skills.group.${g.key}`)}
                      </h4>
                      {g.rows.map((r) => (
                        <button
                          key={r.name}
                          type="button"
                          data-skill={r.name}
                          onClick={() => setSelected(r.name)}
                          className={`flex w-full items-center gap-2 truncate rounded px-2 py-1 text-left ${
                            selected === r.name
                              ? "bg-surface-raised text-text"
                              : "text-text-muted hover:text-text"
                          }`}
                        >
                          <span className="min-w-0 flex-1 truncate">{r.name}</span>
                          {r.disabled && (
                            <span className="text-[10px] text-text-dim">{t("skills.off")}</span>
                          )}
                        </button>
                      ))}
                    </section>
                  ))}
                </aside>
                <main className="min-w-0 flex-1">
                  {!selected && (
                    <p data-hint="pick-skill" className="p-5 text-sm text-text-dim">
                      {t("skills.pickSkill")}
                    </p>
                  )}
                  {selected && (
                    <SkillDetailPane
                      key={selected}
                      api={api}
                      name={selected}
                      canManage={canManage}
                      onChanged={() => void load()}
                      onRemoved={() => setSelected(null)}
                    />
                  )}
                </main>
              </div>
            )}
            {tab === "add" && canManage && (
              <div className="min-h-0 flex-1 overflow-y-auto p-5 text-sm">
                <div className="mb-3 flex gap-3">
                  {(["new", "hub", "url"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      data-add={m}
                      onClick={() => setAddMode(m)}
                      className={addMode === m ? "text-primary" : "text-text-muted hover:text-text"}
                    >
                      {t(`skills.add.${m}`)}
                    </button>
                  ))}
                </div>
                {addMode === "new" && (
                  <div className="flex max-w-md flex-col gap-2">
                    <input
                      name="skill-name"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder={t("skills.create.name")}
                      aria-label={t("skills.create.name")}
                      className="rounded bg-surface-raised px-2 py-1 text-text"
                    />
                    <input
                      name="skill-description"
                      value={newDesc}
                      onChange={(e) => setNewDesc(e.target.value)}
                      placeholder={t("skills.create.description")}
                      aria-label={t("skills.create.description")}
                      className="rounded bg-surface-raised px-2 py-1 text-text"
                    />
                    <button
                      type="button"
                      data-action="create"
                      disabled={busy || !isValidSkillName(newName) || !newDesc.trim()}
                      onClick={() => void create()}
                      className="self-start rounded bg-primary px-3 py-1 text-white disabled:opacity-50"
                    >
                      {t("skills.create.submit")}
                    </button>
                  </div>
                )}
                {(addMode === "hub" || addMode === "url") && (
                  <SkillAddPane api={api} mode={addMode} onInstalled={() => void load()} />
                )}
              </div>
            )}
            {tab === "archive" && (
              <SkillArchivePane api={api} canManage={canManage} onChanged={() => void load()} />
            )}
            {tab === "graph" && (
              <LearningGraph api={api} canManage={canManage} onChanged={() => void load()} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
