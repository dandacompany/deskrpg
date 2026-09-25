/**
 * The automation plugin gate — **a single** judgment function.
 *
 * Kanban (board acquisition, poller) and cron REST must use the same judgment. There
 * used to be two copies, and the cron side trusted a fresh `unknown`/`plugin_absent`/
 * `plugin_unauthorized` cache as-is and then misdiagnosed it as 428
 * `plugin_upgrade_required` because "there's no info". The judgment happens only here;
 * translating it into an HTTP response is `cron-access.ts`'s `pluginGateResponse`.
 *
 * Reads the gateway's plugin verdict from the cache (the 1-hour rule —
 * `shouldReprobePlugin`), or reprobes to refill the cache. There are two cases where it
 * reprobes even with a fresh cache — because there's no information yet, not because a
 * verdict was reached:
 * - `unknown` (unreachable/timeout) — holding this for an hour would block board
 *   acquisition even after the gateway comes back up.
 * - `plugin_ready` but `plugin_info_json` is empty — judging the contract without info
 *   produces `no_info` -> `plugin_upgrade_required`, a misjudgment held for an hour
 *   (this is the shape of a cache the setup wizard leaves behind).
 */

import { eq } from "drizzle-orm";

import { db, gatewayResources } from "@/db";
import type { PluginInfo } from "@/lib/hermes/deskrpg-plugin-types";
import {
  buildPluginCacheUpdate,
  buildPluginInfoCacheUpdate,
  restorePluginInfo,
} from "@/lib/hermes/plugin-cache-update";
import {
  meetsAutomationContract,
  probeDeskrpgPluginWithInfo,
  resolvePluginStatusFromCache,
  type AutomationContractVerdict,
  type PluginStatus,
} from "@/lib/hermes/plugin-capability";
import { transportFetch } from "@/lib/hermes/setup/transport";

export type GatewayResourceRow = typeof gatewayResources.$inferSelect;

/** The failure code the gate emits. Stored as-is in `channel_kanban_boards.last_error`. */
export type PluginGateFailureCode =
  "plugin_absent" | "plugin_unauthorized" | "plugin_unknown" | "plugin_upgrade_required";

/** The plugin contract verdict. On `ok:false`, `code` becomes `last_error` as-is. */
export type PluginGate =
  | { ok: true; status: "plugin_ready"; info: PluginInfo }
  | {
      ok: false;
      status: PluginStatus;
      code: PluginGateFailureCode;
      reason: string;
      /** If `plugin_unknown` was a transport-layer failure, which kind — becomes the HTTP response's code. */
      transport?: "unreachable" | "timeout";
      /** Contract verdict detail for `plugin_upgrade_required` (min version, reason, missing capability). */
      verdict?: Extract<AutomationContractVerdict, { ok: false }>;
    };

export async function gateAutomationPlugin(
  resource: GatewayResourceRow,
  ownerToken: string,
  now = new Date(),
): Promise<PluginGate> {
  const cached = resolvePluginStatusFromCache({
    pluginStatus: resource.pluginStatus,
    pluginCheckedAt: resource.pluginCheckedAt,
    now,
  });

  const cachedInfo = restorePluginInfo(resource.pluginInfoJson);
  const cacheUsable =
    !cached.needsReprobe &&
    cached.status !== "unknown" &&
    !(cached.status === "plugin_ready" && cachedInfo === null);

  let status: PluginStatus;
  let info: PluginInfo | null;
  let transport: "unreachable" | "timeout" | undefined;
  if (cacheUsable) {
    status = cached.status;
    info = cachedInfo;
  } else {
    const probe = await probeDeskrpgPluginWithInfo({
      fetchImpl: transportFetch,
      baseUrl: resource.baseUrl,
      token: ownerToken,
    });
    status = probe.capability.status;
    info = probe.info;
    transport = probe.failure;
    await db
      .update(gatewayResources)
      .set({ ...buildPluginCacheUpdate(probe.capability), ...buildPluginInfoCacheUpdate(info) })
      .where(eq(gatewayResources.id, resource.id));
  }

  if (status !== "plugin_ready") {
    const code = status === "unknown" ? "plugin_unknown" : status;
    return {
      ok: false,
      status,
      code,
      reason: `deskrpg plugin probe: ${transport ?? status}`,
      ...(transport ? { transport } : {}),
    };
  }

  const verdict = meetsAutomationContract(info);
  if (!verdict.ok) {
    const missing = verdict.missing ? ` (missing: ${verdict.missing.join(", ")})` : "";
    return {
      ok: false,
      status,
      code: "plugin_upgrade_required",
      reason: `${verdict.reason}: plugin >= ${verdict.minVersion} required${missing}`,
      verdict,
    };
  }
  // If verdict.ok, info isn't null (`no_info` would have caught it first).
  return { ok: true, status, info: info as PluginInfo };
}

/** Minimum gap between forced re-probes of one gateway — an old gateway is not probed on every request. */
export const FORCED_REPROBE_MIN_MS = 30 * 1000;

const lastForcedReprobe = new Map<string, number>();

/**
 * Re-probes the plugin **bypassing the 1-hour cache** and stores the result, for a caller that
 * is about to answer 428 because the cached info lacks a capability. A gateway upgraded after
 * its last probe would otherwise stay "old version" for up to an hour. Throttled per gateway
 * (`FORCED_REPROBE_MIN_MS`, in memory). Returns the fresh info, or null when throttled, not
 * `plugin_ready`, or unreachable.
 */
export async function forceReprobePluginInfo(
  resource: GatewayResourceRow,
  ownerToken: string,
  now = Date.now(),
): Promise<PluginInfo | null> {
  const last = lastForcedReprobe.get(resource.id);
  if (last !== undefined && now - last < FORCED_REPROBE_MIN_MS) return null;
  lastForcedReprobe.set(resource.id, now);
  const probe = await probeDeskrpgPluginWithInfo({
    fetchImpl: transportFetch,
    baseUrl: resource.baseUrl,
    token: ownerToken,
  });
  await db
    .update(gatewayResources)
    .set({ ...buildPluginCacheUpdate(probe.capability), ...buildPluginInfoCacheUpdate(probe.info) })
    .where(eq(gatewayResources.id, resource.id));
  return probe.capability.status === "plugin_ready" ? probe.info : null;
}
