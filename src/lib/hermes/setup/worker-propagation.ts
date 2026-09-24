/**
 * Worker propagation opt-in (plugin 0.16.0) — the judgment shared by the wizard, updates and "enable in settings".
 *
 * The operator setting (root config `plugins.entries.deskrpg.worker_propagation`) is written by the host helper,
 * and the plugin only reads it. Turning it on then calls the existing apply (`POST /deskrpg/worker-plugin`) so
 * already-hired employees get links too. Turning it off only stops propagation to new profiles — the plugin doesn't
 * delete existing links.
 *
 * All DB/host access is injected (tests pin only the judgment).
 */
import type { PluginInfo, WorkerPropagation } from "../deskrpg-plugin-types";
import {
  applyWorkerPlugin,
  WORKER_PLUGIN_CAPABILITY,
  type ApplyWorkerPluginDeps,
  type WorkerPluginResult,
} from "../worker-plugin";
import type { SetupCandidate } from "./types";

/**
 * Whether it's carried over on plugin update. If links propagated by the plugin remain (old versions had it on by
 * default) but the setting is off, carry it over as on so new employees alone don't get left out after the update.
 * If there are no links, the operator never turned it on, so the default off is kept. Unknown values are left alone.
 */
export function inheritedWorkerPropagation(
  candidate: Pick<SetupCandidate, "workerLinked" | "workerPropagation">,
): boolean {
  return candidate.workerLinked === true && candidate.workerPropagation === "disabled";
}

/** Whether the wizard also calls the existing apply after setup — when enable was chosen, it actually turned on,
 * and the plugin supports it. */
export function setupWorkerPluginApplies(
  requested: boolean | undefined,
  propagation: WorkerPropagation | undefined,
  info: Pick<PluginInfo, "capabilities"> | null,
): boolean {
  return (
    requested === true &&
    propagation === "enabled" &&
    Boolean(info?.capabilities.includes(WORKER_PLUGIN_CAPABILITY))
  );
}

export type WorkerPropagationResponse =
  | { propagation: WorkerPropagation; results?: WorkerPluginResult[] }
  | { propagation: WorkerPropagation; errorCode: string };

export type RunWorkerPropagationDeps = ApplyWorkerPluginDeps & {
  /** Host helper `set-worker-propagation` — returns the actual state (enabled even when writing off if an .env
   * variable keeps it on). */
  setFlag(enabled: boolean): Promise<WorkerPropagation>;
};

/**
 * Writes the flag and, if it turned on, calls the existing apply. Either way the plugin info cache is refilled so
 * the gateway list sees the new state (the apply path is filled by `applyWorkerPlugin`). An apply failure is
 * returned as a plugin code along with the flag result — the flag has already been written.
 */
export async function runWorkerPropagation(
  enabled: boolean,
  deps: RunWorkerPropagationDeps,
): Promise<WorkerPropagationResponse> {
  const propagation = await deps.setFlag(enabled);
  if (!enabled || propagation !== "enabled") {
    try {
      await deps.refreshCache();
    } catch {
      // The result is the source of truth. The cache is filled by the next probe.
    }
    return { propagation };
  }
  const outcome = await applyWorkerPlugin(deps);
  return outcome.ok
    ? { propagation, results: outcome.results }
    : { propagation, errorCode: outcome.errorCode };
}
