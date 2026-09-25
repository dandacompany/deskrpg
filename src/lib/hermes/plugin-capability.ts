/**
 * Is `deskrpg-hermes-plugin` installed on this gateway.
 *
 * 401 and 404 **must be distinguished**, because what the user must do is the opposite —
 * 401 means "this gateway record's token is not the default key" (replace the key),
 * 404 means "the plugin is not on the gateway machine" (install it). Lumping them together
 * makes neither fixable.
 *
 * Unknown responses fold into `unknown` and **do not enable** features. Optimistically assuming
 * the capability makes the user open the wizard and then fail midway.
 *
 * This file is **imported directly by client components** (`HermesProfileList.tsx`,
 * final review I-1 — `resolvePluginStatusFromCache` is used in the browser). So
 * `@/db` (and the Node-only modules it pulls in, like `pg`/`better-sqlite3`) must not be imported
 * in this file — we actually did so once and the browser bundle broke (`Module
 * not found: Can't resolve 'dns'/'fs'/'net'/'tls'`). That is why the DB-touching
 * `buildPluginCacheUpdate` was pulled out into `plugin-cache-update.ts` (server-only).
 */

import { parseWorkerPluginReport } from "./worker-plugin";
import type { PluginInfo } from "./deskrpg-plugin-types";
import { PLUGIN_VERSION } from "./setup/pin";

export type PluginStatus = "plugin_ready" | "plugin_unauthorized" | "plugin_absent" | "unknown";

export type PluginCapability = { status: PluginStatus; version: string | null };

/**
 * Verdict + automation contract block. `info` is kept separate instead of added to `PluginCapability` because the
 * gateway test route emits the `probeDeskrpgPlugin` result **verbatim as the response body** —
 * adding a field would change that route's JSON contract. `info` is filled only for a 200 verdict.
 */
export type PluginProbe = {
  capability: PluginCapability;
  info: PluginInfo | null;
  /** If `unknown` was a transport-layer failure, which kind. Absent when an HTTP response was received. */
  failure?: "unreachable" | "timeout";
};

const PLUGIN_NAME = "deskrpg";
const DEFAULT_TIMEOUT_MS = 10000;

export function classifyPluginProbe(input: { status: number; body: unknown }): PluginCapability {
  if (input.status === 401 || input.status === 403) {
    return { status: "plugin_unauthorized", version: null };
  }
  if (input.status === 404) return { status: "plugin_absent", version: null };
  if (input.status !== 200) return { status: "unknown", version: null };

  const body = input.body;
  if (typeof body !== "object" || body === null) return { status: "unknown", version: null };
  const record = body as Record<string, unknown>;
  if (record.plugin !== PLUGIN_NAME) return { status: "unknown", version: null };

  const version = typeof record.version === "string" ? record.version : null;
  return { status: "plugin_ready", version };
}

/** Same verdict as `classifyPluginProbe`, plus the contract block. `info` is null unless 200. */
export function classifyPluginProbeWithInfo(input: { status: number; body: unknown }): PluginProbe {
  const capability = classifyPluginProbe(input);
  return {
    capability,
    info: capability.status === "plugin_ready" ? parsePluginInfo(input.body) : null,
  };
}

// ---------------------------------------------------------------------------
// Automation contract (v0.6.0+) — info parsing and gates. All pure functions (they run in the browser too).
// ---------------------------------------------------------------------------

/** Minimum plugin version required by automation (kanban·cron·events). */
export const AUTOMATION_MIN_VERSION = "0.6.0";

/** The three capabilities automation requires. If any is missing, the feature is not enabled. */
export const AUTOMATION_CAPABILITIES = ["kanban", "cron", "events"] as const;

/**
 * Folds the `/deskrpg/info` body into `PluginInfo`. Without `plugin`/`version` it is not our
 * plugin, so null. Pre-0.6.0 bodies lack `capabilities`/`timezone`/`kanban` —
 * that is not treated as failure; they are filled with empty values. The contract verdict is done
 * separately by `meetsAutomationContract` (the parser handles shape only, the gate handles meaning only).
 */
export function parsePluginInfo(body: unknown): PluginInfo | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  if (record.plugin !== PLUGIN_NAME) return null;
  if (typeof record.version !== "string") return null;

  const capabilities = Array.isArray(record.capabilities)
    ? record.capabilities.filter((c): c is string => typeof c === "string")
    : [];
  const kanbanRecord =
    typeof record.kanban === "object" && record.kanban !== null
      ? (record.kanban as Record<string, unknown>)
      : {};

  const workerPlugin = parseWorkerPluginReport(record.worker_plugin);

  return {
    plugin: PLUGIN_NAME,
    version: record.version,
    capabilities,
    timezone: typeof record.timezone === "string" ? record.timezone : null,
    kanban: {
      dispatcher_present: kanbanRecord.dispatcher_present === true,
      attachments: kanbanRecord.attachments === true,
    },
    dashboard_url: httpUrlOrNull(record.dashboard_url),
    // Do not create the key for old plugin bodies — distinguish "field absent" from "verdict failed (null)".
    ...(workerPlugin === undefined ? {} : { worker_plugin: workerPlugin }),
  };
}

