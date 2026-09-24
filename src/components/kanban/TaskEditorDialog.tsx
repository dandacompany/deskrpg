"use client";
import { useState, type FormEvent } from "react";
import { X } from "lucide-react";

import { useT } from "@/lib/i18n";
import type { KanbanTask } from "@/lib/hermes/deskrpg-plugin-types";

import {
  activeAssigneeOptions,
  taskFormToBody,
  type BoardNpc,
  type TaskFormValues,
} from "./kanban-view-model";

interface TaskEditorDialogProps {
  mode: "create" | "edit";
  initial: TaskFormValues;
  npcs: readonly BoardNpc[];
  /** Prerequisite-card candidates (same board). Excludes itself in edit mode. */
  candidates: readonly KanbanTask[];
  /** The server's 400 message, etc. — shown as-is (R8). */
  serverError: string | null;
  submitting: boolean;
  confirmChatDraft?: boolean;
  reviewSupported?: boolean;
  assigneeLocked?: boolean;
  onSubmit: (body: Record<string, unknown>) => void;
  onClose: () => void;
}

const WORKSPACE_KINDS = ["scratch", "worktree", "dir"] as const;
const REASONING_EFFORTS = ["low", "medium", "high"] as const;

const FIELD = "w-full rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-text";
const LABEL = "block text-[11px] font-semibold text-text-secondary mb-1";

