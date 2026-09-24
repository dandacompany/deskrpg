/**
 * Assembles the payload for the `gatewayResources.pluginStatus/pluginVersion/pluginCheckedAt` cache.
 *
 * Split out of `plugin-capability.ts` — that file is imported directly by `HermesProfileList.tsx` (a client
 * component) to use `resolvePluginStatusFromCache`, so it must not contain `@/db`
 * (or the `pg`/`better-sqlite3` it pulls in). This function is server-only logic that builds values to write
 * to the DB, so it stays here — its only caller is
 * `src/app/api/gateways/[id]/test/route.ts` (a route handler).
 */

import { nowForDb } from "@/db";

import type { PluginInfo } from "./deskrpg-plugin-types";
import { parsePluginInfo, type PluginCapability } from "./plugin-capability";

/**
 * Builds the payload the gateway test route passes to `db.update(gatewayResources).set(...)`.
 * It obtains the timestamp **itself** via `nowForDb()` — leaving it to the caller lets the call site
 * pass a dialect-agnostic value like `new Date().toISOString()` instead, and on PostgreSQL
 * a string gets wrongly bound to a `timestamp(withTimezone)` column that expects a `Date`
 * (verdict D incident). This function's contract is to remove the very slot where a wrong type could be passed.
 */
export function buildPluginCacheUpdate(plugin: PluginCapability) {
  const now = nowForDb();
  return {
    pluginStatus: plugin.status,
    pluginVersion: plugin.version,
    pluginCheckedAt: now,
    updatedAt: now,
  };
}

/**
 * Payload that puts the automation contract block (capabilities/timezone/kanban from `/deskrpg/info`)
 * into `gateway_resources.plugin_info_json` (a text column).
 *
 * Why it is kept separate from `buildPluginCacheUpdate`: that column is being added by a parallel task
 * and is not yet in this worktree's drizzle schema. Emitting both payloads as one object
 * would make `.set()` receive a key with no column and fail type checking. Once the column exists,
 * the route can merge them as `{ ...buildPluginCacheUpdate(p), ...buildPluginInfoCacheUpdate(p) }`
 * — this function only emits a string (or null).
 */
export function buildPluginInfoCacheUpdate(info: PluginInfo | null): {
  pluginInfoJson: string | null;
} {
  return { pluginInfoJson: info ? JSON.stringify(info) : null };
}

/**
 * Turns a `plugin_info_json` column value back into `PluginInfo`. Broken JSON or an unfamiliar shape yields null —
 * if the cache can't be read, just re-probe; it's no reason to throw and block the screen.
 */
export function restorePluginInfo(json: string | null | undefined): PluginInfo | null {
  if (!json) return null;
  try {
    return parsePluginInfo(JSON.parse(json));
  } catch {
    return null;
  }
}
