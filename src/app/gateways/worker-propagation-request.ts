/**
 * The [설정에서 켜기] request — `POST /api/gateways/:id/plugin/worker-propagation` `{ enabled: true }`.
 *
 * Folds the three response branches into the shape `WorkerPluginLine` uses.
 * - 200 `{ propagation: "enabled", results? }` → turned on (with results when apply also succeeded), `ok: true`.
 * - 200 `{ propagation: "enabled", errorCode }` (code also in a header) → turned on but the apply step failed — `applyErrorCode`.
 * - 4xx `{ errorCode }` → could not turn on at the host step (`plugin_update_unsupported_host` falls back to copying the command).
 * A 200 that does not say it turned on is not treated as on.
 */
import { withHeaderErrorCode } from "@/lib/i18n/error-codes";

import type { WorkerPropagationEnableResponse } from "./WorkerPluginLine";

export async function enableWorkerPropagationRequest(
  gatewayId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<WorkerPropagationEnableResponse> {
  const res = await fetchImpl(
    `/api/gateways/${encodeURIComponent(gatewayId)}/plugin/worker-propagation`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    },
  );
  const body = withHeaderErrorCode(await res.json().catch(() => ({})), res.headers) as {
    propagation?: unknown;
    results?: unknown;
    errorCode?: unknown;
  };
  const errorCode = typeof body.errorCode === "string" ? body.errorCode : null;
  if (!res.ok) return { ok: false, errorCode: errorCode ?? `http_${res.status}` };
  if (body.propagation !== "enabled") {
    return { ok: false, errorCode: errorCode ?? "propagation_not_enabled" };
  }
  if (errorCode) return { ok: true, applyErrorCode: errorCode };
  return Array.isArray(body.results)
    ? {
        ok: true,
        results: body.results as NonNullable<
          Extract<WorkerPropagationEnableResponse, { ok: true }>["results"]
        >,
      }
    : { ok: true };
}