/** This value is used as a link (href) — only http(s) passes so schemes like `javascript:` never reach the screen. */
function httpUrlOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Compares only the three numeric parts. A leading `v` and prerelease tails like `-rc.1` are ignored —
 * we publish the plugin versions ourselves, so there is no need to order prereleases, nor a reason to pull
 * a precise semver library into the browser bundle. null if unparseable.
 *
 * Kept separate because string comparison (`"0.10.0" < "0.6.0"` is true) must not be used here.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 | null {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

function parseSemver(value: string): [number, number, number] | null {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

export type AutomationContractVerdict =
  | { ok: true; minVersion: string }
  | {
      ok: false;
      minVersion: string;
      reason: "no_info" | "invalid_version" | "version_below_minimum" | "missing_capability";
      missing?: string[];
    };

/**
 * May automation (kanban·cron·events) be enabled with this plugin.
 *
 * Requires version ≥ 0.6.0 **and** all three capabilities. Checking only one of the two is
 * wrong — even with 0.6.0, kanban can be missing depending on build options, and conversely, even with all
 * capabilities, the event cursor semantics changed in 0.6.0. The rejection reasons are split because
 * the screen must distinguish "upgrade" from "enable events in the plugin settings".
 */
export function meetsAutomationContract(info: PluginInfo | null): AutomationContractVerdict {
  const minVersion = AUTOMATION_MIN_VERSION;
  if (!info) return { ok: false, minVersion, reason: "no_info" };

  const cmp = compareSemver(info.version, minVersion);
  if (cmp === null) return { ok: false, minVersion, reason: "invalid_version" };
  if (cmp < 0) return { ok: false, minVersion, reason: "version_below_minimum" };

  const missing = AUTOMATION_CAPABILITIES.filter((c) => !info.capabilities.includes(c));
  if (missing.length > 0) return { ok: false, minVersion, reason: "missing_capability", missing };

  return { ok: true, minVersion };
}

// ---------------------------------------------------------------------------
// Project view feature gate (batch queries)
// ---------------------------------------------------------------------------

/** Plugin version that added batch queries (`GET /kanban/links`·`/kanban/runs`). For hint text. */
export const KANBAN_VIEWS_MIN_VERSION = "0.11.0";

/**
 * Can batch queries be used on this gateway.
 *
 * For the same reason as swarm, **the version is not checked** — the capability string is the source of truth for
 * availability.
 * Judging by version creates an undiagnosable state like "it's 0.11.0 but 404".
 *
 * Without it the screen degrades rather than dying. The subtree keeps working via per-card detail calls,
 * and only the activity timeline is replaced by a hint — we do not lock all of kanban by raising the global minimum
 * version.
 */
export function supportsKanbanViews(info: PluginInfo | null): boolean {
  return Boolean(info?.capabilities?.includes("kanban_views"));
}

export function kanbanViewsGate(
  info: PluginInfo | null,
): { ok: true } | { ok: false; minVersion: string; reason: string; missing: string[] } {
  if (supportsKanbanViews(info)) return { ok: true };
  return {
    ok: false,
    minVersion: KANBAN_VIEWS_MIN_VERSION,
    reason: info ? "missing_capability" : "no_info",
    missing: ["kanban_views"],
  };
}

// ---------------------------------------------------------------------------
// Swarm feature gate
// ---------------------------------------------------------------------------

/** Plugin version that added swarm. Kept **separate** from `AUTOMATION_MIN_VERSION`. */
export const SWARM_MIN_VERSION = "0.7.0";
/** Plugin version needed for the pre-run approval gate — used only in hint text (the verdict uses capability). */
const INITIAL_STATUS_MIN_VERSION = "0.11.0";

/**
 * Can swarm be used on this gateway.
 *
 * Unlike `meetsAutomationContract`, **the version is not checked.** If the Hermes build lacks
 * `kanban_swarm`, the plugin drops `"swarm"` from capabilities and does not register the routes.
 * So that one capability is the source of truth for availability — judging by version creates an undiagnosable
 * state like "it's 0.7.0 but 404". `minVersion` is used only when the screen builds hint text.
 */
export function supportsSwarm(info: PluginInfo | null): boolean {
  return Boolean(info?.capabilities?.includes("swarm"));
}

/**
 * Can the pre-run approval gate be enabled — does the plugin accept `initial_status` on card creation.
 *
 * For the same reason as swarm, **the version is not checked.** The plugin adds it to capabilities only when
 * the Hermes build's `create_task` accepts that argument. Enabling the gate without it creates cards as `running`,
 * which **run without approval** — so it stays fail-closed.
 */
/**
 * Can all attachments for the whole board be read at once. Without it, the deliverables gallery drops card attachments
 * and shows only artifacts — it does not emulate this with N+1 per-card detail calls. For the same reason as swarm,
 * the version is not checked.
 */
export function supportsBoardAttachmentList(info: PluginInfo | null): boolean {
  return Boolean(info?.capabilities?.includes("kanban_attachment_list"));
}

export function supportsInitialStatus(info: PluginInfo | null): boolean {
  return Boolean(info?.capabilities?.includes("initial_status"));
}

export function initialStatusGate(
  info: PluginInfo | null,
): { ok: true } | { ok: false; minVersion: string; reason: string; missing: string[] } {
  if (supportsInitialStatus(info)) return { ok: true };
  return {
    ok: false,
    minVersion: INITIAL_STATUS_MIN_VERSION,
    reason: info ? "missing_capability" : "no_info",
    missing: ["initial_status"],
  };
}

export function swarmGate(
  info: PluginInfo | null,
): { ok: true } | { ok: false; minVersion: string; reason: string; missing: string[] } {
  if (supportsSwarm(info)) return { ok: true };
  return {
    ok: false,
    minVersion: SWARM_MIN_VERSION,
    reason: info ? "missing_capability" : "no_info",
    missing: ["swarm"],
  };
}

// ---------------------------------------------------------------------------
// Card proposal gate (plugin 0.11.0)
// ---------------------------------------------------------------------------

/** Plugin version that added card proposals. For hint text — the verdict uses the capability. */
export const CARD_PROPOSALS_MIN_VERSION = "0.11.0";

export function supportsCardProposals(info: PluginInfo | null): boolean {
  return Boolean(info?.capabilities?.includes("card_proposals"));
}

/**
 * A proposal can outlive the plugin that raised it (a downgrade, a swapped gateway). Resolving it
 * then must be a 428 the screen can turn into "upgrade the plugin", not the old plugin's bare 404.
 */
export function cardProposalsGate(
  info: PluginInfo | null,
): { ok: true } | { ok: false; minVersion: string; reason: string; missing: string[] } {
  if (supportsCardProposals(info)) return { ok: true };
  return {
    ok: false,
    minVersion: CARD_PROPOSALS_MIN_VERSION,
    reason: info ? "missing_capability" : "no_info",
    missing: ["card_proposals"],
  };
}

// ---------------------------------------------------------------------------
// Staff settings picker·clone gate (plugin 0.9.0)
// ---------------------------------------------------------------------------

/** For hint text. The source of truth for availability is capability — same reason as the swarm gate. */
export const PROFILE_PICKER_MIN_VERSION = "0.9.0";

export function supportsProfilePicker(info: PluginInfo | null): boolean {
  const caps = info?.capabilities ?? [];
  return caps.includes("profile_toolsets") && caps.includes("profile_skills");
}

export function supportsProfileClone(info: PluginInfo | null): boolean {
  return Boolean(info?.capabilities?.includes("profile_clone"));
}

// ---------------------------------------------------------------------------
// Provider auth gate (plugin 0.9.0)
// ---------------------------------------------------------------------------

export function supportsProfileOauth(info: PluginInfo | null): boolean {
  return Boolean(info?.capabilities?.includes("profile_oauth"));
}

/** 0.10.0 — per-tool provider selection·key input. */
export function supportsToolProviders(info: PluginInfo | null): boolean {
  return Boolean(info?.capabilities?.includes("profile_tool_providers"));
}

export function supportsProviderKeys(info: PluginInfo | null): boolean {
  return Boolean(info?.capabilities?.includes("profile_provider_keys"));
}

/** A 404 the plugin returns **with its own code**. Any other 404 means the route does not exist (old plugin). */
const KNOWN_PLUGIN_404_CODES = new Set([
  "profile_not_found",
  "invalid_profile",
  "oauth_session_not_found",
  "provider_not_found",
  // 0.10.0 — the 404 (unknown toolset) the tool provider route returns with its own code.
  "toolset_not_found",
]);

/**
 * The proxy uses this instead of the cached plugin info to detect old versions. The cache can be up to an hour stale
 * (`REPROBE_AFTER_MS`), and a gateway that was just upgraded must not be blocked as "old version".
 */
export function isMissingPluginRoute(res: { status: number; failure: { code: string } }): boolean {
  return res.status === 404 && !KNOWN_PLUGIN_404_CODES.has(res.failure.code);
}

/** Interval for rechecking a cached verdict. The plugin may be installed later, so a permanent cache is wrong. */
const REPROBE_AFTER_MS = 60 * 60 * 1000;

/**
 * Shorter interval while the cached version is below the pinned one. A host upgraded outside the
 * app (`git pull` + restart) keeps reporting the old version — and hiding new capabilities — until
 * the next probe; an install that really is old is then probed at most this often.
 */
const OUTDATED_REPROBE_AFTER_MS = 5 * 60 * 1000;

/** True only when `version` parses and is strictly below the version this app installs. */
function isBehindPinnedPlugin(version: string | null | undefined): boolean {
  if (!version) return false;
  return compareSemver(version, PLUGIN_VERSION) === -1;
}

/**
 * `checkedAt` is an ISO string in SQLite, and in PostgreSQL it is a `timestamp(withTimezone)`
 * column that drizzle reads as a `Date` object — both dialects are accepted. Pass the cached
 * `version` to apply the shorter interval for an install behind the pin.
 */
export function shouldReprobePlugin(input: {
  checkedAt: string | Date | null;
  now: Date;
  version?: string | null;
}): boolean {
  if (!input.checkedAt) return true;
  const at =
    input.checkedAt instanceof Date ? input.checkedAt.getTime() : Date.parse(input.checkedAt);
  if (Number.isNaN(at)) return true;
  const after = isBehindPinnedPlugin(input.version) ? OUTDATED_REPROBE_AFTER_MS : REPROBE_AFTER_MS;
  return input.now.getTime() - at >= after;
}

/**
 * Final review I-1: `shouldReprobePlugin` was only defined and never called, so the Task 4·9
 * outputs (3 cache columns, this function) were all dead — `HermesProfileList` unconditionally re-hit
 * `/test` on every screen entry (2 remote round trips, 10s timeout for the plugin probe alone).
 *
 * This function pins the "use the cache or re-probe" decision as a pure function — if the cache is
 * fresh and has a value, use it as-is; if stale (or absent altogether), say a re-probe is
 * needed. The caller (`HermesProfileList`) only has to decide whether to call `/test`
 * based on this result.
 *
 * With `pluginVersion` behind the pin, a cache younger than the hour keeps its status (the screen
 * is not locked meanwhile) but still asks for a reprobe after the shorter interval.
 */
export function resolvePluginStatusFromCache(input: {
  pluginStatus: string | null;
  pluginCheckedAt: string | Date | null;
  pluginVersion?: string | null;
  now: Date;
}): { status: PluginStatus; needsReprobe: boolean } {
  const stale = shouldReprobePlugin({ checkedAt: input.pluginCheckedAt, now: input.now });
  if (!stale && isPluginStatus(input.pluginStatus)) {
    const needsReprobe = shouldReprobePlugin({
      checkedAt: input.pluginCheckedAt,
      now: input.now,
      version: input.pluginVersion,
    });
    return { status: input.pluginStatus, needsReprobe };
  }
  return { status: "unknown", needsReprobe: true };
}

function isPluginStatus(value: string | null): value is PluginStatus {
  return (
    value === "plugin_ready" ||
    value === "plugin_unauthorized" ||
    value === "plugin_absent" ||
    value === "unknown"
  );
}

type ProbeInput = {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

type ProbeFailure = { failure: "unreachable" | "timeout" };

/**
 * One `GET /deskrpg/info`. Reach failure/abort is `unreachable`, cut off by our timer is `timeout` —
 * the caller only wants the verdict, but what the user must do (retry vs check the address) differs, so the two are
 * split.
 */
async function fetchPluginInfo(
  input: ProbeInput,
): Promise<{ status: number; body: unknown } | ProbeFailure> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const base = input.baseUrl.replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    // Unprefixed path — `/deskrpg/info` is in the default scope, so
    // adding `/p/<name>/` would require the profile key and yield 401.
    const res = await fetchImpl(`${base}/deskrpg/info`, {
      method: "GET",
      headers: { authorization: `Bearer ${input.token}` },
      signal: controller.signal,
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } catch {
    return { failure: controller.signal.aborted ? "timeout" : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeDeskrpgPlugin(input: ProbeInput): Promise<PluginCapability> {
  const raw = await fetchPluginInfo(input);
  return "failure" in raw ? { status: "unknown", version: null } : classifyPluginProbe(raw);
}

/** `probeDeskrpgPlugin` + contract block. Used by whoever fills the automation cache (`plugin_info_json`). */
export async function probeDeskrpgPluginWithInfo(input: ProbeInput): Promise<PluginProbe> {
  const raw = await fetchPluginInfo(input);
  return "failure" in raw
    ? { capability: { status: "unknown", version: null }, info: null, failure: raw.failure }
    : classifyPluginProbeWithInfo(raw);
}

/** The contract that enforces the completion policy for new tasks in core. */
export function supportsReviewPolicy(info: PluginInfo | null): boolean {
  return info?.capabilities.includes("kanban_review_policy_v1") ?? false;
}
