"use client";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ShieldCheck, Trash2, X } from "lucide-react";

import { APPROVAL_POLICY_MIN_VERSION } from "@/lib/hermes/deskrpg-plugin-types";
import type { ApprovalMode, ApprovalPolicy } from "@/lib/hermes/plugin-client-types";
import { useT } from "@/lib/i18n";

import {
  ApprovalPolicyApiError,
  createApprovalPolicyApi,
  isValidAllowlistEntry,
  type ApprovalPolicyClientApi,
  type ApprovalPolicyView,
} from "./approval-policy-api";

export type ApprovalPolicyModalProps = {
  channelId: string;
  npcId: string;
  npcName: string;
  onClose(): void;
  api?: ApprovalPolicyClientApi;
};

type ModeField = "cronMode" | "singleQueryMode";
const MODE_SECTIONS: { field: ModeField; id: "cron" | "single" }[] = [
  { field: "cronMode", id: "cron" },
  { field: "singleQueryMode", id: "single" },
];

/**
 * An NPC's unattended run policy — whether dangerous commands in cron jobs and in kanban/one-shot
 * runs are blocked or allowed, and the allowlist that runs even when blocked. Nobody is present
 * to approve those runs, so this is the only approval they get. Members see it read-only; the
 * gateway owner changes it, and switching a mode to allow needs an explicit confirmation. Changes
 * apply from the next run.
 */