/** Create/edit form (R8). Value interpretation is `taskFormToBody`'s job — this only collects input. */
export default function TaskEditorDialog({
  mode,
  initial,
  npcs,
  candidates,
  serverError,
  submitting,
  confirmChatDraft = false,
  reviewSupported = true,
  assigneeLocked = false,
  onSubmit,
  onClose,
}: TaskEditorDialogProps) {
  const t = useT();
  const [values, setValues] = useState<TaskFormValues>(initial);
  const [titleError, setTitleError] = useState(false);
  const [completionCriteria, setCompletionCriteria] = useState("");
  const [confirmationError, setConfirmationError] = useState(false);
  const assignees = activeAssigneeOptions(npcs);
  const implementer = assignees.find((npc) => npc.npcId === values.assigneeNpcId);
  const reviewers = assignees.filter(
    (npc) => npc.profileName.trim().toLowerCase() !== implementer?.profileName.trim().toLowerCase(),
  );
  const [reviewError, setReviewError] = useState(false);

  const set = <K extends keyof TaskFormValues>(key: K, value: TaskFormValues[K]) =>
    setValues((prev) => ({ ...prev, [key]: value }));

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (mode === "create" && !reviewSupported) return;
    if (
      values.reviewMode === "agent" &&
      (!implementer || !reviewers.some((npc) => npc.npcId === values.reviewerNpcId))
    ) {
      setReviewError(true);
      return;
    }
    setReviewError(false);
    if (!values.title.trim()) {
      setTitleError(true);
      return;
    }
    setTitleError(false);
    if (
      mode === "create" &&
      (!completionCriteria.trim() || !assignees.some((npc) => npc.npcId === values.assigneeNpcId))
    ) {
      setConfirmationError(true);
      return;
    }
    setConfirmationError(false);
    onSubmit(
      taskFormToBody(
        mode === "create"
          ? {
              ...values,
              body: `${values.body}\n\n${t("chat.taskCompletionCriteria")}\n${completionCriteria.trim()}`,
            }
          : values,
      ),
    );
  };

  const toggleParent = (id: string) =>
    set(
      "parents",
      values.parents.includes(id)
        ? values.parents.filter((p) => p !== id)
        : [...values.parents, id],
    );

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="kanban-editor-title"
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="bg-bg border border-border rounded-xl shadow-2xl w-[92vw] max-w-[640px] max-h-[86dvh] flex flex-col"
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h3 id="kanban-editor-title" className="text-sm font-bold">
            {mode === "create" ? t("kanban.form.createTitle") : t("kanban.form.editTitle")}
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

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          <div>
            <label className={LABEL} htmlFor="kanban-title">
              {t("kanban.form.title")} *
            </label>
            <input
              id="kanban-title"
              className={FIELD}
              value={values.title}
              onChange={(e) => set("title", e.target.value)}
              autoFocus
            />
            {titleError && (
              <div className="mt-1 text-[11px] text-danger">{t("kanban.form.titleRequired")}</div>
            )}
          </div>

          <div>
            <label className={LABEL} htmlFor="kanban-body">
              {t("kanban.form.body")}
            </label>
            <textarea
              id="kanban-body"
              className={`${FIELD} min-h-[96px]`}
              value={values.body}
              onChange={(e) => set("body", e.target.value)}
            />
          </div>

          {mode === "create" && (
            <div>
              {confirmChatDraft && (
                <p className="mb-2 text-xs text-text-secondary">{t("chat.taskConfirmationHelp")}</p>
              )}
              <label className={LABEL} htmlFor="kanban-completion-criteria">
                {t("chat.taskCompletionCriteria")} *
              </label>
              <textarea
                id="kanban-completion-criteria"
                className={`${FIELD} min-h-[64px]`}
                value={completionCriteria}
                onChange={(e) => setCompletionCriteria(e.target.value)}
              />
              {confirmationError && (
                <p role="alert" className="text-xs text-danger">
                  {t("chat.taskConfirmationRequired")}
                </p>
              )}
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={LABEL} htmlFor="kanban-assignee">
                {t("kanban.form.assignee")}
              </label>
              <select
                id="kanban-assignee"
                disabled={assigneeLocked}
                className={FIELD}
                value={values.assigneeNpcId}
                onChange={(e) => set("assigneeNpcId", e.target.value)}
              >
                <option value="">{t("kanban.form.assigneeNone")}</option>
                {assignees.map((npc) => (
                  <option key={npc.npcId} value={npc.npcId}>
                    {npc.npcName}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={LABEL} htmlFor="kanban-priority">
                {t("kanban.form.priority")}
              </label>
              <input
                id="kanban-priority"
                className={FIELD}
                value={values.priority}
                onChange={(e) => set("priority", e.target.value)}
              />
            </div>
          </div>

          {mode === "create" && !reviewSupported && (
            <p role="alert" className="text-xs text-danger">
              {t("kanban.review.unsupported")}
            </p>
          )}
          {values.reviewMode && (
            <fieldset className="space-y-2 rounded-md border border-border p-3">
              <label className={LABEL} htmlFor="kanban-review-mode">
                {t("kanban.review.label")}
              </label>
              <select
                id="kanban-review-mode"
                className={FIELD}
                value={values.reviewMode}
                onChange={(e) => set("reviewMode", e.target.value as "human" | "agent")}
              >
                <option value="human">{t("kanban.review.human")}</option>
                <option value="agent">{t("kanban.review.agent")}</option>
              </select>
              {values.reviewMode === "agent" && (
                <>
                  <label className={LABEL} htmlFor="kanban-reviewer">
                    {t("kanban.review.reviewer")}
                  </label>
                  <select
                    id="kanban-reviewer"
                    className={FIELD}
                    value={values.reviewerNpcId ?? ""}
                    onChange={(e) => set("reviewerNpcId", e.target.value)}
                  >
                    <option value="">{t("kanban.review.selectReviewer")}</option>
                    {reviewers.map((npc) => (
                      <option key={npc.npcId} value={npc.npcId}>
                        {npc.npcName}
                      </option>
                    ))}
                  </select>
                  {(!implementer || reviewers.length === 0 || reviewError) && (
                    <p role="alert" className="text-xs text-danger">
                      {t("kanban.review.reviewerRequired")}
                    </p>
                  )}
                </>
              )}
              <p className="text-xs text-text-secondary">{t("kanban.review.help")}</p>
            </fieldset>
          )}
          <div>
            <div className={LABEL}>{t("kanban.form.parents")}</div>
            {candidates.length === 0 ? (
              <div className="text-[11px] text-text-dim">{t("kanban.form.parentsNone")}</div>
            ) : (
              <div className="max-h-[120px] overflow-y-auto rounded-md border border-border p-2 space-y-1">
                {candidates.map((task) => (
                  <label key={task.id} className="flex items-center gap-2 text-xs text-text">
                    <input
                      type="checkbox"
                      checked={values.parents.includes(task.id)}
                      onChange={() => toggleParent(task.id)}
                    />
                    <span className="truncate">{task.title}</span>
                    <span className="ml-auto text-[10px] text-text-dim">
                      {t(`kanban.column.${task.status}`)}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={LABEL} htmlFor="kanban-workspace-kind">
                {t("kanban.form.workspaceKind")}
              </label>
              <select
                id="kanban-workspace-kind"
                className={FIELD}
                value={values.workspaceKind}
                onChange={(e) =>
                  set("workspaceKind", e.target.value as TaskFormValues["workspaceKind"])
                }
              >
                <option value="">{t("kanban.form.workspaceKindDefault")}</option>
                {WORKSPACE_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {t(`kanban.form.workspaceKind.${kind}`)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={LABEL} htmlFor="kanban-workspace-path">
                {t("kanban.form.workspacePath")}
              </label>
              <input
                id="kanban-workspace-path"
                className={FIELD}
                value={values.workspacePath}
                onChange={(e) => set("workspacePath", e.target.value)}
              />
            </div>
          </div>

          <div>
            <label className={LABEL} htmlFor="kanban-skills">
              {t("kanban.form.skills")}
            </label>
            <input
              id="kanban-skills"
              className={FIELD}
              placeholder={t("kanban.form.skillsHint")}
              value={values.skills}
              onChange={(e) => set("skills", e.target.value)}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className={LABEL} htmlFor="kanban-model">
                {t("kanban.form.modelOverride")}
              </label>
              <input
                id="kanban-model"
                className={FIELD}
                value={values.modelOverride}
                onChange={(e) => set("modelOverride", e.target.value)}
              />
            </div>
            <div>
              <label className={LABEL} htmlFor="kanban-provider">
                {t("kanban.form.providerOverride")}
              </label>
              <input
                id="kanban-provider"
                className={FIELD}
                value={values.providerOverride}
                onChange={(e) => set("providerOverride", e.target.value)}
              />
            </div>
            <div>
              <label className={LABEL} htmlFor="kanban-reasoning">
                {t("kanban.form.reasoningEffort")}
              </label>
              <select
                id="kanban-reasoning"
                className={FIELD}
                value={values.reasoningEffort}
                onChange={(e) => set("reasoningEffort", e.target.value)}
              >
                <option value="">{t("kanban.form.reasoningDefault")}</option>
                {REASONING_EFFORTS.map((effort) => (
                  <option key={effort} value={effort}>
                    {effort}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
            <div>
              <label className={LABEL} htmlFor="kanban-max-runtime">
                {t("kanban.form.maxRuntime")}
              </label>
              <input
                id="kanban-max-runtime"
                type="number"
                min={1}
                className={FIELD}
                value={values.maxRuntimeSeconds}
                onChange={(e) => set("maxRuntimeSeconds", e.target.value)}
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-text pb-2">
              <input
                type="checkbox"
                checked={values.goalMode}
                onChange={(e) => set("goalMode", e.target.checked)}
              />
              {t("kanban.form.goalMode")}
            </label>
            <div>
              <label className={LABEL} htmlFor="kanban-goal-turns">
                {t("kanban.form.goalMaxTurns")}
              </label>
              <input
                id="kanban-goal-turns"
                type="number"
                min={1}
                className={FIELD}
                disabled={!values.goalMode}
                value={values.goalMaxTurns}
                onChange={(e) => set("goalMaxTurns", e.target.value)}
              />
            </div>
          </div>

          {serverError && (
            <div
              role="alert"
              className="rounded-md border border-danger/40 bg-danger-bg px-3 py-2 text-xs text-danger break-words"
            >
              {serverError}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg bg-surface-raised text-text-secondary text-xs hover:brightness-125"
          >
            {t("common.cancel")}
          </button>
          <button
            type="submit"
            disabled={submitting || (mode === "create" && !reviewSupported)}
            className="px-3 py-1.5 rounded-lg bg-primary hover:bg-primary-hover text-white text-xs font-semibold disabled:opacity-60"
          >
            {submitting
              ? t("common.loading")
              : mode === "create"
                ? t("kanban.form.submitCreate")
                : t("kanban.form.submitSave")}
          </button>
        </div>
      </form>
    </div>
  );
}
