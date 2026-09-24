"use client";

/**
 * A line shown once when a plugin update **inherited worker propagation turned on**.
 *
 * Old plugins (before 0.16.0) created links in every employee profile. From 0.16.0 propagation is off by default,
 * so the update sees those traces and turns the operator setting on (`startPluginUpdate`, the job's `workerPropagationInherited`).
 * Here we report that and give a way back with [끄기] — turning it off only stops applying to new employees; existing
 * links are not deleted by the plugin.
 */
import { useState } from "react";

import { useT } from "@/lib/i18n";
import { withHeaderErrorCode } from "@/lib/i18n/error-codes";

export type TurnOffResult = { ok: true } | { ok: false; errorCode: string };

/** `POST /api/gateways/:id/plugin/worker-propagation` `{ enabled: false }`. Success only if it answers that it actually turned off. */
export async function disableWorkerPropagationRequest(
  gatewayId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TurnOffResult> {
  const res = await fetchImpl(
    `/api/gateways/${encodeURIComponent(gatewayId)}/plugin/worker-propagation`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    },
  );
  const body = withHeaderErrorCode(await res.json().catch(() => ({})), res.headers) as {
    propagation?: unknown;
    errorCode?: unknown;
  };
  const errorCode = typeof body.errorCode === "string" ? body.errorCode : null;
  if (!res.ok) return { ok: false, errorCode: errorCode ?? `http_${res.status}` };
  // If an environment variable in the root .env keeps it on, it is still enabled even after turning the setting off — do not say it turned off.
  if (body.propagation !== "disabled")
    return { ok: false, errorCode: errorCode ?? "propagation_still_enabled" };
  return { ok: true };
}

export default function WorkerPropagationInheritedNotice({
  turnOff,
  onChanged,
}: {
  turnOff: () => Promise<TurnOffResult>;
  /** After turning off, have the gateway list (propagation state) reread. */
  onChanged: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await turnOff();
      if (res.ok) {
        setDone(true);
        onChanged();
      } else setError(res.errorCode);
    } catch {
      setError("request_failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <p
      className="-mt-3 mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted"
      data-worker-propagation-inherited=""
    >
      {done ? (
        <span className="text-success">{t("hermes.pluginUpdate.workerPropagationTurnedOff")}</span>
      ) : (
        <>
          <span>{t("hermes.pluginUpdate.workerPropagationInherited")}</span>
          <button
            type="button"
            onClick={() => void run()}
            disabled={busy}
            className="rounded-md bg-surface-raised px-2 py-0.5 text-[11px] font-medium hover:brightness-110 disabled:opacity-60"
          >
            {t("hermes.pluginUpdate.workerPropagationTurnOff")}
          </button>
        </>
      )}
      {error && (
        <span className="text-danger">
          {t("hermes.pluginUpdate.workerPropagationTurnOffFailed", { code: error })}
        </span>
      )}
    </p>
  );
}
