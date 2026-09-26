"use client";
import { useMemo, useState } from "react";

import { useT } from "@/lib/i18n";

import type { BoardNpc } from "./kanban-view-model";

type WorkerRow = { key: string; npcId: string; title: string };

export type SwarmSubmit = {
  goal: string;
  workers: Array<{ npcId: string; title: string }>;
  verifierNpcId: string;
  synthesizerNpcId: string;
  idempotencyKey: string;
  /** Omitted for human approval — the server's default. */
  reviewPolicy?: { mode: "agent" | "mixed"; reviewerNpcId: string };
};

export type SwarmReviewMode = "human" | "agent" | "mixed";

const FIELD = "w-full rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-text";
const LABEL = "block text-[11px] font-semibold text-text-secondary mb-1";

const newRow = (npcId: string): WorkerRow => ({
  key: crypto.randomUUID(),
  npcId,
  title: "",
});

interface SwarmDialogProps {
  /** Only NPCs who are active (checked in) — the caller filters via `activeAssigneeOptions(npcs)`. */
  npcs: readonly BoardNpc[];
  submitting: boolean;
  /** Server submit failure (filled in by the caller) — `SwarmDialog` covers the board banner with
   * `fixed inset-0`, so the failure message must be shown inside here. */
  error?: string | null;
  onSubmit: (values: SwarmSubmit) => void;
  onClose: () => void;
  /** The gateway can't attach approval policies — the result cards complete without approval. */
  withoutApproval?: boolean;
  /** Approval modes the gateway can enforce on the workers' cards. Empty: no picker. */
  policyModes?: readonly SwarmReviewMode[];
}

