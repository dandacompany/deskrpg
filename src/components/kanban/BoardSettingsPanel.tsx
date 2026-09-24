"use client";
import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";

import { useT } from "@/lib/i18n";

import { toFailure, type BoardSettings, type KanbanApi } from "./kanban-api";
import { failureLine } from "./kanban-view-model";

interface BoardSettingsPanelProps {
  api: KanbanApi;
  onClose: () => void;
}

const FIELD =
  "w-full rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-text disabled:opacity-60 disabled:cursor-not-allowed";
const LABEL = "block text-[11px] font-semibold text-text-secondary mb-1";

type OrchestrationDraft = {
  orchestrator_profile: string;
  default_assignee: string;
  auto_decompose: boolean;
  max_in_progress: string;
  max_in_progress_per_profile: string;
};

function draftFrom(settings: BoardSettings): OrchestrationDraft {
  const o = settings.orchestration;
  return {
    orchestrator_profile: o?.orchestrator_profile ?? "",
    default_assignee: o?.default_assignee ?? "",
    auto_decompose: o?.auto_decompose ?? false,
    max_in_progress: o?.max_in_progress != null ? String(o.max_in_progress) : "",
    max_in_progress_per_profile:
      o?.max_in_progress_per_profile != null ? String(o.max_in_progress_per_profile) : "",
  };
}

/**
 * Board settings — `board.default_workdir` (channel owner) and `orchestration` (gateway owner).
 * `editable` is decided by the server — this component just locks the inputs accordingly and
 * does not re-judge permissions. If `orchestration` is null, that whole section is hidden.
 */
