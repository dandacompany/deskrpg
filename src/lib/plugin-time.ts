/**
 * The single place that reads timestamps sent by the plugin.
 *
 * If the screen, sorting, and metrics each called `Date.parse` on their own, the same
 * bug would come back in multiple places every time the contract changed. Let fixing it
 * here be enough.
 */

import type { PluginTime } from "@/lib/hermes/deskrpg-plugin-types";

/**
 * A card/run timestamp, in ms. `null` if it can't be read.
 *
 * **The plugin sends epoch seconds (an integer)** (plugin `docs/contracts.md`: "kanban's
 * `created_at`, `started_at`, `ts`, etc. are epoch seconds (integer)"). But our type had
 * it written as `string`, and the screen called `Date.parse` — `Date.parse(1758412800)`
 * is **NaN**, so elapsed time silently disappears. The fake plugin server
 * (`fake-plugin-server.ts`) sends ISO strings, so tests stayed green the whole time, and
 * only the real gateway produced empty values.
 *
 * Accepts both. A number (or a numeric-only string) is read as epoch seconds; anything
 * else as ISO. Standardizing on one side would be a contract change, so that's not this
 * function's call to make.
 */
export function taskTimeMs(value: PluginTime | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? epochSecondsToMs(value) : null;
  }
  if (/^\d+$/.test(value.trim())) return epochSecondsToMs(Number(value.trim()));
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Epoch seconds to ms. A value that already looks like ms (13+ digits) is left as-is —
 * the contract has wavered on which unit is used before, so this accepts both rather
 * than drawing a time that's off by a factor of 1000.
 */
function epochSecondsToMs(value: number): number {
  return Math.abs(value) >= 1e11 ? value : value * 1000;
}
