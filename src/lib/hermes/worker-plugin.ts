/**
 * Employees whose plugin does not load in kanban workers/cron — detection and fix.
 *
 * Workers start as `hermes -p <assigned profile>` and cron in that profile's home, but Hermes looks for plugins
 * only in **the loading home's** `plugins/`·`config.yaml`. If it is installed only at the root (gateway),
 * outputs pile up in chat but not a single result file from kanban/cron does — no error, no log.
 * Plugin 0.12.0 reports those employees via `worker_plugin.missing` in `/deskrpg/info`,
 * and fixes them via `POST /deskrpg/worker-plugin` (leaving a link, an enable entry and a backup per profile).
 *
 * The UI only makes this **visible**, it does not fix it silently. Employees the operator put in `plugins.disabled`
 * do not get the plugin enabled, so they are not counted as targets.
 *
 * All pure functions or dependency-injected (also goes into the browser bundle — does not pull in `@/db`).
 */
import type { PluginInfo, WorkerPluginGap, WorkerPluginReport } from "./deskrpg-plugin-types";

export const WORKER_PLUGIN_CAPABILITY = "worker_plugin";

function parseGap(value: unknown): WorkerPluginGap | null {
  if (typeof value !== "object" || value === null) return null;
  const r = value as Record<string, unknown>;
  if (typeof r.profile !== "string" || r.profile === "") return null;
  return {
    profile: r.profile,
    link: typeof r.link === "string" ? r.link : "missing",
    enabled: r.enabled === true,
    disabled: r.disabled === true,
  };
}

/**
 * Folds `info.worker_plugin`. **Distinguishes `undefined` from `null`** — old plugins lack the field
 * (`undefined`), and new plugins send `null` when detection fails. Neither shows a warning, but
 * "unknown" is not turned into "all fine".
 */
export function parseWorkerPluginReport(value: unknown): WorkerPluginReport | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") return null;
  const missing = (value as Record<string, unknown>).missing;
  if (!Array.isArray(missing)) return null;
  const propagation = (value as Record<string, unknown>).propagation;
  return {
    missing: missing.map(parseGap).filter((g): g is WorkerPluginGap => g !== null),
    ...(propagation === "enabled" || propagation === "disabled" ? { propagation } : {}),
  };
}

export type WorkerPluginWarning = {
  /** Employees fixable via the button (profile names). */
  fixable: string[];
  /** Employees the operator disabled via `plugins.disabled` — the button does not enable them. Only reported. */
  disabledByOperator: string[];
};

/** Whether to show the warning line. `null` if there is no employee to fix (no line at all). */
export function workerPluginWarning(info: PluginInfo | null): WorkerPluginWarning | null {
  if (!info || !info.capabilities.includes(WORKER_PLUGIN_CAPABILITY)) return null;
  const report = info.worker_plugin;
  if (!report) return null;
  const fixable = report.missing.filter((g) => !g.disabled).map((g) => g.profile);
  if (fixable.length === 0) return null;
  const disabledByOperator = report.missing.filter((g) => g.disabled).map((g) => g.profile);
  return { fixable, disabledByOperator };
}

export type WorkerPluginResult =
  { profile: string; link: string; enabled: string } | { profile: string; error: string };

type EnsureResponse =
  | { ok: true; data: { results: WorkerPluginResult[] } }
  | { ok: false; status: number; failure: { code: string } };

export type ApplyWorkerPluginDeps = {
  /** Plugin `POST /deskrpg/worker-plugin` (owner key). */
  ensure(): Promise<EnsureResponse>;
  /** Re-reads plugin info to fill the `plugin_info_json` cache. */
  refreshCache(): Promise<void>;
};

export type ApplyWorkerPluginOutcome =
  { ok: true; results: WorkerPluginResult[] } | { ok: false; errorCode: string };

/**
 * Applies and **always** refills the cache. The cache can be up to 1 hour stale (`shouldReprobePlugin`),
 * so without refilling the warning remains even after applying. Refill even if the call fails — some employees
 * may already have changed, and the UI must not hold a stale list. A cache refresh failure does not mask
 * the apply result (the next connection test fills it).
 */
export async function applyWorkerPlugin(
  deps: ApplyWorkerPluginDeps,
): Promise<ApplyWorkerPluginOutcome> {
  const res = await deps.ensure();
  try {
    await deps.refreshCache();
  } catch {
    // The apply result is the source of truth. The next probe fills the cache.
  }
  if (!res.ok) return { ok: false, errorCode: res.failure.code };
  return { ok: true, results: res.data.results };
}
