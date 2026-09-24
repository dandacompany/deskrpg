"use client";
/**
 * Employees whose kanban/cron work leaves no artifacts — one line on the gateway screen (buttons only for the owner).
 *
 * Workers and cron start from the employee's profile home, and without the plugin in that home no result files accumulate
 * (`src/lib/hermes/worker-plugin.ts`). Placed right below the plugin version line so that when the plugin is updated this line
 * appears then, and [적용] is pressed separately — so an "update" does not secretly change the employees' config files too.
 *
 * From plugin 0.16.0 this "place the plugin in employee homes" (worker propagation) must be turned on by the operator (off by default).
 * When off (`propagation === "disabled"`, or [적용] gets 409 `worker_propagation_disabled`)
 * it shows what does not work and how to turn it on instead of the raw code. There are two ways to turn it on — if DeskRPG can change the
 * host setting, [설정에서 켜기] (`enablePropagation`); otherwise the operator copies a command to run.
 *
 * The apply result stays even after the list reloads and the warning disappears (`result` state) — so the user reads the notice
 * that "cron may need a restart".
 */
import { useState } from "react";

import { CopyCommand } from "@/components/CopyCommand";
import { useT } from "@/lib/i18n";
import {
  WORKER_PROPAGATION_DISABLED,
  WORKER_PROPAGATION_ENABLE_COMMAND,
  WORKER_PROPAGATION_ENV,
  type WorkerPropagation,
} from "@/lib/hermes/deskrpg-plugin-types";
import type { WorkerPluginResult, WorkerPluginWarning } from "@/lib/hermes/worker-plugin";

export type WorkerPluginApplyResponse =
  { ok: true; results: WorkerPluginResult[] } | { ok: false; errorCode: string };

/**
 * The [설정에서 켜기] result. `ok: true` if turned on — with `applyErrorCode` if the following apply failed.
 * `ok: false` if it could not be turned on at the host step (falls back to copying the command).
 */
export type WorkerPropagationEnableResponse =
  | { ok: true; results?: WorkerPluginResult[]; applyErrorCode?: string }
  | { ok: false; errorCode: string };

/** A host where DeskRPG cannot run commands — guided as "turn it on yourself", not as a failure. */
const UNSUPPORTED_HOST = "plugin_update_unsupported_host";

type Result =
  | { kind: "applied"; failures: { profile: string; error: string }[] }
  | { kind: "error"; code: string }
  | { kind: "propagationDisabled" };

type EnableState =
  | { kind: "idle" }
  | { kind: "enabled" }
  | { kind: "applyFailed"; code: string }
  | { kind: "failed"; code: string };

