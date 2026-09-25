"use client";
/**
 * Cron create/edit form (R17/R18).
 *
 * Fields: assigned NPC (choosable only when creating) · name · prompt · schedule preset
 * (+ custom input) · delivery targets (checkboxes -> comma string) · model (`provider:model`).
 * Saving is done by the parent — this component only builds the body and passes it to
 * `onSubmit`; there's no optimistic update (R26).
 */
import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";

import { useT } from "@/lib/i18n";
import type { CronDeliveryTarget } from "@/lib/hermes/deskrpg-plugin-types";
import GateChecklistModal from "@/components/gateway/GateChecklistModal";
import { classifyGateFailure, isSetupBlocker, type GateBlocker } from "@/lib/gate-failure";

import { cronApi, classifyCronError, isCronApiError, type CronJobView } from "./cron-api";
import {
  SCHEDULE_PRESETS,
  composeDeliver,
  exprForPreset,
  formatModelSpec,
  jobScheduleExpr,
  parseDeliver,
  parseModelSpec,
  scheduleOptionForExpr,
  type SchedulePresetValue,
} from "./cron-schedule";
import { deliverRows } from "./deliver-targets";
import { CronErrorNotice, TimezoneLabel } from "./cron-notices";

/** `profileName` lets the delivery list offer only this channel's employees' bot chats. */
export type CronEditorNpc = { npcId: string; npcName: string; profileName?: string };

/** The save body — `npcId` is only carried on create (editing can't change the assigned NPC). */
export type CronEditorSubmit = {
  npcId: string;
  name: string;
  prompt: string;
  schedule: string;
  deliver: string;
  model: string | null;
  provider: string | null;
};

interface CronEditorDialogProps {
  channelId: string;
  /** Candidate NPCs. In edit mode this is fixed to `job.npcId`. */
  npcs: CronEditorNpc[];
  /** The NPC pre-selected on creation (single-NPC mode). */
  defaultNpcId?: string | null;
  job?: CronJobView | null;
  timezone: string | null;
  onSubmit: (input: CronEditorSubmit) => Promise<void>;
  onClose: () => void;
}

