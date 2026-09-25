"use client";
/**
 * Automation blueprint gallery (R21): list (title/description/category/tags) -> select -> field
 * form + assigned NPC -> instantiate. Field types are enum/text/time/weekdays. When `strict` is
 * not set, enum/weekdays also allow free input (datalist). The `deliver` slot renders as the same
 * delivery-target checkboxes as the cron form.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";

import { useT } from "@/lib/i18n";
import type { AutomationBlueprint, CronDeliveryTarget } from "@/lib/hermes/deskrpg-plugin-types";
import GateChecklistModal from "@/components/gateway/GateChecklistModal";
import { classifyGateFailure, isSetupBlocker, type GateBlocker } from "@/lib/gate-failure";

import { cronApi, classifyCronError, isCronApiError, type CronJobView } from "./cron-api";
import { composeDeliver, parseDeliver } from "./cron-schedule";
import {
  localizeBlueprint,
  type LocalizedBlueprint,
  type LocalizedBlueprintField,
} from "./blueprint-l10n";
import { deliverRows as buildDeliverRows } from "./deliver-targets";
import { CronErrorNotice } from "./cron-notices";
import type { CronEditorNpc } from "./CronEditorDialog";

interface BlueprintGalleryProps {
  channelId: string;
  npcs: CronEditorNpc[];
  defaultNpcId?: string | null;
  onCreated: (job: CronJobView) => void;
  onClose: () => void;
}

const DELIVER_FIELD = "deliver";

/** Fills the form with field defaults. The deliver slot's "origin"/empty value becomes local. */
export function initialBlueprintValues(blueprint: AutomationBlueprint): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of blueprint.fields) {
    const seeded = field.default ?? "";
    out[field.name] =
      field.name === DELIVER_FIELD && (seeded === "" || seeded === "origin") ? "local" : seeded;
  }
  return out;
}

/** Maps a CronApiError to the GateBlocker the checklist understands. classifyGateFailure alone decides. */
function blockerFromCronError(err: unknown): GateBlocker | null {
  if (!isCronApiError(err)) return null;
  return classifyGateFailure({
    status: err.status,
    code: err.code,
    message: err.message,
    minVersion: typeof err.details.minVersion === "string" ? err.details.minVersion : undefined,
  });
}

/** Names of required (not optional) fields that are empty. */
export function missingRequiredFields(
  blueprint: AutomationBlueprint,
  values: Record<string, string>,
): string[] {
  return blueprint.fields
    .filter((field) => !field.optional && !(values[field.name] ?? "").trim())
    .map((field) => field.name);
}