export default function ApprovalPolicyModal({
  channelId,
  npcId,
  npcName,
  onClose,
  api: injected,
}: ApprovalPolicyModalProps) {
  const t = useT();
  const api = useMemo(
    () => injected ?? createApprovalPolicyApi(channelId, npcId),
    [injected, channelId, npcId],
  );
  const [view, setView] = useState<ApprovalPolicyView | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [confirming, setConfirming] = useState<ModeField | null>(null);
  const [entry, setEntry] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    setView(null);
    setLoadError(null);
    api.get().then(
      (v) => {
        if (!stale) setView(v);
      },
      (e: unknown) => {
        if (!stale) setLoadError(e);
      },
    );
    return () => {
      stale = true;
    };
  }, [api]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const errorText = (e: unknown) => {
    const code = e instanceof ApprovalPolicyApiError ? e.code : "";
    if (code === "invalid_allowlist_entry") return t("approvalPolicy.error.invalidEntry");
    if (code === "forbidden") return t("approvalPolicy.error.forbidden");
    return t("approvalPolicy.error.action");
  };

  /** Applies a write: the response is the bare policy, so the permission fields are kept. */
  const run = async (write: () => Promise<ApprovalPolicy>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const next = await write();
      setView((v) => (v ? { ...v, ...next } : v));
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const setMode = (field: ModeField, mode: ApprovalMode) => {
    if (!view || view[field] === mode) return;
    if (mode === "approve") {
      setConfirming(field);
      return;
    }
    void run(() => api.setModes({ [field]: mode }));
  };

  const addEntry = async () => {
    const value = entry.trim();
    if (!isValidAllowlistEntry(value)) {
      setError(t("approvalPolicy.error.invalidEntry"));
      return;
    }
    if (await run(() => api.addAllowlist(value))) setEntry("");
  };

  const upgrade =
    (loadError instanceof ApprovalPolicyApiError && loadError.code === "plugin_upgrade_required") ||
    view?.capabilityReady === false;
  const canManage = !!view?.canManage;
  const segCls = (on: boolean) =>
    `rounded px-2 py-0.5 text-xs disabled:cursor-default ${
      on
        ? "bg-primary text-white"
        : "text-text-muted hover:bg-surface-raised disabled:hover:bg-transparent"
    }`;

  let body: React.ReactNode;
  if (upgrade) {
    body = (
      <p data-upgrade-required className="text-sm text-text-muted">
        {t("approvalPolicy.upgradeRequired", { version: APPROVAL_POLICY_MIN_VERSION })}
      </p>
    );
  } else if (loadError) {
    const gateway = loadError instanceof ApprovalPolicyApiError && loadError.status === 409;
    body = (
      <p className="text-sm text-danger">
        {t(gateway ? "approvalPolicy.gatewayDisconnected" : "approvalPolicy.error.load")}
      </p>
    );
  } else if (!view) {
    body = <p className="text-sm text-text-dim">{t("approvalPolicy.loading")}</p>;
  } else {
    body = (
      <div className="flex flex-col gap-4 text-sm">
        <p className="text-xs text-text-muted">{t("approvalPolicy.intro")}</p>
        {!canManage && <p className="text-xs text-text-dim">{t("approvalPolicy.readOnly")}</p>}
        {view.sharedChannelCount > 0 && (
          <p className="text-xs text-text-muted">
            {t("approvalPolicy.sharedWarning", { n: view.sharedChannelCount })}
          </p>
        )}
        {view.workerPropagation === false && (
          <p
            data-worker-propagation-off
            className="flex items-start gap-1.5 rounded border border-border bg-surface-raised p-2 text-xs text-text-muted"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" />
            {t("approvalPolicy.workerPropagationOff")}
          </p>
        )}
        {MODE_SECTIONS.map(({ field, id }) => (
          <section key={field} className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="flex-1 font-semibold text-text">{t(`approvalPolicy.${id}.title`)}</h3>
              {(["deny", "approve"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  data-mode={`${id}:${mode}`}
                  aria-pressed={view[field] === mode}
                  disabled={!canManage || busy}
                  onClick={() => setMode(field, mode)}
                  className={segCls(view[field] === mode)}
                >
                  {t(`approvalPolicy.mode.${mode}`)}
                </button>
              ))}
            </div>
            <p className="text-xs text-text-dim">{t(`approvalPolicy.${id}.hint`)}</p>
            {confirming === field && (
              <div
                data-dialog="approve-confirm"
                role="alertdialog"
                className="flex flex-col gap-2 rounded border border-danger/40 p-2 text-xs"
              >
                <p className="flex items-start gap-1.5 text-text">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" />
                  {t("approvalPolicy.approveConfirm")}
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    data-action="approve-confirm"
                    disabled={busy}
                    onClick={() => {
                      setConfirming(null);
                      void run(() => api.setModes({ [field]: "approve" }));
                    }}
                    className="rounded bg-danger px-3 py-1 text-white disabled:opacity-50"
                  >
                    {t("approvalPolicy.approveConfirmSubmit")}
                  </button>
                  <button
                    type="button"
                    data-action="approve-cancel"
                    onClick={() => setConfirming(null)}
                    className="rounded px-3 py-1 text-text-muted hover:bg-surface-raised"
                  >
                    {t("approvalPolicy.cancel")}
                  </button>
                </div>
              </div>
            )}
          </section>
        ))}
        <section className="flex flex-col gap-1">
          <h3 className="font-semibold text-text">{t("approvalPolicy.allowlist.title")}</h3>
          <p className="text-xs text-text-dim">{t("approvalPolicy.allowlist.hint")}</p>
          {view.allowlist.length === 0 && (
            <p className="text-xs text-text-dim">{t("approvalPolicy.allowlist.empty")}</p>
          )}
          <ul className="flex flex-col gap-1">
            {view.allowlist.map((item) => (
              <li
                key={item}
                data-allow={item}
                className="flex items-center gap-2 rounded bg-surface-raised px-2 py-1"
              >
                <span className="min-w-0 flex-1 break-all font-mono text-xs text-text">{item}</span>
                {canManage && (
                  <button
                    type="button"
                    data-remove-allow={item}
                    aria-label={t("approvalPolicy.allowlist.remove")}
                    disabled={busy}
                    onClick={() => void run(() => api.removeAllowlist(item))}
                    className="text-text-muted hover:text-danger disabled:opacity-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
          {canManage && (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!busy) void addEntry();
              }}
            >
              <input
                name="allow-entry"
                value={entry}
                autoComplete="off"
                spellCheck={false}
                aria-label={t("approvalPolicy.allowlist.placeholder")}
                placeholder={t("approvalPolicy.allowlist.placeholder")}
                onChange={(e) => setEntry(e.target.value)}
                className="min-w-0 flex-1 rounded bg-surface-raised px-2 py-1 font-mono text-xs text-text"
              />
              <button
                type="submit"
                data-action="add-allow"
                disabled={busy || !entry.trim()}
                className="rounded bg-primary px-3 py-1 text-xs text-white disabled:opacity-50"
              >
                {t("approvalPolicy.allowlist.add")}
              </button>
            </form>
          )}
        </section>
        <p className="text-xs text-text-dim">
          {t("approvalPolicy.appliesNext", { seconds: view.timeoutSeconds })}
        </p>
        {error && (
          <p data-error className="text-xs text-danger">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="approval-policy-title"
        className="flex max-h-[88dvh] w-[96vw] max-w-[640px] flex-col rounded-xl border border-border bg-bg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex flex-shrink-0 items-center gap-3 border-b border-border px-5 py-3">
          <h2 id="approval-policy-title" className="flex items-center gap-1.5 text-sm font-bold">
            <ShieldCheck className="h-4 w-4" />
            {t("approvalPolicy.title", { name: npcName })}
          </h2>
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
        <div className="overflow-y-auto px-5 py-4">{body}</div>
      </div>
    </div>
  );
}
