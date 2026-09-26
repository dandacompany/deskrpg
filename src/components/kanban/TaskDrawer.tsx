"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { ChevronDown, ChevronRight, Paperclip, Pencil, X } from "lucide-react";

import { useLocale, useT } from "@/lib/i18n";
import {
  KANBAN_TASK_STATUSES,
  type KanbanTask,
  type KanbanTaskAction,
  type KanbanTaskDetail,
  type KanbanTaskStatus,
  type WorkerLog,
  type ArtifactSummary,
  type PluginTime,
} from "@/lib/hermes/deskrpg-plugin-types";
import { taskTimeMs } from "@/lib/plugin-time";
import { cardRunState, runAttempts, type RunAttempt } from "@/lib/kanban-run-history";
import { hasRunProvenance, runProvenance } from "@/lib/kanban-run-provenance";
import type { SessionSourcesView } from "@/lib/session-sources-types";
import type { RunFailureCause } from "@/lib/run-failure-cause";
import GateChecklistModal from "@/components/gateway/GateChecklistModal";
import { classifyGateFailure, isSetupBlocker, type GateBlocker } from "@/lib/gate-failure";

import { KindIcon } from "../artifacts/ArtifactList";
import SessionSourcesList from "../artifacts/SessionSourcesList";
import { ArtifactsApiError } from "../artifacts/artifacts-api";

import { toFailure, type KanbanApi } from "./kanban-api";
import {
  activeAssigneeOptions,
  assigneeLabel,
  failureLine,
  npcIdForAssignee,
  splitBlackboardComments,
  taskTitleById,
  type BoardNpc,
} from "./kanban-view-model";

/** What the card's artifacts section uses. Wired up (by GamePageClient) from the channel artifacts API. */
export type TaskDrawerArtifacts = {
  list(taskId: string): Promise<ArtifactSummary[]>;
  open(artifactId: string): void;
};

interface TaskDrawerProps {
  api: KanbanApi;
  taskId: string;
  npcs: readonly BoardNpc[];
  /** All of the board's cards — for link names and prerequisite-card options. */
  boardTasks: readonly KanbanTask[];
  /** `automation/status.attachments`. If false, the attachments section is hidden (R12). */
  attachmentsSupported: boolean;
  /** The create response's `warning` (no dispatcher) — shown at the top, only for this card (R9). */
  creationWarning: string | null;
  /** When this changes, the detail is refetched (`kanban:event`, board refetch). */
  refreshTick: number;
  /** A mutation succeeded — signal to refetch the board (R26). */
  onChanged: () => void;
  onEdit: (task: KanbanTask) => void;
  onDeleted: () => void;
  onClose: () => void;
  /** The card's artifacts — the section is hidden if null/unspecified. Also hidden when the plugin is below 0.8.4 (428). */
  artifacts?: TaskDrawerArtifacts | null;
  /** Count of channel `artifact:event`s — when it rises, artifacts are refetched after debouncing (`artifactsDebounceMs`). */
  artifactsRefreshTick?: number;
  artifactsDebounceMs?: number;
}

/** Interval that folds a burst of artifact events into a single refetch. */
export const ARTIFACTS_EVENT_DEBOUNCE_MS = 300;

const BTN = "px-2.5 py-1 rounded-md text-[11px] font-semibold disabled:opacity-50";
const BTN_PRIMARY = `${BTN} bg-primary hover:bg-primary-hover text-white`;
const BTN_SOFT = `${BTN} bg-surface-raised hover:brightness-125 text-text-secondary`;
const BTN_DANGER = `${BTN} bg-danger-bg hover:bg-danger-hover text-danger`;
const FIELD = "w-full rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-text";

const LOG_TAIL = 16384;

type Pending = KanbanTaskAction | "status" | "comment" | "link" | "attachment" | "delete" | null;

/**
 * The card detail drawer. Every mutation follows server → success → refetch (R26), and whether an
 * action is allowed is enforced by the server (R10) — this only puts the buttons that fit the
 * status up front, it never hides them.
 */