function FieldControl({
  field,
  value,
  onChange,
  inputClass,
}: {
  field: LocalizedBlueprintField;
  value: string;
  onChange: (next: string) => void;
  inputClass: string;
}) {
  if (field.type === "time") {
    return (
      <input
        type="time"
        className={inputClass}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  if ((field.type === "enum" || field.type === "weekdays") && field.options?.length) {
    if (field.strict !== false) {
      return (
        <select className={inputClass} value={value} onChange={(e) => onChange(e.target.value)}>
          {field.optional && <option value="">—</option>}
          {field.options.map((option) => (
            <option key={option} value={option}>
              {field.optionLabels[option] ?? option}
            </option>
          ))}
        </select>
      );
    }
    const listId = `bp-options-${field.name}`;
    return (
      <>
        <input
          className={inputClass}
          list={listId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <datalist id={listId}>
          {field.options.map((option) => (
            <option key={option} value={option} label={field.optionLabels[option] ?? option} />
          ))}
        </datalist>
      </>
    );
  }
  return (
    <input
      className={inputClass}
      value={value}
      placeholder={field.help ?? field.label}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export default function BlueprintGallery({
  channelId,
  npcs,
  defaultNpcId = null,
  onCreated,
  onClose,
}: BlueprintGalleryProps) {
  const t = useT();
  const [npcId, setNpcId] = useState<string>(defaultNpcId ?? npcs[0]?.npcId ?? "");
  const [catalog, setCatalog] = useState<AutomationBlueprint[] | null>(null);
  const [targets, setTargets] = useState<CronDeliveryTarget[]>([]);
  const [targetsBlocker, setTargetsBlocker] = useState<GateBlocker | null>(null);
  const [checklistBlocker, setChecklistBlocker] = useState<GateBlocker | null>(null);
  const [selected, setSelected] = useState<LocalizedBlueprint | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<unknown>(null);
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);

  // Blueprints and delivery targets belong to the NPC's profile — refetch when the assigned NPC changes.
  useEffect(() => {
    if (!npcId) return;
    let cancelled = false;
    setLoadError(null);
    setTargetsBlocker(null);
    cronApi
      .listBlueprints(channelId, npcId)
      .then((res) => {
        if (!cancelled) setCatalog(res.blueprints);
      })
      .catch((err) => {
        if (!cancelled) {
          setCatalog([]);
          setLoadError(err);
        }
      });
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
        const blocker = blockerFromCronError(err);
        if (blocker && isSetupBlocker(blocker)) setTargetsBlocker(blocker);
      });
    return () => {
      cancelled = true;
    };
  }, [channelId, npcId]);

  // Hermes serves the catalog in English; the locale files overlay what the user reads.
  const tr = useCallback(
    (key: string) => {
      const text = t(key);
      return text && text !== key ? text : null;
    },
    [t],
  );
  const blueprints = useMemo(
    () => catalog?.map((blueprint) => localizeBlueprint(blueprint, tr)) ?? null,
    [catalog, tr],
  );
  const channelProfiles = useMemo(
    () =>
      npcs.flatMap((npc) =>
        npc.profileName ? [{ profileName: npc.profileName, npcName: npc.npcName }] : [],
      ),
    [npcs],
  );

  const loadBlocker = useMemo(() => blockerFromCronError(loadError), [loadError]);
  const submitBlocker = useMemo(() => blockerFromCronError(submitError), [submitError]);

  const select = (blueprint: LocalizedBlueprint) => {
    setSelected(blueprint);
    setValues(initialBlueprintValues(blueprint));
    setSubmitError(null);
  };

  const chosenDeliver = useMemo(() => parseDeliver(values[DELIVER_FIELD]), [values]);
  const deliverRows = useMemo(
    () =>
      buildDeliverRows(
        targets,
        chosenDeliver,
        channelProfiles.length > 0 ? channelProfiles : undefined,
      ),
    [targets, chosenDeliver, channelProfiles],
  );

  const missing = selected ? missingRequiredFields(selected, values) : [];
  const canSubmit = !!selected && !!npcId && missing.length === 0 && !saving;

  const submit = async () => {
    if (!selected || !canSubmit) return;
    setSaving(true);
    setSubmitError(null);
    try {
      const res = await cronApi.instantiateBlueprint(channelId, {
        npcId,
        blueprint: selected.key,
        values,
      });
      onCreated(res.job);
    } catch (err) {
      setSubmitError(err);
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    "w-full px-3 py-2 bg-surface border border-border rounded text-sm text-text focus:outline-none focus:border-primary mt-1";
  const titleId = "cron-blueprint-title";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-bg border border-border rounded-xl shadow-2xl w-[90vw] max-w-[640px] max-h-[85dvh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h2 id={titleId} className="text-sm font-bold">
            {selected ? selected.title : t("cron.blueprint.title")}
          </h2>
          <button onClick={onClose} aria-label={t("common.close")} className="text-text-muted">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          <label className="block text-xs text-text-muted">
            {t("cron.field.npc")}
            <select
              data-testid="bp-npc"
              className={inputClass}
              value={npcId}
              onChange={(e) => setNpcId(e.target.value)}
            >
              {!npcId && <option value="">—</option>}
              {npcs.map((npc) => (
                <option key={npc.npcId} value={npc.npcId}>
                  {npc.npcName}
                </option>
              ))}
            </select>
          </label>

          {loadError !== null && (
            <div>
              <CronErrorNotice notice={classifyCronError(loadError)} />
              {loadBlocker && isSetupBlocker(loadBlocker) && (
                <button
                  type="button"
                  onClick={() => setChecklistBlocker(loadBlocker)}
                  className="text-xs text-text-muted underline"
                >
                  {t("gateChecklist.whatIsNeeded")}
                </button>
              )}
            </div>
          )}

          {!selected ? (
            blueprints === null ? (
              <p className="text-sm text-text-dim">{t("common.loading")}</p>
            ) : blueprints.length === 0 ? (
              <p className="text-sm text-text-dim">{t("cron.blueprint.empty")}</p>
            ) : (
              <ul role="list" className="space-y-2">
                {blueprints.map((blueprint) => (
                  <li key={blueprint.key} role="listitem">
                    <button
                      type="button"
                      onClick={() => select(blueprint)}
                      className="w-full text-left p-3 rounded-lg bg-surface hover:bg-surface-raised border border-border"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-text">{blueprint.title}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-raised text-text-muted">
                          {blueprint.categoryLabel}
                        </span>
                      </div>
                      <p className="text-xs text-text-muted mt-1">{blueprint.description}</p>
                      {blueprint.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {blueprint.tags.map((tag, i) => (
                            <span
                              key={tag}
                              className="text-[10px] px-1.5 py-0.5 rounded-full bg-bg border border-border text-text-dim"
                            >
                              #{blueprint.tagLabels[i] ?? tag}
                            </span>
                          ))}
                        </div>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-text-muted">{selected.description}</p>
              {selected.fields.map((field) => (
                <div key={field.name} className="text-xs text-text-muted">
                  <span>
                    {field.label}
                    {field.optional && (
                      <span className="ml-1 text-text-dim">({t("cron.blueprint.optional")})</span>
                    )}
                  </span>
                  {field.name === DELIVER_FIELD ? (
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                      {deliverRows.map(({ id, kind, target, profileName, npcName }) => (
                        <label key={id} className="inline-flex items-center gap-1.5 text-text">
                          <input
                            type="checkbox"
                            checked={chosenDeliver.includes(id)}
                            onChange={() => {
                              const next = chosenDeliver.includes(id)
                                ? chosenDeliver.filter((x) => x !== id)
                                : [...chosenDeliver, id];
                              setValues((v) => ({ ...v, [DELIVER_FIELD]: composeDeliver(next) }));
                            }}
                          />
                          <span>
                            {kind === "local"
                              ? t("cron.deliver.local")
                              : kind === "botChat"
                                ? t("cron.deliver.botChat", { name: npcName ?? profileName ?? id })
                                : (target?.name ?? id)}
                          </span>
                        </label>
                      ))}
                      {targetsBlocker && (
                        <button
                          type="button"
                          onClick={() => setChecklistBlocker(targetsBlocker)}
                          className="text-xs text-text-muted underline"
                        >
                          {t("gateChecklist.whatIsNeeded")}
                        </button>
                      )}
                      <p
                        data-testid="bp-deliver-hint"
                        className="basis-full text-[11px] text-text-dim"
                      >
                        {t("cron.deliver.localHint")}
                      </p>
                    </div>
                  ) : (
                    <FieldControl
                      field={field}
                      value={values[field.name] ?? ""}
                      onChange={(next) => setValues((v) => ({ ...v, [field.name]: next }))}
                      inputClass={inputClass}
                    />
                  )}
                  {field.help && field.type !== "text" && field.name !== DELIVER_FIELD && (
                    <p className="mt-1 text-[11px] text-text-dim">{field.help}</p>
                  )}
                </div>
              ))}
              {submitError !== null && (
                <div>
                  <CronErrorNotice notice={classifyCronError(submitError)} />
                  {submitBlocker && isSetupBlocker(submitBlocker) && (
                    <button
                      type="button"
                      onClick={() => setChecklistBlocker(submitBlocker)}
                      className="text-xs text-text-muted underline"
                    >
                      {t("gateChecklist.whatIsNeeded")}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-between gap-2 px-5 py-3 border-t border-border">
          <div>
            {selected && (
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="px-3 py-1.5 text-sm rounded bg-surface hover:bg-surface-raised text-text"
              >
                {t("cron.blueprint.back")}
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-sm rounded bg-surface hover:bg-surface-raised text-text"
            >
              {t("common.cancel")}
            </button>
            {selected && (
              <button
                type="button"
                data-testid="bp-submit"
                onClick={() => void submit()}
                disabled={!canSubmit}
                className="px-3 py-1.5 text-sm rounded bg-primary text-white font-semibold disabled:opacity-50"
              >
                {t("cron.blueprint.instantiate")}
              </button>
            )}
          </div>
        </div>
      </div>
      <GateChecklistModal blocker={checklistBlocker} onClose={() => setChecklistBlocker(null)} />
    </div>
  );
}