export default function CronEditorDialog({
  channelId,
  npcs,
  defaultNpcId = null,
  job = null,
  timezone,
  onSubmit,
  onClose,
}: CronEditorDialogProps) {
  const t = useT();
  const editing = !!job;

  const initialExpr = job ? jobScheduleExpr(job) : "";
  const initialPreset = job ? scheduleOptionForExpr(initialExpr).value : "daily";

  const [npcId, setNpcId] = useState<string>(job?.npcId ?? defaultNpcId ?? npcs[0]?.npcId ?? "");
  const [name, setName] = useState(job?.name ?? "");
  const [prompt, setPrompt] = useState(job?.prompt ?? "");
  const [preset, setPreset] = useState<SchedulePresetValue>(initialPreset);
  const [customExpr, setCustomExpr] = useState(initialPreset === "custom" ? initialExpr : "");
  const [deliverIds, setDeliverIds] = useState<string[]>(() => parseDeliver(job?.deliver));
  const [modelSpec, setModelSpec] = useState(
    job ? formatModelSpec(job.provider ?? null, job.model ?? null) : "",
  );
  const [targets, setTargets] = useState<CronDeliveryTarget[]>([]);
  const [targetsBlocker, setTargetsBlocker] = useState<GateBlocker | null>(null);
  const [checklistOpen, setChecklistOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // The delivery-target list belongs to the assigned NPC's profile — refetch when the NPC changes.
  useEffect(() => {
    if (!npcId) return;
    let cancelled = false;
    setTargetsBlocker(null);
    cronApi
      .listDeliveryTargets(channelId, npcId)
      .then((res) => {
        if (!cancelled) {
          setTargets(res.targets);
          setTargetsBlocker(null);
        }
      })
      .catch((err: unknown) => {
        // Even if the list fails to load, local can always be chosen — this doesn't block the form.
        if (cancelled) return;
        setTargets([]);
        // But "no delivery targets" and "blocked by the gate" are different things. This used
        // to be swallowed without distinction. Saying "more setup needed" even for a plain
        // 500/network error would be a false signal — only the net filtered by `isSetupBlocker`
        // (gateway_not_bound/plugin_absent/plugin_unauthorized/plugin_upgrade_required) shows
        // the checklist.
        if (isCronApiError(err)) {
          const blocker = classifyGateFailure({
            status: err.status,
            code: err.code,
            message: err.message,
            minVersion:
              typeof err.details.minVersion === "string" ? err.details.minVersion : undefined,
          });
          if (isSetupBlocker(blocker)) setTargetsBlocker(blocker);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [channelId, npcId]);

  // Keep ids not in the server list (a stored value, local) as checkboxes too — they must not disappear mid-edit.
  // Bot chats are narrowed to this channel's employees (see deliver-targets.ts).
  const targetRows = useMemo(() => {
    const profiles = npcs.flatMap((npc) =>
      npc.profileName ? [{ profileName: npc.profileName, npcName: npc.npcName }] : [],
    );
    return deliverRows(targets, deliverIds, profiles.length > 0 ? profiles : undefined);
  }, [targets, deliverIds, npcs]);

  const schedule = preset === "custom" ? customExpr.trim() : (exprForPreset(preset) ?? "");
  const canSubmit = !!npcId && prompt.trim().length > 0 && schedule.length > 0 && !saving;

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    const { provider, model } = parseModelSpec(modelSpec);
    try {
      await onSubmit({
        npcId,
        name: name.trim() || prompt.trim().slice(0, 40),
        prompt: prompt.trim(),
        schedule,
        deliver: composeDeliver(deliverIds),
        model,
        provider,
      });
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  const toggleDeliver = (id: string) => {
    setDeliverIds((current) =>
      current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
    );
  };

  const titleId = "cron-editor-title";
  const inputClass =
    "w-full px-3 py-2 bg-surface border border-border rounded text-sm text-text focus:outline-none focus:border-primary";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-bg border border-border rounded-xl shadow-2xl w-[90vw] max-w-[560px] max-h-[85dvh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h2 id={titleId} className="text-sm font-bold">
            {editing ? t("cron.editor.editTitle") : t("cron.editor.createTitle")}
          </h2>
          <button onClick={onClose} aria-label={t("common.close")} className="text-text-muted">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form
          className="flex-1 overflow-y-auto px-5 py-4 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="block text-xs text-text-muted">
            {t("cron.field.npc")}
            <select
              data-testid="cron-npc"
              className={`${inputClass} mt-1`}
              value={npcId}
              disabled={editing}
              onChange={(e) => setNpcId(e.target.value)}
              required
            >
              {!npcId && <option value="">—</option>}
              {(editing && job ? [{ npcId: job.npcId, npcName: job.npcName }] : npcs).map((npc) => (
                <option key={npc.npcId} value={npc.npcId}>
                  {npc.npcName}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-xs text-text-muted">
            {t("cron.field.name")}
            <input
              data-testid="cron-name"
              className={`${inputClass} mt-1`}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          <label className="block text-xs text-text-muted">
            {t("cron.field.prompt")}
            <textarea
              data-testid="cron-prompt"
              className={`${inputClass} mt-1 min-h-[96px]`}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              required
            />
          </label>

          <div className="text-xs text-text-muted">
            <div className="flex items-center justify-between">
              <span>{t("cron.field.schedule")}</span>
              <TimezoneLabel timezone={timezone} />
            </div>
            <select
              data-testid="cron-preset"
              className={`${inputClass} mt-1`}
              value={preset}
              onChange={(e) => setPreset(e.target.value as SchedulePresetValue)}
            >
              {SCHEDULE_PRESETS.map((option) => (
                <option key={option.value} value={option.value}>
                  {t(`cron.preset.${option.value}`)}
                </option>
              ))}
            </select>
            {preset === "custom" && (
              <input
                data-testid="cron-custom-expr"
                className={`${inputClass} mt-2 font-mono`}
                value={customExpr}
                placeholder={t("cron.field.customExpr")}
                onChange={(e) => setCustomExpr(e.target.value)}
              />
            )}
          </div>

          <fieldset className="text-xs text-text-muted">
            <legend>{t("cron.field.deliver")}</legend>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
              {targetRows.map(({ id, kind, target, profileName, npcName }) => (
                <label key={id} className="inline-flex items-center gap-1.5 text-text">
                  <input
                    type="checkbox"
                    data-testid={`cron-deliver-${id}`}
                    checked={deliverIds.includes(id)}
                    onChange={() => toggleDeliver(id)}
                  />
                  <span>
                    {kind === "local"
                      ? t("cron.deliver.local")
                      : kind === "botChat"
                        ? t("cron.deliver.botChat", { name: npcName ?? profileName ?? id })
                        : (target?.name ?? id)}
                    {target && kind === "platform" && !target.home_target_set && (
                      <span className="ml-1 text-text-dim">({t("cron.deliver.needsHome")})</span>
                    )}
                  </span>
                </label>
              ))}
            </div>
            <p data-testid="cron-deliver-hint" className="mt-1 text-[11px] text-text-dim">
              {t("cron.deliver.localHint")}
            </p>
            {targetsBlocker && (
              <button
                type="button"
                onClick={() => setChecklistOpen(true)}
                className="mt-1 text-xs text-text-muted underline"
              >
                {t("gateChecklist.whatIsNeeded")}
              </button>
            )}
          </fieldset>

          <label className="block text-xs text-text-muted">
            {t("cron.field.model")}
            <input
              data-testid="cron-model"
              className={`${inputClass} mt-1 font-mono`}
              value={modelSpec}
              placeholder={t("cron.field.modelHint")}
              onChange={(e) => setModelSpec(e.target.value)}
            />
          </label>

          {error !== null && <CronErrorNotice notice={classifyCronError(error)} />}
        </form>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded bg-surface hover:bg-surface-raised text-text"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            data-testid="cron-submit"
            onClick={() => void submit()}
            disabled={!canSubmit}
            className="px-3 py-1.5 text-sm rounded bg-primary text-white font-semibold disabled:opacity-50"
          >
            {t("common.save")}
          </button>
        </div>
      </div>
      <GateChecklistModal
        blocker={checklistOpen ? targetsBlocker : null}
        onClose={() => setChecklistOpen(false)}
      />
    </div>
  );
}