/** Swarm-launch dialog. Workers are chosen only from channel NPCs (the server rejects sleeping NPCs with 400). */
export default function SwarmDialog({
  npcs,
  submitting,
  error: submitError,
  onSubmit,
  onClose,
  withoutApproval = false,
  policyModes = [],
}: SwarmDialogProps) {
  const t = useT();
  const first = npcs[0]?.npcId ?? "";
  const [goal, setGoal] = useState("");
  const [rows, setRows] = useState<WorkerRow[]>(() => [newRow(first)]);
  const [verifier, setVerifier] = useState(npcs[1]?.npcId ?? first);
  const [synthesizer, setSynthesizer] = useState(npcs[2]?.npcId ?? first);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [reviewMode, setReviewMode] = useState<SwarmReviewMode>("human");
  const [reviewer, setReviewer] = useState("");
  // The reviewer judges the workers' results, so it can't be one of them (the server refuses it too).
  const reviewerOptions = npcs.filter((npc) => !rows.some((r) => r.npcId === npc.npcId));

  // Creating a new one on every submit would make a retry create a new swarm. Use one for the dialog's lifetime.
  const idempotencyKey = useMemo(() => crypto.randomUUID(), []);

  // A client validation error shows before a server failure — starting a new submit clears both
  // (the caller clears submitError, and validationError is cleared here).
  const error = validationError ?? submitError ?? null;

  const submit = () => {
    if (!goal.trim()) return setValidationError(t("kanban.swarm.error.goal"));
    if (rows.length === 0) return setValidationError(t("kanban.swarm.error.workers"));
    if (rows.some((r) => !r.title.trim()))
      return setValidationError(t("kanban.swarm.error.workerTitle"));
    const aiReview = reviewMode === "agent" || reviewMode === "mixed";
    if (aiReview && !reviewerOptions.some((npc) => npc.npcId === reviewer))
      return setValidationError(t("kanban.review.reviewerRequired"));
    setValidationError(null);
    onSubmit({
      goal: goal.trim(),
      workers: rows.map((r) => ({ npcId: r.npcId, title: r.title.trim() })),
      verifierNpcId: verifier,
      synthesizerNpcId: synthesizer,
      idempotencyKey,
      ...(aiReview && (reviewMode === "agent" || reviewMode === "mixed")
        ? { reviewPolicy: { mode: reviewMode, reviewerNpcId: reviewer } }
        : {}),
    });
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="swarm-dialog-title"
        className="bg-bg border border-border rounded-xl shadow-2xl w-[92vw] max-w-[640px] max-h-[86dvh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h3 id="swarm-dialog-title" className="text-sm font-bold">
            {t("kanban.swarm.title")}
          </h3>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          <p className="text-[11px] text-text-dim">{t("kanban.swarm.hint")}</p>

          <div>
            <label className={LABEL} htmlFor="swarm-goal">
              {t("kanban.swarm.goal")}
            </label>
            <input
              id="swarm-goal"
              className={FIELD}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder={t("kanban.swarm.goalPlaceholder")}
            />
          </div>

          <div>
            <div className={LABEL}>{t("kanban.swarm.workers")}</div>
            <div className="space-y-1.5">
              {rows.map((row, index) => (
                <div key={row.key} className="flex items-center gap-1.5">
                  <select
                    aria-label={t("kanban.swarm.workers")}
                    className={`${FIELD} w-auto`}
                    value={row.npcId}
                    onChange={(e) =>
                      setRows((prev) =>
                        prev.map((r) => (r.key === row.key ? { ...r, npcId: e.target.value } : r)),
                      )
                    }
                  >
                    {npcs.map((npc) => (
                      <option key={npc.npcId} value={npc.npcId}>
                        {npc.npcName}
                      </option>
                    ))}
                  </select>
                  <input
                    aria-label={t("kanban.swarm.workerTitle")}
                    className={`${FIELD} flex-1`}
                    value={row.title}
                    onChange={(e) =>
                      setRows((prev) =>
                        prev.map((r) => (r.key === row.key ? { ...r, title: e.target.value } : r)),
                      )
                    }
                  />
                  <button
                    type="button"
                    aria-label={t("kanban.swarm.removeWorker")}
                    className="px-2 py-1.5 text-text-dim disabled:opacity-40"
                    disabled={rows.length === 1}
                    onClick={() => setRows((prev) => prev.filter((r) => r.key !== row.key))}
                  >
                    ×
                  </button>
                  {index === rows.length - 1 ? (
                    <button
                      type="button"
                      aria-label={t("kanban.swarm.addWorker")}
                      className="px-2 py-1.5 text-text-secondary"
                      onClick={() => setRows((prev) => [...prev, newRow(first)])}
                    >
                      +
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={LABEL} htmlFor="swarm-verifier">
                {t("kanban.swarm.verifier")}
              </label>
              <select
                id="swarm-verifier"
                className={FIELD}
                value={verifier}
                onChange={(e) => setVerifier(e.target.value)}
              >
                {npcs.map((npc) => (
                  <option key={npc.npcId} value={npc.npcId}>
                    {npc.npcName}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={LABEL} htmlFor="swarm-synthesizer">
                {t("kanban.swarm.synthesizer")}
              </label>
              <select
                id="swarm-synthesizer"
                className={FIELD}
                value={synthesizer}
                onChange={(e) => setSynthesizer(e.target.value)}
              >
                {npcs.map((npc) => (
                  <option key={npc.npcId} value={npc.npcId}>
                    {npc.npcName}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {policyModes.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className={LABEL} htmlFor="swarm-review-mode">
                  {t("kanban.review.label")}
                </label>
                <select
                  id="swarm-review-mode"
                  className={FIELD}
                  value={reviewMode}
                  onChange={(e) => setReviewMode(e.target.value as SwarmReviewMode)}
                >
                  {policyModes.map((mode) => (
                    <option key={mode} value={mode}>
                      {t(`kanban.review.${mode}`)}
                    </option>
                  ))}
                </select>
              </div>
              {reviewMode !== "human" && (
                <div>
                  <label className={LABEL} htmlFor="swarm-reviewer">
                    {t("kanban.review.reviewer")}
                  </label>
                  <select
                    id="swarm-reviewer"
                    className={FIELD}
                    value={reviewer}
                    onChange={(e) => setReviewer(e.target.value)}
                  >
                    <option value="">{t("kanban.review.selectReviewer")}</option>
                    {reviewerOptions.map((npc) => (
                      <option key={npc.npcId} value={npc.npcId}>
                        {npc.npcName}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}
          {withoutApproval && (
            <p data-no-approval-notice role="status" className="text-xs text-npc-dark">
              {t("kanban.review.noApproval")}
            </p>
          )}
          {error && (
            <div
              role="alert"
              className="rounded-md border border-danger/40 bg-danger-bg px-3 py-2 text-xs text-danger break-words"
            >
              {error}
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
            type="button"
            disabled={submitting || npcs.length === 0}
            className="px-3 py-1.5 rounded-lg bg-primary hover:bg-primary-hover text-white text-xs font-semibold disabled:opacity-60"
            onClick={submit}
          >
            {t("kanban.swarm.submit")}
          </button>
        </div>
      </div>
    </div>
  );
}