export default function WorkerPluginLine({
  warning,
  propagation,
  isOwner,
  apply,
  onApplied,
  enablePropagation,
  onRecheck,
}: {
  warning: WorkerPluginWarning | null;
  /** 0.16.0 worker propagation state. `null`/`undefined` means unknown (old plugin, shared row) — behaves as before. */
  propagation?: WorkerPropagation | null;
  isOwner: boolean;
  apply: () => Promise<WorkerPluginApplyResponse>;
  onApplied: () => void;
  /** DeskRPG turns worker propagation on through the host setting. Without it, only the command shows instead of [설정에서 켜기]. */
  enablePropagation?: () => Promise<WorkerPropagationEnableResponse>;
  /** Recheck the gateway and reread plugin info (the [다시 확인] after running the command). */
  onRecheck?: () => Promise<void> | void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [enabling, setEnabling] = useState(false);
  const [enableState, setEnableState] = useState<EnableState>({ kind: "idle" });
  const [rechecking, setRechecking] = useState(false);

  const propagationOff =
    enableState.kind !== "enabled" &&
    enableState.kind !== "applyFailed" &&
    (propagation === "disabled" || result?.kind === "propagationDisabled");

  if (!warning && !result && !propagationOff && enableState.kind === "idle") return null;

  const reason = (code: string) =>
    code === "config_unreadable"
      ? t("gateways.workerPlugin.reasonConfigUnreadable")
      : code === "not_found"
        ? t("gateways.workerPlugin.reasonNotFound")
        : t("gateways.workerPlugin.reasonOther", { code });

  const run = async () => {
    setBusy(true);
    try {
      const res = await apply();
      if (!res.ok) {
        setResult(
          res.errorCode === WORKER_PROPAGATION_DISABLED
            ? { kind: "propagationDisabled" }
            : { kind: "error", code: res.errorCode },
        );
        return;
      }
      const failures = res.results.filter(
        (r): r is { profile: string; error: string } => "error" in r,
      );
      setResult({ kind: "applied", failures });
      onApplied();
    } catch {
      setResult({ kind: "error", code: "request_failed" });
    } finally {
      setBusy(false);
    }
  };

  const enable = async () => {
    if (!enablePropagation) return;
    setEnabling(true);
    try {
      const res = await enablePropagation();
      if (!res.ok) {
        setEnableState({ kind: "failed", code: res.errorCode });
        return;
      }
      setResult(null);
      setEnableState(
        res.applyErrorCode
          ? { kind: "applyFailed", code: res.applyErrorCode }
          : { kind: "enabled" },
      );
      onApplied();
    } catch {
      setEnableState({ kind: "failed", code: "request_failed" });
    } finally {
      setEnabling(false);
    }
  };

  const recheck = async () => {
    if (!onRecheck) return;
    setRechecking(true);
    try {
      await onRecheck();
    } finally {
      setRechecking(false);
    }
  };

  // If [설정에서 켜기] is absent or that path is blocked, show the command the operator runs directly.
  const showCommand = !enablePropagation || enableState.kind === "failed";
  const buttonClass =
    "rounded-md bg-surface-raised px-2 py-0.5 text-[11px] font-medium hover:brightness-110 disabled:opacity-60";

  return (
    <div className="-mt-3 mb-4 space-y-1 text-xs text-text-muted" data-worker-plugin-line="">
      {warning && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-semibold text-npc-dark">
            {t("gateways.workerPlugin.missing", {
              count: warning.fixable.length,
              names: warning.fixable.join(", "),
            })}
          </span>
          {/* With propagation off, [적용] ends in 409 — show how to turn it on instead. */}
          {isOwner && !propagationOff && (
            <>
              <button
                type="button"
                onClick={() => void run()}
                disabled={busy}
                className={buttonClass}
              >
                {busy ? t("gateways.workerPlugin.applying") : t("gateways.workerPlugin.apply")}
              </button>
              <span>{t("gateways.workerPlugin.whatChanges")}</span>
            </>
          )}
        </p>
      )}
      {warning && warning.disabledByOperator.length > 0 && (
        <p className="text-text-dim">
          {t("gateways.workerPlugin.disabledByOperator", {
            names: warning.disabledByOperator.join(", "),
          })}
        </p>
      )}
      {propagationOff && (
        <div
          className="space-y-1.5 rounded-lg border border-border bg-surface p-2.5"
          data-worker-propagation="disabled"
        >
          <p className="font-semibold text-npc-dark">{t("gateways.workerPlugin.propagationOff")}</p>
          <p>{t("gateways.workerPlugin.propagationWhat")}</p>
          {!isOwner ? (
            <p className="text-text-dim">{t("gateways.workerPlugin.propagationOwnerOnly")}</p>
          ) : (
            <>
              {enablePropagation && enableState.kind !== "failed" && (
                <button
                  type="button"
                  data-action="worker-propagation-enable"
                  onClick={() => void enable()}
                  disabled={enabling}
                  className={buttonClass}
                >
                  {enabling
                    ? t("gateways.workerPlugin.enabling")
                    : t("gateways.workerPlugin.enableInSettings")}
                </button>
              )}
              {enableState.kind === "failed" && (
                <p className="text-danger" data-worker-propagation-result="failed">
                  {enableState.code === UNSUPPORTED_HOST
                    ? t("gateways.workerPlugin.propagationUnsupportedHost")
                    : t("gateways.workerPlugin.propagationEnableFailed", {
                        code: enableState.code,
                      })}
                </p>
              )}
              {showCommand && (
                <>
                  <p>{t("gateways.workerPlugin.propagationCommand")}</p>
                  <CopyCommand command={WORKER_PROPAGATION_ENABLE_COMMAND} />
                  <p className="text-text-dim">
                    {t("gateways.workerPlugin.propagationEnv", { env: WORKER_PROPAGATION_ENV })}
                  </p>
                  {onRecheck && (
                    <button
                      type="button"
                      data-action="worker-propagation-recheck"
                      onClick={() => void recheck()}
                      disabled={rechecking}
                      className={buttonClass}
                    >
                      {rechecking
                        ? t("gateways.workerPlugin.rechecking")
                        : t("gateways.workerPlugin.recheck")}
                    </button>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}
      {enableState.kind === "enabled" && (
        <p className="text-success" data-worker-propagation-result="enabled">
          {t("gateways.workerPlugin.propagationEnabled")}
        </p>
      )}
      {enableState.kind === "applyFailed" && (
        <p className="text-danger" data-worker-propagation-result="apply-failed">
          {t("gateways.workerPlugin.propagationApplyFailed", { code: enableState.code })}
        </p>
      )}
      {result?.kind === "applied" && (
        <p className="text-success" data-worker-plugin-result="applied">
          {t("gateways.workerPlugin.applied")}
        </p>
      )}
      {result?.kind === "applied" &&
        result.failures.map((f) => (
          <p key={f.profile} className="text-danger" data-worker-plugin-failure={f.profile}>
            {t("gateways.workerPlugin.failed", { name: f.profile, reason: reason(f.error) })}
          </p>
        ))}
      {result?.kind === "error" && (
        <p className="text-danger" data-worker-plugin-result="error">
          {t("gateways.workerPlugin.requestFailed", { code: result.code })}
        </p>
      )}
    </div>
  );
}
