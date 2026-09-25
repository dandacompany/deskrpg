"use client";
/**
 * The channel cron screen (R15-R19, R26, R31/R32).
 *
 * - Channel mode: the union of cron jobs across the channel's active NPC profiles + NPC filter/search.
 * - Single-NPC mode (`npc` given, the cron tab in an NPC's chat window): only that NPC's jobs, no filter.
 *
 * There's no optimistic update — refetches after a successful action, and refetches when the
 * channel socket's `cron:event` arrives (R26). "Run now" only toasts on a 202 response (R19).
 * The browser never calls Hermes directly — everything goes through `cron-api.ts`'s
 * `/api/channels/...`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LayoutTemplate, Pause, Pencil, Play, Plus, RefreshCw, Trash2, X, Zap } from "lucide-react";
import type { Socket } from "socket.io-client";

import { useLocale, useT } from "@/lib/i18n";
import type { CronRun } from "@/lib/hermes/deskrpg-plugin-types";
import GateChecklistModal from "@/components/gateway/GateChecklistModal";
import { classifyGateFailure, isSetupBlocker, type GateBlocker } from "@/lib/gate-failure";

import { cronApi, classifyCronError, isCronApiError, type CronJobView } from "./cron-api";
import {
  describeSchedule,
  formatLocalDateTime,
  jobScheduleDisplay,
  jobScheduleExpr,
  parseIsoMs,
  readOnlyReason,
  relativeTime,
  stateDotClass,
} from "./cron-schedule";
import { CronErrorNotice, TimezoneLabel } from "./cron-notices";
import CronEditorDialog, { type CronEditorSubmit } from "./CronEditorDialog";
import BlueprintGallery from "./BlueprintGallery";
import CronRunItem from "./CronRunItem";
import { isRunDue, runStatusKey } from "./cron-run-view";

export type CronPanelNpc = { npcId: string; npcName: string; profileName?: string };

/** Only what's needed from the channel socket — `on`/`off`. socket.io's `Socket` fits this as-is. */
export type CronEventSource = {
  on(event: string, handler: (payload: unknown) => void): unknown;
  off(event: string, handler: (payload: unknown) => void): unknown;
};
// Pins at compile time that `Socket` fits the shape above — the wiring passes the socket through as-is.
type AssertSocketFits = Socket extends CronEventSource ? true : never;
const _socketFits: AssertSocketFits = true;
void _socketFits;

export const CRON_SOCKET_EVENT = "cron:event";

export interface CronPanelProps {
  channelId: string;
  /** The channel's active NPCs — candidates for the filter/assigned NPC. In single mode, just `npc` is enough. */
  npcs: CronPanelNpc[];
  /** Single-NPC mode: shows only this NPC's cron jobs, with no NPC filter. */
  npc?: CronPanelNpc | null;
  /** The channel socket. Refetches on `cron:event`. Without it, only manual refresh works. */
  socket?: CronEventSource | null;
  /** Toast — if absent, briefly shown inside the panel instead. */
  onToast?: (message: string) => void;
  /** If present, a close button appears in the header (used when shown as a modal). */
  onClose?: () => void;
  className?: string;
  /** Opens with this job selected on the run-history tab — the room notice's "open history" (R30). Only read on mount. */
  initialJobId?: string | null;
}

type DetailTab = "detail" | "runs";

const TOAST_MS = 4000;