export default function TaskDrawer({
  api,
  taskId,
  npcs,
  boardTasks,
  attachmentsSupported,
  creationWarning,
  refreshTick,
  onChanged,
  onEdit,
  onDeleted,
  onClose,
  artifacts = null,
  artifactsRefreshTick = 0,
  artifactsDebounceMs = ARTIFACTS_EVENT_DEBOUNCE_MS,
}: TaskDrawerProps) {
  const t = useT();
  const { locale } = useLocale();
  const [detail, setDetail] = useState<KanbanTaskDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [comment, setComment] = useState("");
  const [changesComment, setChangesComment] = useState("");
  const [unblockComment, setUnblockComment] = useState("");
  const [reassignNpcId, setReassignNpcId] = useState("");
  const [linkParentId, setLinkParentId] = useState("");
  const [estimate, setEstimate] = useState<Record<string, unknown> | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [log, setLog] = useState<WorkerLog | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  // Artifacts section — null means loading, "hidden" means 428 (taskId filtering unsupported), so the section is hidden.
  const [cardArtifacts, setCardArtifacts] = useState<ArtifactSummary[] | "hidden" | null>(null);
  const [cardArtifactsError, setCardArtifactsError] = useState(false);
  const [cardArtifactsBlocker, setCardArtifactsBlocker] = useState<GateBlocker | null>(null);
  const [artifactsChecklistOpen, setArtifactsChecklistOpen] = useState(false);
  const [artifactsReload, setArtifactsReload] = useState(0);

  const {
    comments: threadComments,
    blackboard,
    authors,
  } = useMemo(() => splitBlackboardComments(detail?.comments ?? []), [detail?.comments]);
  const blackboardKeys = Object.keys(blackboard).filter((key) => key !== "_authors");

  // Card attachments are also listed in the artifacts list. Attachments come in as inline base64
  // (`kanban_attach`) or a URL rather than a disk file, so they structurally can't be seen by an
  // auto-promotion hook that watches file paths — this screen is the only place where the two
  // stores meet. So this is where the contradiction of the artifacts section saying "none" while
  // attachments exist gets eliminated (observed 2026-09-20).
  // If `attachmentsSupported` is false, `detail.attachments` is not trusted (R12).
  const cardAttachments = useMemo(
    () => (attachmentsSupported ? (detail?.attachments ?? []) : []),
    [attachmentsSupported, detail?.attachments],
  );

  const load = useCallback(async () => {
    try {
      const data = await api.taskDetail(taskId);
      setDetail(data);
      setLoadError(null);
    } catch (err) {
      setLoadError(failureLine(toFailure(err)));
    }
  }, [api, taskId]);

  const loadLog = useCallback(async () => {
    try {
      setLog(await api.log(taskId, LOG_TAIL));
      setLogError(null);
    } catch (err) {
      setLogError(failureLine(toFailure(err)));
    }
  }, [api, taskId]);

  useEffect(() => {
    void load();
  }, [load, refreshTick]);

  useEffect(() => {
    if (!artifacts) return;
    let cancelled = false;
    artifacts.list(taskId).then(
      (items) => {
        if (cancelled) return;
        setCardArtifacts(items);
        setCardArtifactsError(false);
        setCardArtifactsBlocker(null);
      },
      (err: unknown) => {
        if (cancelled) return;
        if (err instanceof ArtifactsApiError && err.status === 428) {
          // If the plugin is too old, the artifacts feature doesn't exist at all — hide the section (existing behavior).
          setCardArtifacts("hidden");
          return;
        }
        setCardArtifactsError(true);
        // The cause isn't discarded — 401/404/503/504 used to be flattened into one line.
        setCardArtifactsBlocker(
          err instanceof ArtifactsApiError
            ? classifyGateFailure({ status: err.status, code: err.code, message: err.message })
            : null,
        );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [artifacts, taskId, refreshTick, artifactsReload]);

  // Artifact events — the value at mount was already fetched, so it's skipped; only rises trigger a debounced refetch.
  const seenArtifactsTick = useRef(artifactsRefreshTick);
  useEffect(() => {
    if (artifactsRefreshTick === seenArtifactsTick.current) return;
    seenArtifactsTick.current = artifactsRefreshTick;
    const timer = setTimeout(() => setArtifactsReload((n) => n + 1), artifactsDebounceMs);
    return () => clearTimeout(timer);
  }, [artifactsRefreshTick, artifactsDebounceMs]);

  useEffect(() => {
    if (showLog) void loadLog();
  }, [showLog, loadLog, refreshTick]);

  useEffect(() => {
    setEstimate(null);
    setShowLog(false);
    setLog(null);
  }, [taskId]);

  useEffect(() => {
    if (detail) setReassignNpcId(npcIdForAssignee(detail.task.assignee, npcs) ?? "");
  }, [detail, npcs]);

  /** Common to all mutations — refetches detail/board on success. Failure messages carry the code/message as-is. */
  const run = async (kind: Exclude<Pending, null>, fn: () => Promise<unknown>) => {
    setPending(kind);
    setActionError(null);
    try {
      const result = await fn();
      await load();
      onChanged();
      return result;
    } catch (err) {
      setActionError(failureLine(toFailure(err)));
      if (kind === "approve") await load();
      return null;
    } finally {
      setPending(null);
    }
  };

  const approvalAttempt = useRef<{ submission: string; request: string } | null>(null);
  const act = (action: KanbanTaskAction, body?: Record<string, unknown>) =>
    run(action, () => api.action(taskId, action, body));

  const task = detail?.task ?? null;
  const status = task?.status;
  const resultText = task?.review?.submission
    ? task.result
    : status === "review"
      ? task?.latest_summary?.trim() || task?.result
      : task?.result?.trim() || (status === "done" ? task?.latest_summary : undefined);
  const assignees = activeAssigneeOptions(npcs);
  const attempts = useMemo(
    () => runAttempts(detail?.runs ?? [], detail?.events ?? []),
    [detail?.runs, detail?.events],
  );
  const runState = task ? cardRunState(task, attempts) : null;
  const linkCandidates = boardTasks.filter(
    (candidate) => candidate.id !== taskId && !(detail?.links.parents ?? []).includes(candidate.id),
  );
  // A value that comes in as epoch seconds, passed straight into `new Date()`, gets read as ms and shows 1970.
  // That's worse than a blank field — it confidently shows the wrong date.
  const formatDate = (value?: PluginTime) => {
    const ms = taskTimeMs(value);
    return ms === null ? "" : new Date(ms).toLocaleString(locale);
  };

  const handleDelete = async () => {
    if (!task) return;
    if (!window.confirm(t("kanban.action.deleteConfirm", { title: task.title }))) return;
    setPending("delete");
    setActionError(null);
    try {
      await api.deleteTask(taskId);
      onChanged();
      onDeleted();
    } catch (err) {
      setActionError(failureLine(toFailure(err)));
    } finally {
      setPending(null);
    }
  };

  const handleStatus = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = event.target.value as KanbanTaskStatus;
    if (!next || next === status) return;
    void run("status", () => api.updateTask(taskId, { status: next }));
  };

  const handleComment = async () => {
    const body = comment.trim();
    if (!body) return;
    const ok = await run("comment", () => api.addComment(taskId, body));
    if (ok) setComment("");
  };

  const handleEstimate = async () => {
    const result = (await act("estimate")) as { task?: unknown } | null;
    if (result) setEstimate(result as Record<string, unknown>);
  };

  const handleUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    await run("attachment", () => api.uploadAttachment(taskId, file));
  };

  return (
    <aside
      aria-label={t("kanban.detail.title")}
      className="flex h-full w-full sm:w-[420px] flex-shrink-0 flex-col border-l border-border bg-bg text-xs"
    >
      <div className="flex items-start justify-between gap-2 px-4 py-3 border-b border-border">
        <div className="min-w-0">
          <div className="font-bold text-sm text-text break-words">
            {task?.title ?? t("common.loading")}
          </div>
          {task && (
            <div className="mt-0.5 text-[11px] text-text-muted">
              {assigneeLabel(task.assignee, npcs) ?? t("kanban.card.unassigned")}
              {task.created_by ? ` · ${t("kanban.detail.createdBy")}: ${task.created_by}` : ""}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {task && !(task.review?.approval && ["done", "archived"].includes(task.status)) && (
            <button
              type="button"
              onClick={() => onEdit(task)}
              aria-label={t("kanban.detail.edit")}
              title={t("kanban.detail.edit")}
              className="text-text-muted hover:text-text p-1"
            >
              <Pencil className="w-4 h-4" />
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="text-text-muted hover:text-text p-1"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {creationWarning && (
          <div className="rounded-md border border-npc/40 bg-npc/10 px-3 py-2 text-npc-dark">
            {creationWarning}
          </div>
        )}
        {loadError && (
          <div role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-danger">
            {loadError}
          </div>
        )}

        {detail && task && (
          <>
            <section className="rounded-md border border-border p-2 text-xs space-y-1">
              <div>
                {t("kanban.review.label")}:{" "}
                {task.review
                  ? t(`kanban.review.${task.review.policy.mode}`)
                  : t("kanban.review.legacy")}
              </div>
              {task.review && (
                <>
                  <div>
                    {t(
                      `kanban.review.state.${task.review.state === "submitted" ? (task.review.policy.mode === "human" ? "humanWaiting" : "agentWaiting") : task.review.state}`,
                    )}
                  </div>
                  {task.review.policy.reviewer_profile && (
                    <div>
                      {t("kanban.review.reviewer")}:{" "}
                      {npcs.find((npc) => npc.profileName === task.review?.policy.reviewer_profile)
                        ?.npcName ?? task.review.policy.reviewer_profile}
                    </div>
                  )}
                  <div>
                    {t("kanban.review.round")}: {task.review.review_round}
                  </div>
                  {task.review.reason && (
                    <div className="text-text-secondary">
                      {t(
                        `kanban.review.reason.${["human_review_required", "new_submission_required", "review_dispatch_disabled", "reviewer_unavailable", "independent_reviewer_required", "reviewer_assignment_mismatch", "review_round_limit", "reviewer_needs_input"].includes(task.review.reason) ? task.review.reason : "unknown"}`,
                      )}
                    </div>
                  )}
                  {task.review.approval && (
                    <div>
                      {t("kanban.review.approvedBy")}:{" "}
                      {task.review.approval.actor_name || task.review.approval.actor_id} ·{" "}
                      {new Date(task.review.approval.approved_at * 1000).toLocaleString()}
                      <br />
                      {t("kanban.review.submission")}: {task.review.approval.submission_id}
                    </div>
                  )}
                </>
              )}
            </section>
            {/* Status + actions (R10·R13) */}
            <section className="space-y-2">
              <div className="flex items-center gap-2">
                <label
                  className="text-[11px] font-semibold text-text-secondary"
                  htmlFor="kanban-status"
                >
                  {t("kanban.detail.status")}
                </label>
                <select
                  id="kanban-status"
                  className="rounded-md border border-border bg-surface px-2 py-1 text-xs"
                  value={status}
                  disabled={pending !== null}
                  onChange={handleStatus}
                >
                  {KANBAN_TASK_STATUSES.map((name) => (
                    <option
                      key={name}
                      value={name}
                      disabled={!!task.review && name === "done" && task.status !== "done"}
                    >
                      {t(`kanban.column.${name}`)}
                    </option>
                  ))}
                </select>
              </div>

              {status === "review" && (
                <div className="space-y-1.5 rounded-md border border-border p-2">
                  <button
                    type="button"
                    className={BTN_PRIMARY}
                    disabled={
                      pending !== null ||
                      (!!task.review &&
                        (!task.review.submission || task.review.state === "reviewing"))
                    }
                    onClick={() => {
                      const submission = task.review?.submission?.id;
                      if (!submission) {
                        void act("approve");
                        return;
                      }
                      if (approvalAttempt.current?.submission !== submission)
                        approvalAttempt.current = { submission, request: crypto.randomUUID() };
                      void act("approve", {
                        submission_id: submission,
                        request_id: approvalAttempt.current.request,
                      });
                    }}
                  >
                    {t("kanban.action.approve")}
                  </button>
                  <textarea
                    className={`${FIELD} min-h-[56px]`}
                    placeholder={t("kanban.action.requestChangesComment")}
                    value={changesComment}
                    onChange={(e) => setChangesComment(e.target.value)}
                  />
                  <button
                    type="button"
                    className={BTN_SOFT}
                    disabled={pending !== null || !changesComment.trim()}
                    onClick={() =>
                      void act("request-changes", { comment: changesComment.trim() }).then((ok) => {
                        if (ok) setChangesComment("");
                      })
                    }
                  >
                    {t("kanban.action.requestChanges")}
                  </button>
                </div>
              )}

              {status === "blocked" && (
                <div className="space-y-1.5 rounded-md border border-border p-2">
                  <textarea
                    className={`${FIELD} min-h-[48px]`}
                    placeholder={t("kanban.action.unblockComment")}
                    value={unblockComment}
                    onChange={(e) => setUnblockComment(e.target.value)}
                  />
                  <button
                    type="button"
                    className={BTN_PRIMARY}
                    disabled={pending !== null}
                    onClick={() =>
                      void act(
                        "unblock",
                        unblockComment.trim() ? { comment: unblockComment.trim() } : {},
                      ).then((ok) => {
                        if (ok) setUnblockComment("");
                      })
                    }
                  >
                    {t("kanban.action.unblock")}
                  </button>
                </div>
              )}

              {status === "running" && (
                <div className="flex flex-col gap-1">
                  <button
                    type="button"
                    className={`${BTN_DANGER} self-start`}
                    disabled={pending !== null}
                    onClick={() => void act("terminate")}
                  >
                    {t("kanban.action.terminate")}
                  </button>
                  {/* Hermes puts a stopped card back in the queue, so it runs again on its own. */}
                  <p data-terminate-hint className="text-[10px] text-text-dim">
                    {t("kanban.action.terminateHint")}
                  </p>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-1.5">
                <select
                  aria-label={t("kanban.action.reassign")}
                  className="rounded-md border border-border bg-surface px-2 py-1 text-xs"
                  value={reassignNpcId}
                  disabled={
                    pending !== null ||
                    !!(
                      task.review &&
                      (task.started_at || task.review.submission || task.review.review_round)
                    )
                  }
                  onChange={(e) => setReassignNpcId(e.target.value)}
                >
                  <option value="">{t("kanban.form.assigneeNone")}</option>
                  {assignees.map((npc) => (
                    <option key={npc.npcId} value={npc.npcId}>
                      {npc.npcName}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className={BTN_SOFT}
                  disabled={
                    pending !== null ||
                    !reassignNpcId ||
                    !!(
                      task.review &&
                      (task.started_at || task.review.submission || task.review.review_round)
                    )
                  }
                  onClick={() => void act("reassign", { npcId: reassignNpcId })}
                >
                  {t("kanban.action.reassign")}
                </button>
                <button
                  type="button"
                  className={BTN_SOFT}
                  disabled={pending !== null}
                  onClick={() => void act("reclaim")}
                >
                  {t("kanban.action.reclaim")}
                </button>
                <button
                  type="button"
                  className={BTN_SOFT}
                  disabled={pending !== null}
                  onClick={() => void act("archive")}
                >
                  {t("kanban.action.archive")}
                </button>
                <button
                  type="button"
                  className={BTN_DANGER}
                  disabled={pending !== null}
                  onClick={() => void handleDelete()}
                >
                  {t("kanban.action.delete")}
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  className={BTN_SOFT}
                  disabled={pending !== null}
                  onClick={() => void act("decompose")}
                >
                  {t("kanban.action.decompose")}
                </button>
                <button
                  type="button"
                  className={BTN_SOFT}
                  disabled={pending !== null}
                  onClick={() => void act("specify")}
                >
                  {t("kanban.action.specify")}
                </button>
                <button
                  type="button"
                  className={BTN_SOFT}
                  disabled={pending !== null}
                  onClick={() => void handleEstimate()}
                >
                  {t("kanban.action.estimate")}
                </button>
              </div>

              {estimate && (
                <div className="rounded-md bg-surface p-2">
                  <div className="font-semibold text-text-secondary mb-1">
                    {t("kanban.action.estimateResult")}
                  </div>
                  <pre className="whitespace-pre-wrap break-words text-[11px] text-text-secondary">
                    {JSON.stringify(estimate, null, 2)}
                  </pre>
                </div>
              )}

              {actionError && (
                <div
                  role="alert"
                  className="rounded-md bg-danger-bg px-3 py-2 text-danger break-words"
                >
                  {actionError}
                </div>
              )}
            </section>

            <Section title={t("kanban.detail.description")}>
              {task.body ? (
                <pre className="whitespace-pre-wrap break-words font-sans text-text-secondary">
                  {task.body}
                </pre>
              ) : (
                <Empty>{t("kanban.detail.noDescription")}</Empty>
              )}
            </Section>

            <Section title={t("kanban.detail.result")}>
              {resultText ? (
                <pre className="whitespace-pre-wrap break-words font-sans text-text-secondary">
                  {resultText}
                </pre>
              ) : (
                <Empty>{t("kanban.detail.noResult")}</Empty>
              )}
              {task.last_failure_error && (
                <div className="mt-2 rounded-md bg-danger-bg px-2 py-1.5 text-danger break-words">
                  {t("kanban.detail.lastFailure")}: {task.last_failure_error}
                </div>
              )}
            </Section>

            {task.diagnostics && task.diagnostics.length > 0 && (
              <Section title={t("kanban.detail.diagnostics")}>
                <ul className="space-y-1.5">
                  {task.diagnostics.map((diag, index) => (
                    <li
                      key={`${diag.kind}-${index}`}
                      className="rounded-md border border-border p-2"
                    >
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`rounded px-1 text-[10px] ${
                            diag.severity === "warning"
                              ? "bg-npc-dark/15 text-npc-dark"
                              : "bg-danger-bg text-danger"
                          }`}
                        >
                          {diag.severity}
                        </span>
                        <span className="font-semibold text-text">{diag.title}</span>
                        {diag.count > 1 && <span className="text-text-dim">×{diag.count}</span>}
                      </div>
                      <div className="mt-1 text-text-secondary break-words">{diag.detail}</div>
                      {diag.actions.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {diag.actions.map((action) => (
                            <span
                              key={action.kind}
                              className="rounded bg-surface-raised px-1.5 py-0.5 text-[10px] text-text-secondary"
                            >
                              {action.label}
                            </span>
                          ))}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            <Section title={t("kanban.detail.links")}>
              <LinkList
                label={t("kanban.detail.parents")}
                ids={detail.links.parents}
                boardTasks={boardTasks}
                disabled={pending !== null}
                onRemove={(parentId) => void run("link", () => api.removeLink(parentId, taskId))}
              />
              <LinkList
                label={t("kanban.detail.children")}
                ids={detail.links.children}
                boardTasks={boardTasks}
                disabled={pending !== null}
                onRemove={(childId) => void run("link", () => api.removeLink(taskId, childId))}
              />
              {task.progress && task.progress.total > 0 && (
                <div className="text-text-dim">
                  {t("kanban.card.progress", {
                    value: `${task.progress.done}/${task.progress.total}`,
                  })}
                </div>
              )}
              <div className="mt-1 flex items-center gap-1.5">
                <select
                  aria-label={t("kanban.detail.addLink")}
                  className="flex-1 rounded-md border border-border bg-surface px-2 py-1 text-xs"
                  value={linkParentId}
                  disabled={pending !== null}
                  onChange={(e) => setLinkParentId(e.target.value)}
                >
                  <option value="">{t("kanban.detail.addLink")}</option>
                  {linkCandidates.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.title}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className={BTN_SOFT}
                  disabled={pending !== null || !linkParentId}
                  onClick={() =>
                    void run("link", () => api.addLink(linkParentId, taskId)).then((ok) => {
                      if (ok) setLinkParentId("");
                    })
                  }
                >
                  {t("common.create")}
                </button>
              </div>
            </Section>

            {blackboardKeys.length > 0 ? (
              <Section title={t("kanban.blackboard")}>
                <dl className="space-y-1">
                  {blackboardKeys.map((key) => (
                    <div key={key} className="rounded-md bg-surface-raised px-2 py-1.5">
                      <dt className="flex items-baseline justify-between text-[10px] text-text-dim">
                        <span className="font-semibold text-text-secondary">{key}</span>
                        {authors[key] ? <span>{authors[key]}</span> : null}
                      </dt>
                      <dd className="mt-0.5 whitespace-pre-wrap break-words font-mono text-[11px] text-text">
                        {typeof blackboard[key] === "string"
                          ? (blackboard[key] as string)
                          : JSON.stringify(blackboard[key], null, 2)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </Section>
            ) : null}

            <Section title={`${t("kanban.detail.comments")} (${threadComments.length})`}>
              {threadComments.length === 0 ? (
                <Empty>{t("kanban.detail.noComments")}</Empty>
              ) : (
                <ul className="space-y-1.5">
                  {threadComments.map((entry) => (
                    <li key={entry.id} className="rounded-md bg-surface p-2">
                      <div className="flex items-center justify-between text-[10px] text-text-dim">
                        <span className="font-semibold text-text-secondary">{entry.author}</span>
                        <span>{formatDate(entry.created_at)}</span>
                      </div>
                      <div className="mt-1 whitespace-pre-wrap break-words text-text">
                        {entry.body}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-2 flex items-end gap-1.5">
                <textarea
                  aria-label={t("kanban.detail.comments")}
                  className={`${FIELD} min-h-[56px]`}
                  placeholder={t("kanban.detail.commentPlaceholder")}
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                />
                <button
                  type="button"
                  className={BTN_PRIMARY}
                  disabled={pending !== null || !comment.trim()}
                  onClick={() => void handleComment()}
                >
                  {t("common.send")}
                </button>
              </div>
            </Section>

            <Section title={t("kanban.detail.runs")}>
              {runState && (
                <div
                  data-run-state={runState.kind}
                  role="status"
                  className={`mb-2 rounded-md px-2 py-1.5 break-words ${
                    runState.kind === "gave_up"
                      ? "bg-danger-bg text-danger"
                      : "bg-surface-raised text-text-secondary"
                  }`}
                >
                  {t(
                    runState.kind === "gave_up"
                      ? "kanban.run.state.gaveUp"
                      : "kanban.run.state.retrying",
                    { count: runState.failures },
                  )}
                </div>
              )}
              {attempts.length === 0 ? (
                <Empty>{t("kanban.detail.noRuns")}</Empty>
              ) : (
                <>
                  <ul className="space-y-1">
                    {[...attempts].reverse().map((attempt) => (
                      <AttemptItem
                        key={attempt.run.id}
                        attempt={attempt}
                        workspace={task?.workspace_path ?? null}
                        loadSources={() => api.runSources(taskId, String(attempt.run.id))}
                        formatDate={formatDate}
                      />
                    ))}
                  </ul>
                  {attempts.length > 1 && (
                    <p className="mt-1 text-[10px] text-text-dim">{t("kanban.run.order")}</p>
                  )}
                </>
              )}
            </Section>

            <section>
              <button
                type="button"
                onClick={() => setShowLog((prev) => !prev)}
                className="flex items-center gap-1 font-bold text-text-secondary mb-1.5"
              >
                {showLog ? (
                  <ChevronDown className="w-3.5 h-3.5" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5" />
                )}
                {t("kanban.detail.log")}
              </button>
              {showLog &&
                (logError ? (
                  <div className="text-danger">{logError}</div>
                ) : !log ? (
                  <Empty>{t("common.loading")}</Empty>
                ) : !log.exists || !log.content ? (
                  <Empty>{t("kanban.detail.logEmpty")}</Empty>
                ) : (
                  <div>
                    {log.truncated && (
                      <div className="text-[10px] text-text-dim mb-1">
                        {t("kanban.detail.logTruncated")}
                      </div>
                    )}
                    <pre className="max-h-[260px] overflow-auto rounded-md bg-bg-deep p-2 text-[10px] leading-snug text-text-secondary whitespace-pre-wrap break-words">
                      {log.content}
                    </pre>
                  </div>
                ))}
            </section>

            {attachmentsSupported && detail.attachments !== null && (
              <Section title={t("kanban.detail.attachments")}>
                {detail.attachments.length === 0 ? (
                  <Empty>{t("kanban.detail.noAttachments")}</Empty>
                ) : (
                  <ul className="space-y-1">
                    {detail.attachments.map((file) => (
                      <li
                        key={file.id}
                        className="flex items-center justify-between gap-2 rounded-md bg-surface px-2 py-1"
                      >
                        <a
                          href={api.attachmentUrl(file.id)}
                          download={file.filename}
                          className="truncate text-text hover:underline"
                        >
                          {file.filename}
                        </a>
                        <span className="text-[10px] text-text-dim">
                          {typeof file.size === "number" ? `${file.size} B` : ""}
                        </span>
                        <button
                          type="button"
                          className="text-[10px] text-danger hover:underline"
                          disabled={pending !== null}
                          onClick={() =>
                            void run("attachment", () => api.deleteAttachment(file.id))
                          }
                        >
                          {t("common.delete")}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <input
                  ref={fileInput}
                  type="file"
                  className="hidden"
                  onChange={(e) => void handleUpload(e)}
                />
                <button
                  type="button"
                  className={`${BTN_SOFT} mt-2`}
                  disabled={pending !== null}
                  onClick={() => fileInput.current?.click()}
                >
                  {t("kanban.detail.upload")}
                </button>
              </Section>
            )}

            {artifacts && cardArtifacts !== "hidden" && (
              <Section title={t("artifacts.card.title")}>
                {cardArtifactsError && cardArtifacts === null ? (
                  <div className="text-danger">
                    {t("artifacts.error")}
                    {cardArtifactsBlocker && isSetupBlocker(cardArtifactsBlocker) && (
                      <button
                        type="button"
                        onClick={() => setArtifactsChecklistOpen(true)}
                        className="ml-2 underline"
                      >
                        {t("gateChecklist.whatIsNeeded")}
                      </button>
                    )}
                  </div>
                ) : cardArtifacts === null ? (
                  <Empty>{t("common.loading")}</Empty>
                ) : cardArtifacts.length === 0 && cardAttachments.length === 0 ? (
                  <Empty>{t("artifacts.card.empty")}</Empty>
                ) : (
                  <ul className="space-y-1">
                    {cardArtifacts.map((artifact) => (
                      <li key={artifact.id}>
                        <button
                          type="button"
                          className="flex w-full items-center gap-2 rounded-md bg-surface px-2 py-1 text-left text-text hover:brightness-125"
                          onClick={() => artifacts.open(artifact.id)}
                        >
                          <KindIcon artifact={artifact} />
                          <span className="truncate">{artifact.title}</span>
                        </button>
                      </li>
                    ))}
                    {cardAttachments.map((file) => (
                      <li key={`attachment-${file.id}`}>
                        <a
                          href={api.attachmentUrl(file.id)}
                          download={file.filename}
                          className="flex w-full items-center gap-2 rounded-md bg-surface px-2 py-1 text-left text-text hover:brightness-125"
                        >
                          <Paperclip size={14} className="shrink-0 text-text-dim" />
                          <span className="truncate">{file.filename}</span>
                          <span className="ml-auto shrink-0 text-[10px] text-text-dim">
                            {t("artifacts.card.fromAttachment")}
                          </span>
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            )}

            <Section title={t("kanban.detail.runSettings")}>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-text-secondary">
                <dt className="text-text-dim">{t("kanban.detail.workspace")}</dt>
                <dd className="break-all">
                  {[task.workspace_kind, task.workspace_path].filter(Boolean).join(" · ") || "—"}
                </dd>
                <dt className="text-text-dim">{t("kanban.detail.model")}</dt>
                <dd>{task.model_override || "—"}</dd>
                <dt className="text-text-dim">{t("kanban.detail.provider")}</dt>
                <dd>{task.provider_override || "—"}</dd>
                <dt className="text-text-dim">{t("kanban.detail.reasoning")}</dt>
                <dd>{task.reasoning_effort || "—"}</dd>
                <dt className="text-text-dim">{t("kanban.detail.branch")}</dt>
                <dd className="break-all">{task.branch_name || "—"}</dd>
              </dl>
            </Section>
          </>
        )}
      </div>
      <GateChecklistModal
        blocker={artifactsChecklistOpen ? cardArtifactsBlocker : null}
        onClose={() => setArtifactsChecklistOpen(false)}
      />
    </aside>
  );
}

/** Chat-path wording for the causes a person can act on (sign in again, wait for the limit, fix the model). */
const CAUSE_MESSAGE_KEY: Record<RunFailureCause, string> = {
  provider_auth: "npc.providerAuthExpired",
  usage_limit: "npc.providerUsageLimit",
  model_error: "npc.providerModelError",
};

/** Our own words for the split `reclaimed` ends; any other end uses the outcome names the metrics use. */
const OWN_END_KEYS = new Set(["running", "stopped", "lost", "moved"]);

function endLabel(t: ReturnType<typeof useT>, end: string): string {
  if (OWN_END_KEYS.has(end)) return t(`kanban.run.end.${end}`);
  const key = `kanban.outcome.${end}`;
  const label = t(key);
  return label === key ? end : label;
}

function AttemptItem({
  attempt,
  workspace,
  loadSources,
  formatDate,
}: {
  attempt: RunAttempt;
  workspace: string | null;
  loadSources: () => Promise<SessionSourcesView>;
  formatDate: (value?: PluginTime) => string;
}) {
  const t = useT();
  const { run, ordinal, end, cause, events } = attempt;
  const made = runProvenance(run.metadata, workspace);
  const hasDetails = Boolean(run.error) || events.length > 0;
  return (
    <li data-attempt={ordinal} data-attempt-end={end} className="rounded-md bg-surface p-2">
      <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-text-dim">
        <span className="font-semibold text-text-secondary">
          {t("kanban.run.attempt", { n: ordinal })}
        </span>
        <span>{endLabel(t, end)}</span>
        {run.profile && <span>{run.profile}</span>}
        <span>{formatDate(run.started_at)}</span>
        {run.ended_at && <span>→ {formatDate(run.ended_at)}</span>}
      </div>
      {cause && (
        <div data-attempt-cause={cause} className="mt-1 text-danger break-words">
          {t(CAUSE_MESSAGE_KEY[cause])}
        </div>
      )}
      {run.summary && <div className="mt-1 text-text-secondary break-words">{run.summary}</div>}
      {hasRunProvenance(made) && <RunProvenanceList made={made} />}
      {made.workerSessionId && (
        <div className="mt-1">
          <SessionSourcesList load={loadSources} />
        </div>
      )}
      {hasDetails && (
        <details className="mt-1">
          <summary className="cursor-pointer text-[10px] text-text-dim">
            {t("kanban.run.details")}
          </summary>
          {/* The raw text stays reachable even when the cause is read wrong. */}
          {run.error && <div className="mt-1 text-danger break-words">{run.error}</div>}
          {events.length > 0 && (
            <ul className="mt-1 flex flex-wrap gap-1 text-[10px] text-text-dim">
              {events.map((event) => (
                <li key={event.id}>
                  {event.kind} {formatDate(event.created_at)}
                </li>
              ))}
            </ul>
          )}
        </details>
      )}
    </li>
  );
}

/** What the worker reported about how it made the result (run `metadata`), in words a person can check. */
function RunProvenanceList({ made }: { made: ReturnType<typeof runProvenance> }) {
  const t = useT();
  const files = (key: string, list: string[], attr: string) =>
    list.length > 0 && (
      <div data-run-provenance={attr}>
        <span className="text-text-dim">{t(key)}</span>{" "}
        <span className="break-all text-text-secondary">{list.join(", ")}</span>
      </div>
    );
  return (
    <div data-run-provenance="" className="mt-1 space-y-0.5 text-[10px]">
      {files("kanban.run.made.changedFiles", made.changedFiles, "changedFiles")}
      {files("kanban.run.made.artifacts", made.artifacts, "artifacts")}
      {made.checks.length > 0 && (
        <div data-run-provenance="checks">
          <span className="text-text-dim">{t("kanban.run.made.checks")}</span>{" "}
          <span className="text-text-secondary break-words">
            {made.checks.map((c) => `${c.key} ${c.value}`).join(" · ")}
          </span>
        </div>
      )}
      {made.limitations.length > 0 && (
        <div data-run-provenance="limitations">
          <span className="text-text-dim">{t("kanban.run.made.limitations")}</span>
          <ul className="list-disc pl-4 text-text-secondary break-words">
            {made.limitations.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
      {made.otherKeys > 0 && (
        <div data-run-provenance="other" className="text-text-dim">
          {t("kanban.run.made.other", { count: made.otherKeys })}
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="font-bold text-text-secondary mb-1.5">{title}</div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-text-dim">{children}</div>;
}

function LinkList({
  label,
  ids,
  boardTasks,
  disabled,
  onRemove,
}: {
  label: string;
  ids: string[];
  boardTasks: readonly KanbanTask[];
  disabled: boolean;
  onRemove: (id: string) => void;
}) {
  const t = useT();
  return (
    <div className="mb-1.5">
      <div className="text-[10px] text-text-dim">
        {label} ({ids.length})
      </div>
      {ids.length > 0 && (
        <ul className="space-y-0.5">
          {ids.map((id) => (
            <li
              key={id}
              className="flex items-center justify-between gap-2 rounded bg-surface px-2 py-1"
            >
              <span className="truncate text-text">{taskTitleById(boardTasks, id)}</span>
              <button
                type="button"
                className="text-[10px] text-danger hover:underline flex-shrink-0"
                disabled={disabled}
                onClick={() => onRemove(id)}
              >
                {t("kanban.detail.removeLink")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