export default function BoardSettingsPanel({ api, onClose }: BoardSettingsPanelProps) {
  const t = useT();
  const [settings, setSettings] = useState<BoardSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [workdir, setWorkdir] = useState("");
  const [draft, setDraft] = useState<OrchestrationDraft | null>(null);
  const [saving, setSaving] = useState<"board" | "orchestration" | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.settings();
      setSettings(data);
      setWorkdir(data.board.default_workdir ?? "");
      setDraft(draftFrom(data));
    } catch (err) {
      setError(failureLine(toFailure(err)));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const applyResponse = (data: BoardSettings) => {
    setSettings(data);
    setWorkdir(data.board.default_workdir ?? "");
    setDraft(draftFrom(data));
    setSaved(true);
  };

  const saveBoard = async () => {
    setSaving("board");
    setError(null);
    setSaved(false);
    try {
      applyResponse(await api.patchSettings({ board: { default_workdir: workdir } }));
    } catch (err) {
      setError(failureLine(toFailure(err)));
    } finally {
      setSaving(null);
    }
  };

  const saveOrchestration = async () => {
    if (!draft) return;
    setSaving("orchestration");
    setError(null);
    setSaved(false);
    const patch: Record<string, unknown> = {
      orchestrator_profile: draft.orchestrator_profile.trim() || null,
      default_assignee: draft.default_assignee.trim() || null,
      auto_decompose: draft.auto_decompose,
    };
    for (const key of ["max_in_progress", "max_in_progress_per_profile"] as const) {
      const n = Number(draft[key]);
      if (draft[key].trim() && Number.isInteger(n)) patch[key] = n;
    }
    try {
      applyResponse(await api.patchSettings({ orchestration: patch }));
    } catch (err) {
      setError(failureLine(toFailure(err)));
    } finally {
      setSaving(null);
    }
  };

  const boardEditable = settings?.board.editable ?? false;
  const orchestration = settings?.orchestration ?? null;
  const orchestrationEditable = orchestration?.editable ?? false;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="kanban-settings-title"
        onClick={(e) => e.stopPropagation()}
        className="bg-bg border border-border rounded-xl shadow-2xl w-[92vw] max-w-[560px] max-h-[86dvh] flex flex-col"
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h3 id="kanban-settings-title" className="text-sm font-bold">
            {t("kanban.settings.title")}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="text-text-muted hover:text-text"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5 text-xs">
          {loading ? (
            <div className="text-text-dim">{t("common.loading")}</div>
          ) : settings ? (
            <>
              <section className="space-y-2" data-section="board">
                <div className="flex items-center justify-between">
                  <div className="font-bold text-text">
                    {t("kanban.settings.boardName")}: {settings.board.name ?? settings.board.slug}
                  </div>
                  {!boardEditable && (
                    <span className="text-[10px] text-text-dim">
                      {t("kanban.settings.readOnly")}
                    </span>
                  )}
                </div>
                <div>
                  <label className={LABEL} htmlFor="kanban-default-workdir">
                    {t("kanban.settings.defaultWorkdir")}
                  </label>
                  <input
                    id="kanban-default-workdir"
                    className={FIELD}
                    value={workdir}
                    disabled={!boardEditable}
                    onChange={(e) => setWorkdir(e.target.value)}
                  />
                </div>
                {boardEditable && (
                  <button
                    type="button"
                    onClick={() => void saveBoard()}
                    disabled={saving !== null}
                    className="px-3 py-1.5 rounded-lg bg-primary hover:bg-primary-hover text-white font-semibold disabled:opacity-60"
                  >
                    {saving === "board" ? t("common.loading") : t("common.save")}
                  </button>
                )}
              </section>

              {orchestration && draft && (
                <section
                  className="space-y-2 border-t border-border pt-4"
                  data-section="orchestration"
                >
                  <div className="flex items-center justify-between">
                    <div className="font-bold text-text">{t("kanban.settings.orchestration")}</div>
                    {!orchestrationEditable && (
                      <span className="text-[10px] text-text-dim">
                        {t("kanban.settings.readOnly")}
                      </span>
                    )}
                  </div>
                  <div>
                    <label className={LABEL} htmlFor="kanban-orchestrator-profile">
                      {t("kanban.settings.orchestratorProfile")}
                    </label>
                    <input
                      id="kanban-orchestrator-profile"
                      className={FIELD}
                      value={draft.orchestrator_profile}
                      disabled={!orchestrationEditable}
                      onChange={(e) => setDraft({ ...draft, orchestrator_profile: e.target.value })}
                    />
                    {orchestration.resolved_orchestrator_profile && (
                      <div className="mt-1 text-[10px] text-text-dim">
                        {t("kanban.settings.resolved", {
                          value: orchestration.resolved_orchestrator_profile,
                        })}
                      </div>
                    )}
                  </div>
                  <div>
                    <label className={LABEL} htmlFor="kanban-default-assignee">
                      {t("kanban.settings.defaultAssignee")}
                    </label>
                    <input
                      id="kanban-default-assignee"
                      className={FIELD}
                      value={draft.default_assignee}
                      disabled={!orchestrationEditable}
                      onChange={(e) => setDraft({ ...draft, default_assignee: e.target.value })}
                    />
                    {settings.hints.default_assignee_recommend_empty && (
                      <div className="mt-1 text-[10px] text-amber-700">
                        {t("kanban.settings.defaultAssigneeHint")}
                      </div>
                    )}
                    {orchestration.resolved_default_assignee && (
                      <div className="mt-1 text-[10px] text-text-dim">
                        {t("kanban.settings.resolved", {
                          value: orchestration.resolved_default_assignee,
                        })}
                      </div>
                    )}
                  </div>
                  <label className="flex items-center gap-2 text-text">
                    <input
                      type="checkbox"
                      checked={draft.auto_decompose}
                      disabled={!orchestrationEditable}
                      onChange={(e) => setDraft({ ...draft, auto_decompose: e.target.checked })}
                    />
                    {t("kanban.settings.autoDecompose")}
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={LABEL} htmlFor="kanban-max-in-progress">
                        {t("kanban.settings.maxInProgress")}
                      </label>
                      <input
                        id="kanban-max-in-progress"
                        type="number"
                        min={0}
                        className={FIELD}
                        value={draft.max_in_progress}
                        disabled={!orchestrationEditable}
                        onChange={(e) => setDraft({ ...draft, max_in_progress: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className={LABEL} htmlFor="kanban-max-in-progress-per-profile">
                        {t("kanban.settings.maxInProgressPerProfile")}
                      </label>
                      <input
                        id="kanban-max-in-progress-per-profile"
                        type="number"
                        min={0}
                        className={FIELD}
                        value={draft.max_in_progress_per_profile}
                        disabled={!orchestrationEditable}
                        onChange={(e) =>
                          setDraft({ ...draft, max_in_progress_per_profile: e.target.value })
                        }
                      />
                    </div>
                  </div>
                  {orchestrationEditable && (
                    <button
                      type="button"
                      onClick={() => void saveOrchestration()}
                      disabled={saving !== null}
                      className="px-3 py-1.5 rounded-lg bg-primary hover:bg-primary-hover text-white font-semibold disabled:opacity-60"
                    >
                      {saving === "orchestration" ? t("common.loading") : t("common.save")}
                    </button>
                  )}
                </section>
              )}
            </>
          ) : null}

          {saved && !error && (
            <div className="text-success text-[11px]">{t("kanban.settings.saved")}</div>
          )}
          {error && (
            <div
              role="alert"
              className="rounded-md border border-danger/40 bg-danger-bg px-3 py-2 text-danger break-words"
            >
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
