/**
 * The verdict on "is the plugin installed on this gateway the version the app requires", before it becomes screen text.
 *
 * The app installs the plugin by pin (`PLUGIN_VERSION` in `setup/pin.ts`), yet **the currently installed
 * version was shown nowhere on screen** (measured 2026-09-21: even the diagnostics screen only said
 * `plugin_ready`, so seeing the version meant reading the `automation/status` API directly).
 *
 * Pure function — it ships in the client bundle, so it does not import `node:*`·`@/db`.
 */
import { compareSemver } from "@/lib/hermes/plugin-capability";
import { PLUGIN_VERSION } from "@/lib/hermes/setup/pin";

export type PluginVersionState = "unknown" | "current" | "outdated" | "ahead";

export type PluginVersionView = {
  state: PluginVersionState;
  /** The installed copy per the cache. null if unknown — the screen draws "확인되지 않음" (unconfirmed). */
  installed: string | null;
  /** The version this app installs. */
  pinned: string;
};

export function describePluginVersion(input: {
  installed: string | null | undefined;
  pluginStatus: string | null | undefined;
}): PluginVersionView {
  const installed = (input.installed ?? "").trim() || null;
  const pinned = PLUGIN_VERSION;

  // The version is not verdict material when the plugin is not ready — telling a gateway blocked by
  // 404/401 that it is "behind" makes the user look in the wrong place to fix it.
  if (input.pluginStatus !== "plugin_ready" || !installed) {
    return { state: "unknown", installed, pinned };
  }

  const order = compareSemver(installed, pinned);
  if (order === null) return { state: "unknown", installed, pinned };
  if (order < 0) return { state: "outdated", installed, pinned };
  if (order > 0) return { state: "ahead", installed, pinned };
  return { state: "current", installed, pinned };
}