export default function CronPanel({
  channelId,
  npcs,
  npc = null,
  socket = null,
  onToast,
  onClose,
  className = "",
  initialJobId = null,
}: CronPanelProps) {
  const t = useT();
  const { locale } = useLocale();
  const single = !!npc;
  const npcCandidates = useMemo(() => (npc ? [npc] : npcs), [npc, npcs]);

  const [jobs, setJobs] = useState<CronJobView[] | null>(null);
  const [timezone, setTimezone] = useState<string | null>(null);
  const [partialErrors, setPartialErrors] = useState<
    Array<{ npcId: string; code: string; message: string }>
  >([]);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);

  const [filterNpcId, setFilterNpcId] = useState<string>("");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(initialJobId);
  const [detailTab, setDetailTab] = useState<DetailTab>(initialJobId ? "runs" : "detail");
  const [runs, setRuns] = useState<CronRun[] | null>(null);
  const [runsError, setRunsError] = useState<unknown>(null);
  const [editor, setEditor] = useState<{ job: CronJobView | null } | null>(null);
  const [gallery, setGallery] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [inlineToast, setInlineToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [checklistBlocker, setChecklistBlocker] = useState<GateBlocker | null>(null);

  // The panel always says it itself: the page toast renders under the cron modal (z-50), so a
  // "run now" there looked like nothing happened. The page still gets it for its notice list.
  const toast = useCallback(
    (message: string) => {
      onToast?.(message);
      setInlineToast(message);
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setInlineToast(null), TOAST_MS);
    },
    [onToast],
  );
  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  // ---- Fetch (R26: refetch after an action or an event) ---------------------------------
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await cronApi.listJobs(channelId, npc?.npcId ?? null);
      setJobs(res.jobs);
      setTimezone(res.timezone ?? null);
      setPartialErrors(res.errors ?? []);
      setLoadError(null);
    } catch (err) {
      setLoadError(err);
      setJobs((current) => current ?? []);
    } finally {
      setLoading(false);
    }
  }, [channelId, npc?.npcId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!socket) return;
    const handler = (payload: unknown) => {
      const p = payload as { channelId?: string } | null;
      if (p && typeof p.channelId === "string" && p.channelId !== channelId) return;
      void reload();
    };
    socket.on(CRON_SOCKET_EVENT, handler);
    return () => {
      socket.off(CRON_SOCKET_EVENT, handler);
    };
  }, [socket, channelId, reload]);

  // ---- 1-second tick — countdown to the next run (R18) -------------------------------
  const hasCountdown = useMemo(
    () => (jobs ?? []).some((job) => parseIsoMs(job.next_run_at) !== null),
    [jobs],
  );
  useEffect(() => {
    if (!hasCountdown) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasCountdown]);

  // ---- Filter/search (R15) --------------------------------------------------------
  const visibleJobs = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (jobs ?? []).filter((job) => {
      if (!single && filterNpcId && job.npcId !== filterNpcId) return false;
      if (!needle) return true;
      return (
        job.name.toLowerCase().includes(needle) ||
        job.prompt.toLowerCase().includes(needle) ||
        job.npcName.toLowerCase().includes(needle)
      );
    });
  }, [jobs, single, filterNpcId, search]);

  const selected = useMemo(
    () => (jobs ?? []).find((job) => job.id === selectedId) ?? null,
    [jobs, selectedId],
  );
  // Opened from a chat notice ("open history") for a cron that no longer exists. Only said when
  // every NPC's list loaded — a failed list may just be hiding the job.
  const initialJobDeleted =
    initialJobId !== null &&
    jobs !== null &&
    loadError === null &&
    partialErrors.length === 0 &&
    !jobs.some((job) => job.id === initialJobId);

  // ---- Run-history tab --------------------------------------------------------
  useEffect(() => {
    if (!selected || detailTab !== "runs") return;
    let cancelled = false;
    setRuns(null);
    setRunsError(null);
    cronApi
      .listRuns(channelId, selected.id, selected.npcId)
      .then((res) => {
        if (!cancelled) setRuns(res.runs);
      })
      .catch((err) => {
        if (!cancelled) {
          setRuns([]);
          setRunsError(err);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [channelId, selected, detailTab]);

  // ---- Actions (R16: only when editable) -----------------------------------------
  const runAction = useCallback(
    async (job: CronJobView, action: "pause" | "resume" | "run" | "delete") => {
      if (!job.editable || busy) return;
      setBusy(job.id);
      setActionError(null);
      try {
        switch (action) {
          case "pause":
            await cronApi.pauseJob(channelId, job.id, job.npcId);
            toast(t("cron.toast.paused", { name: job.name }));
            await reload();
            break;
          case "resume":
            await cronApi.resumeJob(channelId, job.id, job.npcId);
            toast(t("cron.toast.resumed", { name: job.name }));
            await reload();
            break;
          case "run":
            // R19: just gets the 202 and stops. The result is observed via cron:event -> refetch.
            await cronApi.runJob(channelId, job.id, job.npcId);
            toast(t("cron.toast.runQueued", { name: job.name, room: t("room.office") }));
            break;
          case "delete":
            await cronApi.deleteJob(channelId, job.id, job.npcId);
            toast(t("cron.toast.deleted", { name: job.name }));
            setSelectedId(null);
            await reload();
            break;
        }
      } catch (err) {
        setActionError(err);
      } finally {
        setBusy(null);
        setConfirmDeleteId(null);
      }
    },
    [busy, channelId, reload, t, toast],
  );

  const submitEditor = useCallback(
    async (input: CronEditorSubmit) => {
      const editing = editor?.job ?? null;
      if (editing) {
        await cronApi.updateJob(channelId, editing.id, editing.npcId, {
          name: input.name,
          prompt: input.prompt,
          schedule: input.schedule,
          deliver: input.deliver,
          model: input.model,
          provider: input.provider,
        });
        toast(t("cron.toast.updated", { name: input.name }));
      } else {
        await cronApi.createJob(channelId, {
          npcId: input.npcId,
          name: input.name,
          prompt: input.prompt,
          schedule: input.schedule,
          deliver: input.deliver,
          ...(input.model ? { model: input.model } : {}),
          ...(input.provider ? { provider: input.provider } : {}),
        });
        toast(t("cron.toast.created", { name: input.name }));
      }
      setEditor(null);
      await reload();
    },
    [channelId, editor, reload, t, toast],
  );

  const readOnlyText = (job: CronJobView): string | null => {
    const reason = readOnlyReason(job);
    return reason ? t(`cron.readOnly.${reason}`) : null;
  };

  // The banner itself is rendered by `CronErrorNotice` — this only attaches a button next to it
  // that opens the checklist. It only shows when `isSetupBlocker` is true (the net of
  // gateway_not_bound/plugin_absent/plugin_unauthorized/plugin_upgrade_required) — saying
  // "more setup needed" for a plain 500/network error would be a false signal. Same standard
  // as the delivery-target preload in `CronEditorDialog`/`BlueprintGallery`.
  const gateChecklistTrigger = (err: unknown) => {
    if (!isCronApiError(err)) return null;
    const minVersion =
      typeof err.details.minVersion === "string" ? err.details.minVersion : undefined;
    const blocker = classifyGateFailure({
      status: err.status,
      code: err.code,
      message: err.message,
      minVersion,
    });
    if (!isSetupBlocker(blocker)) return null;
    return (
      <button
        type="button"
        onClick={() => setChecklistBlocker(blocker)}
        className="ml-2 underline text-xs text-text-muted"
      >
        {t("gateChecklist.whatIsNeeded")}
      </button>
    );
  };

  const btnShape =
    "inline-flex items-center gap-1 px-2 py-1 text-xs rounded disabled:opacity-40 disabled:cursor-not-allowed";
  const iconBtn = `${btnShape} bg-surface hover:bg-surface-raised text-text`;
  // A separate class, not iconBtn plus overrides: two bg-* on one element resolve by CSS
  // order, and bg-surface won — the button went white on white.
  const primaryBtn = `${btnShape} bg-primary hover:bg-primary-hover text-white`;

  return (
    <div
      data-testid="cron-panel"
      className={`flex flex-col min-h-0 h-full bg-bg text-text ${className}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border bg-surface/80">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="text-sm font-bold">{t("cron.title")}</span>
          <TimezoneLabel timezone={timezone} />
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={iconBtn}
            onClick={() => void reload()}
            disabled={loading}
            title={t("cron.refresh")}
            aria-label={t("cron.refresh")}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
          <button
            type="button"
            className={iconBtn}
            onClick={() => setGallery(true)}
            disabled={npcCandidates.length === 0}
          >
            <LayoutTemplate className="w-3.5 h-3.5" />
            {t("cron.gallery")}
          </button>
          <button
            type="button"
            data-testid="cron-new"
            className={primaryBtn}
            onClick={() => setEditor({ job: null })}
            disabled={npcCandidates.length === 0}
          >
            <Plus className="w-3.5 h-3.5" />
            {t("cron.new")}
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label={t("common.close")}
              className="ml-1 text-text-muted hover:text-text"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Filter/search */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        {!single && (
          <select
            data-testid="cron-filter-npc"
            className="px-2 py-1 bg-surface border border-border rounded text-xs text-text"
            value={filterNpcId}
            onChange={(e) => setFilterNpcId(e.target.value)}
          >
            <option value="">{t("cron.filter.allNpcs")}</option>
            {npcs.map((candidate) => (
              <option key={candidate.npcId} value={candidate.npcId}>
                {candidate.npcName}
              </option>
            ))}
          </select>
        )}
        <input
          data-testid="cron-search"
          className="flex-1 min-w-0 px-2 py-1 bg-surface border border-border rounded text-xs text-text"
          placeholder={t("cron.search.placeholder")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {inlineToast && (
        <div
          role="status"
          data-testid="cron-toast"
          className="mx-3 mt-2 px-3 py-1.5 rounded bg-surface-raised text-xs text-text"
        >
          {inlineToast}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-2">
        {loadError !== null && (
          <div>
            <CronErrorNotice notice={classifyCronError(loadError)} />
            {gateChecklistTrigger(loadError)}
          </div>
        )}
        {partialErrors.length > 0 && (
          <div
            data-testid="cron-partial-errors"
            className="p-2 rounded border border-npc/50 bg-npc-dark/10 text-[11px] text-text-muted"
          >
            <p>{t("cron.error.partial", { count: partialErrors.length })}</p>
            <ul className="mt-1 font-mono">
              {partialErrors.map((err) => (
                <li key={err.npcId}>
                  {npcCandidates.find((c) => c.npcId === err.npcId)?.npcName ?? err.npcId} —{" "}
                  {err.code}: {err.message}
                </li>
              ))}
            </ul>
          </div>
        )}

        {initialJobDeleted && (
          <p
            role="status"
            data-testid="cron-deleted-notice"
            className="p-2 rounded border border-border bg-surface-raised text-xs text-text-muted"
          >
            {t("cron.deletedJob")}
          </p>
        )}

        {/* List */}
        {jobs === null ? (
          <p className="text-sm text-text-dim py-4 text-center">{t("common.loading")}</p>
        ) : visibleJobs.length === 0 ? (
          loadError === null && (
            <p className="text-sm text-text-dim py-4 text-center">{t("cron.empty")}</p>
          )
        ) : (
          <ul role="list" className="space-y-1">
            {visibleJobs.map((job) => {
              const next = parseIsoMs(job.next_run_at);
              const active = job.id === selectedId;
              return (
                <li key={`${job.npcId}:${job.id}`} role="listitem" data-testid="cron-row">
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedId(active ? null : job.id);
                      setDetailTab("detail");
                      setActionError(null);
                      setConfirmDeleteId(null);
                    }}
                    aria-pressed={active}
                    className={`w-full text-left px-3 py-2 rounded-lg border ${
                      active
                        ? "bg-surface-raised border-primary/60"
                        : "bg-surface border-border hover:bg-surface-raised"
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        data-testid="cron-state-dot"
                        data-state={job.state}
                        title={t(`cron.state.${job.state}`)}
                        className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${stateDotClass(job.state)}`}
                      />
                      <span className="text-sm font-medium truncate flex-1">{job.name}</span>
                      {!single && (
                        <span className="text-[11px] text-npc flex-shrink-0">{job.npcName}</span>
                      )}
                    </div>
                    <div className="flex items-center justify-between gap-2 mt-0.5 text-[11px] text-text-muted">
                      <span className="truncate" title={jobScheduleDisplay(job)}>
                        {describeSchedule(jobScheduleExpr(job), locale, t) ??
                          jobScheduleDisplay(job)}
                      </span>
                      <span data-testid="cron-countdown" className="flex-shrink-0">
                        {job.state === "paused" ||
                        job.state === "disabled" ||
                        job.state === "completed"
                          ? t(`cron.state.${job.state}`)
                          : isRunDue(next, nowMs)
                            ? t("cron.nextRun.due")
                            : next !== null
                              ? relativeTime(next, nowMs, locale)
                              : t("cron.noNextRun")}
                      </span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Detail drawer */}
      {selected && (
        <div
          data-testid="cron-detail"
          className="border-t border-border bg-surface/60 max-h-[45%] flex flex-col min-h-0"
        >
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-border">
            <div className="flex gap-1">
              {(["detail", "runs"] as DetailTab[]).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  data-testid={`cron-tab-${tab}`}
                  onClick={() => setDetailTab(tab)}
                  className={`px-2 py-0.5 text-xs rounded ${
                    detailTab === tab ? "bg-surface-raised text-text" : "text-text-muted"
                  }`}
                >
                  {tab === "detail" ? t("cron.detail.title") : t("cron.runs.title")}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                data-testid="cron-action-edit"
                className={iconBtn}
                disabled={!selected.editable || busy === selected.id}
                title={readOnlyText(selected) ?? t("common.edit")}
                onClick={() => setEditor({ job: selected })}
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
              {selected.state === "paused" ? (
                <button
                  type="button"
                  data-testid="cron-action-resume"
                  className={iconBtn}
                  disabled={!selected.editable || busy === selected.id}
                  title={readOnlyText(selected) ?? t("cron.action.resume")}
                  onClick={() => void runAction(selected, "resume")}
                >
                  <Play className="w-3.5 h-3.5" />
                </button>
              ) : (
                <button
                  type="button"
                  data-testid="cron-action-pause"
                  className={iconBtn}
                  disabled={!selected.editable || busy === selected.id}
                  title={readOnlyText(selected) ?? t("cron.action.pause")}
                  onClick={() => void runAction(selected, "pause")}
                >
                  <Pause className="w-3.5 h-3.5" />
                </button>
              )}
              <button
                type="button"
                data-testid="cron-action-run"
                className={iconBtn}
                disabled={!selected.editable || busy === selected.id}
                title={readOnlyText(selected) ?? t("cron.action.run")}
                onClick={() => void runAction(selected, "run")}
              >
                <Zap className="w-3.5 h-3.5" />
                {t("cron.action.run")}
              </button>
              <button
                type="button"
                data-testid="cron-action-delete"
                className={`${btnShape} ${confirmDeleteId === selected.id ? "bg-danger/70 hover:bg-danger-hover text-white" : "bg-surface hover:bg-surface-raised text-danger"}`}
                disabled={!selected.editable || busy === selected.id}
                title={readOnlyText(selected) ?? t("common.delete")}
                onClick={() => {
                  if (confirmDeleteId === selected.id) void runAction(selected, "delete");
                  else setConfirmDeleteId(selected.id);
                }}
              >
                <Trash2 className="w-3.5 h-3.5" />
                {confirmDeleteId === selected.id ? t("cron.action.confirmDelete") : null}
              </button>
              <button
                type="button"
                onClick={() => setSelectedId(null)}
                aria-label={t("common.close")}
                className="ml-1 text-text-muted hover:text-text"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 text-xs space-y-2">
            {readOnlyText(selected) && (
              <p data-testid="cron-readonly-reason" className="text-text-muted italic">
                {readOnlyText(selected)}
              </p>
            )}
            {actionError !== null && (
              <div>
                <CronErrorNotice notice={classifyCronError(actionError)} />
                {gateChecklistTrigger(actionError)}
              </div>
            )}

            {detailTab === "detail" ? (
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                <dt className="text-text-muted">{t("cron.field.npc")}</dt>
                <dd className="text-npc">{selected.npcName}</dd>
                <dt className="text-text-muted">{t("cron.field.schedule")}</dt>
                <dd>
                  {describeSchedule(jobScheduleExpr(selected), locale, t) ??
                    jobScheduleDisplay(selected)}{" "}
                  {describeSchedule(jobScheduleExpr(selected), locale, t) && (
                    <code className="text-text-dim">{jobScheduleDisplay(selected)}</code>
                  )}{" "}
                  <span className="text-text-dim">
                    <TimezoneLabel timezone={timezone} />
                  </span>
                </dd>
                <dt className="text-text-muted">{t("cron.nextRun")}</dt>
                <dd data-testid="cron-next-run">
                  {isRunDue(parseIsoMs(selected.next_run_at), nowMs) ? (
                    t("cron.nextRun.due")
                  ) : (
                    <>
                      {formatLocalDateTime(selected.next_run_at, locale)}
                      {parseIsoMs(selected.next_run_at) !== null && (
                        <span className="ml-1 text-text-dim">
                          ({relativeTime(parseIsoMs(selected.next_run_at)!, nowMs, locale)})
                        </span>
                      )}
                    </>
                  )}
                </dd>
                <dt className="text-text-muted">{t("cron.lastRun")}</dt>
                <dd>
                  {formatLocalDateTime(selected.last_run_at, locale)}
                  {selected.last_status && (
                    <span className="ml-1 text-text-dim" data-testid="cron-last-status">
                      ({t(runStatusKey(selected.last_status))})
                    </span>
                  )}
                </dd>
                {selected.last_error && (
                  <>
                    <dt className="text-text-muted">{t("cron.lastError")}</dt>
                    <dd className="text-danger break-all">{selected.last_error}</dd>
                  </>
                )}
                <dt className="text-text-muted">{t("cron.field.deliver")}</dt>
                <dd className="font-mono">{selected.deliver ?? "local"}</dd>
                <dt className="text-text-muted">{t("cron.field.model")}</dt>
                <dd className="font-mono">
                  {selected.model
                    ? `${selected.provider ? `${selected.provider}:` : ""}${selected.model}`
                    : t("cron.modelDefault")}
                </dd>
                <dt className="text-text-muted">{t("cron.field.prompt")}</dt>
                <dd className="whitespace-pre-wrap break-words">{selected.prompt}</dd>
              </dl>
            ) : runs === null && runsError === null ? (
              <p className="text-text-dim">{t("common.loading")}</p>
            ) : runsError !== null ? (
              <div>
                <CronErrorNotice notice={classifyCronError(runsError)} />
                {gateChecklistTrigger(runsError)}
              </div>
            ) : runs && runs.length === 0 ? (
              <p className="text-text-dim">{t("cron.runs.empty")}</p>
            ) : (
              <ul role="list" className="space-y-1">
                {(runs ?? []).map((run) => (
                  <CronRunItem key={run.id} run={run} />
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {editor && (
        <CronEditorDialog
          channelId={channelId}
          npcs={npcCandidates}
          defaultNpcId={npc?.npcId ?? (filterNpcId || null)}
          job={editor.job}
          timezone={timezone}
          onSubmit={submitEditor}
          onClose={() => setEditor(null)}
        />
      )}
      {gallery && (
        <BlueprintGallery
          channelId={channelId}
          npcs={npcCandidates}
          defaultNpcId={npc?.npcId ?? (filterNpcId || null)}
          onCreated={(job) => {
            setGallery(false);
            toast(t("cron.toast.created", { name: job.name }));
            void reload();
          }}
          onClose={() => setGallery(false)}
        />
      )}
      <GateChecklistModal blocker={checklistBlocker} onClose={() => setChecklistBlocker(null)} />
    </div>
  );
}
