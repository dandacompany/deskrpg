import { HOST_BOOTSTRAP, HOST_HELPER, HOST_INSTALLER, hostLaunch } from "./host-helper";
import {
  packageManagerFor,
  parseSystemPackages,
  type PackageManager,
  type SystemPackage,
} from "./system-packages";
import type { WorkerPropagation } from "../deskrpg-plugin-types";
import type {
  HostExecutor,
  PreparedHost,
  SetupCandidate,
  SetupInspection,
  SetupModelState,
  SetupProvisionRequest,
} from "./types";

export const HOST_ERROR_CODES = new Set([
  "ssh_unknown_host",
  "ssh_host_key_failed",
  "ssh_connection_failed",
  // Key rejected. If not in this list, it gets flattened into host_operation_failed below and the screen can't guide
  // public key registration.
  "ssh_auth_failed",
  "command_timeout",
  "output_limit",
  "host_busy",
  "invalid_candidate",
  "candidate_changed",
  "hermes_not_found",
  "host_operation_failed",
  "setup_cancelled",
  "unsafe_host_path",
  "invalid_host_config",
  "managed_service_required",
  "service_identity_ambiguous",
  "service_identity_mismatch",
  "listener_owner_required",
  "external_secret_provider",
  "api_key_invalid",
  "multiplex_override_present",
  "multiplex_conflict",
  "port_conflict",
  "listener_ownership_unverified",
  "plugin_identity_ambiguous",
  "plugin_install_failed",
  "plugin_update_failed",
  "plugin_security_review_required",
  "plugin_source_unavailable",
  "hermes_version_unsupported",
  "service_install_failed",
  "windows_scheduled_task_missing",
  "timezone_invalid",
  "timezone_write_failed",
  "worker_propagation_write_failed",
  "port_write_failed",
  "gateway_restart_failed",
  "gateway_verification_failed",
  "profile_verification_failed",
  "invalid_host_operation",
  "profile_name_invalid",
  "profile_exists",
  "profile_create_failed",
  "profile_key_failed",
  "profile_provision_forbidden",
  "hermes_already_installed",
  "hermes_install_failed",
  "curl_missing",
  "system_packages_missing",
  "git_missing",
  "python_bootstrap_failed",
  "hermes_installer_unavailable",
]);
/** Holds only non-failure notices. Never appears on the error path. */
const HOST_WARNING_CODES = new Set(["profile_not_served", "model_provider_required"]);
const DIGEST = /^[a-f0-9]{64}$/;
/** Port range the wizard may suggest. If the host reports a value outside it, the suggestion itself is dropped. */
const SUGGEST_MIN = 8642;
const SUGGEST_MAX = 8699;
/**
 * Only `port_conflict` carries one alternative port. The code stays the same and just one number is added —
 * without a suggestion `suggestedPort` is undefined and the screen shows only the error as it does now.
 */
/**
 * Required system packages for install are missing — carries only the code and package manager (the screen builds the
 * command string).
 */
export class SetupPackagesMissingError extends Error {
  readonly packages: SystemPackage[];
  readonly manager: PackageManager | null;
  constructor(packages: SystemPackage[], manager: PackageManager | null) {
    super("system_packages_missing");
    this.packages = packages;
    this.manager = manager;
  }
}
export class SetupPortConflictError extends Error {
  readonly suggestedPort?: number;
  constructor(suggestedPort?: number) {
    // Keep the name as Error — existing paths that compare error strings as codes must not change.
    super("port_conflict");
    if (suggestedPort !== undefined) this.suggestedPort = suggestedPort;
  }
}
function suggestedPort(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= SUGGEST_MIN &&
    value <= SUGGEST_MAX
    ? value
    : undefined;
}
/**
 * Install progress milestones. Whatever the host reports, values outside this list are dropped —
 * eliminating any path where line content poses as a code and lands on the job.
 */
export const INSTALL_MILESTONES = ["deps", "clone", "venv", "node_modules", "skills", "done"];
const WARNING_CODES = new Set([
  ...HOST_ERROR_CODES,
  "gateway_unreachable",
  "api_key_missing",
  "plugin_unauthorized",
  "plugin_pending_restart",
  "plugin_disabled",
  "plugin_absent",
  "gateway_identity_unverified",
  "hermes_version_unknown",
]);
const STEP_CODES = new Set([
  "installing_service",
  "installing_plugin",
  "enabling_plugin",
  "updating_plugin",
  "configuring_api",
  "setting_timezone",
  "setting_worker_propagation",
  "restarting_gateway",
  "verifying_gateway",
]);
const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const RESERVED_PROFILE_NAMES = new Set(["hermes", "test", "tmp", "root", "sudo", "default"]);
const ID = /^[a-f0-9]{64}$/;
type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("host_operation_failed");
  return value as RecordValue;
}
function string(value: unknown, max = 256): string {
  if (typeof value !== "string" || value.length > max || /[\r\n\0]/.test(value))
    throw new Error("host_operation_failed");
  return value;
}
const GATEWAY_STATES = new Set(["running", "stopped", "profile_gateways"]);
/** Profile name list from the helper — malformed values are dropped (these are put on screen as-is). */
function profileNames(value: unknown[]): string[] {
  return value
    .filter((n): n is string => typeof n === "string" && PROFILE_NAME.test(n))
    .slice(0, 256);
}
function publicCandidate(value: unknown): SetupCandidate {
  const item = record(value);
  const id = string(item.id);
  if (
    !ID.test(id) ||
    !Number.isInteger(item.port) ||
    Number(item.port) < 1024 ||
    Number(item.port) > 65535
  )
    throw new Error("host_operation_failed");
  for (const key of ["pluginInstalled", "pluginEnabled", "hasToken"])
    if (typeof item[key] !== "boolean") throw new Error("host_operation_failed");
  // Explicit allowlist projection: never forward helper records wholesale to HTTP callers.
  return {
    id,
    label: string(item.label),
    version: string(item.version),
    service: string(item.service),
    port: Number(item.port),
    pluginInstalled: item.pluginInstalled as boolean,
    pluginEnabled: item.pluginEnabled as boolean,
    // An unreadable version reaches the UI as null, never as a guess.
    pluginVersion: typeof item.pluginVersion === "string" ? string(item.pluginVersion, 64) : null,
    timezone: typeof item.timezone === "string" ? string(item.timezone, 64) : null,
    hasToken: item.hasToken as boolean,
    ...(GATEWAY_STATES.has(item.gatewayState as string)
      ? { gatewayState: item.gatewayState as SetupCandidate["gatewayState"] }
      : {}),
    ...(Array.isArray(item.profiles) ? { profiles: profileNames(item.profiles) } : {}),
    ...(Array.isArray(item.profileGateways)
      ? { profileGateways: profileNames(item.profileGateways) }
      : {}),
    ...(typeof item.warning === "string" && WARNING_CODES.has(item.warning)
      ? { warning: item.warning }
      : {}),
    ...(isPropagation(item.workerPropagation) ? { workerPropagation: item.workerPropagation } : {}),
    ...(typeof item.workerLinked === "boolean" ? { workerLinked: item.workerLinked } : {}),
  };
}
function isPropagation(value: unknown): value is WorkerPropagation {
  return value === "enabled" || value === "disabled";
}
function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("setup_cancelled");
}
async function invoke(
  execute: HostExecutor,
  action: string,
  candidateId?: string,
  signal?: AbortSignal,
  option?: string,
  /** The SSH target is always Linux — `process.platform` is the default only for local runs. */
  platform: string = process.platform,
): Promise<RecordValue> {
  checkAbort(signal);
  if (candidateId !== undefined && !ID.test(candidateId)) throw new Error("invalid_candidate");
  // The helper re-validates `option`; it is JSON-encoded into the script, never shell-interpolated.
  if (option !== undefined) {
    if (action === "set-timezone") {
      if (option.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-.]+)*$/.test(option))
        throw new Error("timezone_invalid");
    } else if (action === "set-worker-propagation") {
      if (option !== "true" && option !== "false") throw new Error("setup_invalid_request");
    } else if (action === "set-port") {
      // Accept numeric strings only. The host checks the range again — cutting here first prevents the host call
      // entirely.
      const port = Number(option);
      if (!/^[0-9]{4,5}$/.test(option) || !Number.isInteger(port) || port < 1024 || port > 65535)
        throw new Error("setup_invalid_request");
    } else if (option.length > 1024 || /[\r\n\0]/.test(option))
      throw new Error("setup_invalid_request");
  }
  const timeout =
    action === "install" || action === "install-service"
      ? 170
      : // The helper waits up to 300s for service stop limit + startup slack (RESTART_MAX). If the outside
        // cuts off first, the cause turns into command_timeout and the helper's gateway_restart_failed verdict is lost.
        action === "restart"
        ? 330
        : action === "verify"
          ? 110
          : // The host waits up to 45s for the CLI — if the outer cap is tighter, the verdict is always timeout.
            action === "check-model"
            ? 60
            : 45;
  try {
    // No python at all means no Hermes — discovery gets an empty list (-> install offer), everything else
    // hermes_not_found.
    const none = action === "discover" ? '{"candidates": []}' : '{"error": "hermes_not_found"}';
    const launch = hostLaunch(platform, "run", HOST_BOOTSTRAP, none);
    const result = await execute(launch.command, launch.args, {
      input: JSON.stringify({
        action,
        timeout,
        script:
          HOST_HELPER +
          "\nentry(" +
          JSON.stringify(action) +
          ", " +
          (candidateId ? JSON.stringify(candidateId) : "None") +
          ", " +
          (option === undefined ? "None" : JSON.stringify(option)) +
          ")\n",
      }),
      timeoutMs: (timeout + 5) * 1000,
      signal,
      env: launch.env,
    });
    checkAbort(signal);
    if (result.code !== 0 || result.stdout.length > 262144)
      throw new Error("host_operation_failed");
    const body = record(JSON.parse(result.stdout));
    if ("error" in body) {
      const code =
        typeof body.error === "string" && HOST_ERROR_CODES.has(body.error)
          ? body.error
          : "host_operation_failed";
      if (code === "port_conflict")
        throw new SetupPortConflictError(suggestedPort(body.suggestedPort));
      throw new Error(code);
    }
    return body;
  } catch (error) {
    if (signal?.aborted) throw new Error("setup_cancelled");
    if (
      error instanceof Error &&
      ["timezone_invalid", "setup_invalid_request", "profile_name_invalid"].includes(error.message)
    )
      throw error;
    if (error instanceof Error && HOST_ERROR_CODES.has(error.message)) throw error;
    // SSH/execution layers may include stderr in an exception. Never propagate it.
    throw new Error("host_operation_failed");
  }
}
/**
 * Local Hermes install. It does not assume the caller (service.ts) has already finished the gate check;
 * this function is responsible only for there being no install and for the result fingerprint.
 * Install output is kept nowhere.
 */
export async function installHermesHost(
  execute: HostExecutor,
  signal?: AbortSignal,
  /** The SSH target is always Linux — `process.platform` is the default only for local runs. */
  platform: string = process.platform,
): Promise<{ installerDigest: string; milestones: string[] }> {
  checkAbort(signal);
  try {
    const launch = hostLaunch(platform, "install", HOST_INSTALLER);
    const result = await execute(launch.command, launch.args, {
      timeoutMs: 600_000,
      signal,
      env: launch.env,
    });
    checkAbort(signal);
    if (result.code !== 0 || result.stdout.length > 65536) throw new Error("hermes_install_failed");
    const body = record(JSON.parse(result.stdout));
    if (body.error === "system_packages_missing")
      throw new SetupPackagesMissingError(
        parseSystemPackages(body.packages),
        packageManagerFor(body.distro),
      );
    if ("error" in body)
      throw new Error(
        typeof body.error === "string" && HOST_ERROR_CODES.has(body.error)
          ? body.error
          : "host_operation_failed",
      );
    const digest = string(body.installerDigest, 64);
    if (!DIGEST.test(digest)) throw new Error("hermes_install_failed");
    // Keep observed order but drop out-of-list values and duplicates. Raw install output can never land here.
    const observed = Array.isArray(body.milestones) ? body.milestones : [];
    const milestones = [
      ...new Set(
        observed.filter(
          (value): value is string =>
            typeof value === "string" && INSTALL_MILESTONES.includes(value),
        ),
      ),
    ].slice(0, INSTALL_MILESTONES.length);
    return { installerDigest: digest, milestones };
  } catch (error) {
    if (signal?.aborted) throw new Error("setup_cancelled");
    if (error instanceof Error && HOST_ERROR_CODES.has(error.message)) throw error;
    // Install logs/stderr may be carried in the exception. Never pass them through as-is.
    throw new Error("hermes_install_failed");
  }
}
/**
 * Model credential check. **Never throws** — if it can't decide, it's `unknown`,
 * and the caller does not abort setup based on this result.
 */
export async function checkModelHost(
  execute: HostExecutor,
  candidateId: string,
  signal?: AbortSignal,
  /** The SSH target is always Linux — `process.platform` is the default only for local runs. */
  platform: string = process.platform,
): Promise<SetupModelState> {
  try {
    const body = await invoke(execute, "check-model", candidateId, signal, undefined, platform);
    return body.model === "ready" || body.model === "missing" ? body.model : "unknown";
  } catch {
    return "unknown";
  }
}
export async function discoverHost(
  execute: HostExecutor,
  /** The SSH target is always Linux — `process.platform` is the default only for local runs. */
  platform: string = process.platform,
): Promise<SetupCandidate[]> {
  const body = await invoke(execute, "discover", undefined, undefined, undefined, platform);
  if (!Array.isArray(body.candidates) || body.candidates.length > 256)
    throw new Error("host_operation_failed");
  return body.candidates.map(publicCandidate);
}
function inspection(body: RecordValue): SetupInspection {
  if (
    !["plugin_ready", "plugin_absent", "plugin_unauthorized", "unknown"].includes(
      String(body.pluginStatus),
    ) ||
    !Array.isArray(body.changes)
  )
    throw new Error("host_operation_failed");
  const profiles = Array.isArray(body.profiles)
    ? body.profiles.map((value) => {
        const profile = record(value);
        const name = string(profile.name, 64);
        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name) || typeof profile.hasToken !== "boolean")
          throw new Error("host_operation_failed");
        if (profile.canProvision !== undefined && typeof profile.canProvision !== "boolean")
          throw new Error("host_operation_failed");
        return {
          name,
          hasToken: profile.hasToken,
          ...(profile.canProvision === true ? { canProvision: true } : {}),
        };
      })
    : [];
  return {
    candidate: publicCandidate(body.candidate),
    pluginStatus: body.pluginStatus as SetupInspection["pluginStatus"],
    changes: body.changes.filter(
      (value): value is string => typeof value === "string" && STEP_CODES.has(value),
    ),
    profiles,
  };
}
/**
 * Turns the worker propagation operator setting on or off (one root config key, verified by read-back).
 * The returned value is the **actual state** — even if you write off, it is `enabled` if an env var in the root .env turned it on. Does not restart the gateway.
 */
export async function setWorkerPropagationHost(
  execute: HostExecutor,
  candidateId: string,
  enabled: boolean,
  /** The SSH target is always Linux — `process.platform` is the default only for local runs. */
  platform: string = process.platform,
): Promise<WorkerPropagation> {
  const body = await invoke(
    execute,
    "set-worker-propagation",
    candidateId,
    undefined,
    enabled ? "true" : "false",
    platform,
  );
  if (!isPropagation(body.propagation)) throw new Error("host_operation_failed");
  return body.propagation;
}
export async function inspectHost(
  execute: HostExecutor,
  candidateId: string,
  /** The SSH target is always Linux — `process.platform` is the default only for local runs. */
  platform: string = process.platform,
): Promise<SetupInspection> {
  return inspection(await invoke(execute, "inspect", candidateId, undefined, undefined, platform));
}
function assertProvisionRequest(provision: SetupProvisionRequest | undefined) {
  const created = provision?.createProfile;
  if (created !== undefined) {
    if (!PROFILE_NAME.test(created.name) || RESERVED_PROFILE_NAMES.has(created.name))
      throw new Error("profile_name_invalid");
    if (
      created.description !== undefined &&
      (created.description.length > 200 || /[\r\n\0]/.test(created.description))
    )
      throw new Error("profile_name_invalid");
  }
  const keys = [...new Set(provision?.provisionKeys ?? [])];
  if (keys.length > 10) throw new Error("setup_invalid_request");
  if (keys.some((name) => !PROFILE_NAME.test(name) || RESERVED_PROFILE_NAMES.has(name)))
    throw new Error("profile_name_invalid");
  return keys;
}
export async function prepareHost(
  execute: HostExecutor,
  initialCandidateId: string,
  onStep: (step: string) => void,
  signal?: AbortSignal,
  timezone?: string,
  provision?: SetupProvisionRequest,
  /** Steps already succeeded in a resume. Neither undone nor redone. `inspecting` always runs again. */
  skipStep?: (step: string) => boolean,
  /** Present only when the screen explicitly accepted the suggestion. Writes only to the candidate home's `.env`. */
  setPort?: number,
  /** The SSH target is always Linux — `process.platform` is the default only for local runs. */
  platform: string = process.platform,
  /**
   * Aligns worker propagation to this value (wizard checkbox / carry-over on update). If undefined, leaves it
   * untouched. Does nothing if it's already in that state.
   */
  workerPropagation?: boolean,
): Promise<PreparedHost> {
  const skip = (step: string) => skipStep?.(step) === true;
  // Registering the service creates a unit definition and changes the candidate id (a hash of the definition). Later
  // steps must use the new id.
  let candidateId = initialCandidateId;
  const stage = async (step: string, action: string, option?: string) => {
    checkAbort(signal);
    onStep(step);
    checkAbort(signal);
    return invoke(execute, action, candidateId, signal, option, platform);
  };
  const requestedKeys = assertProvisionRequest(provision);
  const warnings: string[] = [];
  // Move the port first so the following inspect sees a free port and proceeds without conflict.
  // The actual apply is done by `restarting_gateway` below — here only `.env` is edited.
  if (setPort !== undefined && !skip("setting_port"))
    await stage("setting_port", "set-port", String(setPort));
  const state = inspection(await stage("inspecting", "inspect"));
  // New profiles must be created before plugin/API work so that one restart serves them.
  const provisionKeys = [...requestedKeys];
  if (provision?.createProfile && skip("creating_profile")) {
    // Already-created profile. Creating it again dies with `profile_exists` — add it only to the key issuance targets.
    if (!provisionKeys.includes(provision.createProfile.name))
      provisionKeys.push(provision.createProfile.name);
  } else if (provision?.createProfile) {
    const created = record(
      await stage(
        "creating_profile",
        "create-profile",
        JSON.stringify({
          name: provision.createProfile.name,
          ...(provision.createProfile.description
            ? { description: provision.createProfile.description }
            : {}),
        }),
      ),
    );
    const notServed =
      typeof created.warning === "string" && HOST_WARNING_CODES.has(created.warning);
    if (notServed) warnings.push(created.warning as string);
    // Outside the allowlist it isn't served, so even an issued key couldn't be verified.
    if (!notServed && !provisionKeys.includes(provision.createProfile.name))
      provisionKeys.push(provision.createProfile.name);
  }
  const provisioned: string[] = [];
  if (provisionKeys.length && !skip("provisioning_keys")) {
    // Multiple profiles are handled in one step — profile names are not left in the progress record.
    checkAbort(signal);
    onStep("provisioning_keys");
    for (const name of provisionKeys) {
      checkAbort(signal);
      const result = record(
        await invoke(execute, "provision-key", candidateId, signal, name, platform),
      );
      if (result.provisioned === true) provisioned.push(name);
    }
  }
  // A unit must exist before anything tries to restart the gateway through it.
  if (state.changes.includes("installing_service") && !skip("installing_service")) {
    const installed = record(await stage("installing_service", "install-service"));
    if (typeof installed.candidateId === "string" && installed.candidateId.length === 64)
      candidateId = installed.candidateId;
  }
  const pluginStep = state.changes.includes("updating_plugin")
    ? "updating_plugin"
    : !state.candidate.pluginInstalled || !state.candidate.pluginEnabled
      ? state.candidate.pluginInstalled
        ? "enabling_plugin"
        : "installing_plugin"
      : null;
  if (pluginStep && !skip(pluginStep)) await stage(pluginStep, "install");
  const configuring =
    (state.pluginStatus !== "plugin_ready" || state.changes.includes("configuring_api")) &&
    !skip("configuring_api");
  // Never overwrite a timezone the operator already set.
  const settingTimezone =
    Boolean(timezone) && !state.candidate.timezone && !skip("setting_timezone");
  if (configuring) await stage("configuring_api", "configure");
  if (settingTimezone) await stage("setting_timezone", "set-timezone", timezone);
  let propagation = state.candidate.workerPropagation;
  const settingPropagation =
    workerPropagation !== undefined &&
    propagation !== (workerPropagation ? "enabled" : "disabled") &&
    !skip("setting_worker_propagation");
  if (settingPropagation) {
    const set = await stage(
      "setting_worker_propagation",
      "set-worker-propagation",
      workerPropagation ? "true" : "false",
    );
    propagation = isPropagation(set.propagation) ? set.propagation : undefined;
  }
  // Whether a restart is needed is **told by the host** (`changes`). Separately inferring "we did X, so it's needed"
  // here diverges from the host's verdict. It used to restart only when configure/timezone ran, so
  // in the common case where only the plugin lagged (above the minimum version but below the pin), new code was
  // only installed and old code kept being served. Even if several conditions are true, it restarts once.
  // Worker propagation's contract is that the plugin reads the setting on every call, but even with versions that
  // read it at load mixed in, it piggybacks on the restart already happening so the new value is served
  // (one restart even if several conditions are true).
  const restarting =
    configuring ||
    settingTimezone ||
    settingPropagation ||
    state.changes.includes("restarting_gateway");
  if (restarting && !skip("restarting_gateway")) await stage("restarting_gateway", "restart");
  const verified = await stage("verifying_gateway", "verify");
  for (const warning of Array.isArray(verified.warnings) ? verified.warnings : [])
    if (
      typeof warning === "string" &&
      HOST_WARNING_CODES.has(warning) &&
      !warnings.includes(warning)
    )
      warnings.push(warning);
  const body = record(verified.prepared);
  const baseUrl = string(body.baseUrl);
  if (
    !/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl) ||
    Number(new URL(baseUrl).port) !== state.candidate.port
  )
    throw new Error("host_operation_failed");
  const token = string(body.token, 8192);
  if (token.length < 16 || !Array.isArray(body.profiles) || body.profiles.length > 256)
    throw new Error("host_operation_failed");
  const profiles = body.profiles.map((value) => {
    const profile = record(value);
    const name = string(profile.name, 64);
    const profileToken = string(profile.token, 8192);
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name) || profileToken.length < 16)
      throw new Error("profile_verification_failed");
    return { name, token: profileToken };
  });
  // If keys were issued, confirm actual serving with those keys. verify simply drops profiles that fail auth.
  if (provisioned.some((name) => !profiles.some((profile) => profile.name === name)))
    throw new Error("profile_verify_failed");
  return {
    baseUrl,
    token,
    profiles,
    ...(warnings.length ? { warnings } : {}),
    ...(propagation ? { workerPropagation: propagation } : {}),
  };
}

/**
 * Does the user-level systemd service survive logout/reboot (`loginctl` Linger)? Asked only on SSH targets.
 * **Never throws** — if it can't decide (macOS, no loginctl) it's `unknown` and setup doesn't stop.
 * Enabling it usually needs sudo, so DeskRPG doesn't do it — if it's off, it guides the command (2026-09-19 Dante
 * decision).
 */
export async function checkLingerHost(
  execute: HostExecutor,
): Promise<"enabled" | "disabled" | "unknown"> {
  try {
    const who = await execute("id", ["-un"], { timeoutMs: 10_000 });
    const user = who.stdout.trim();
    if (who.code !== 0 || !/^[a-z_][a-z0-9_.-]{0,31}$/.test(user)) return "unknown";
    const res = await execute("loginctl", ["show-user", user, "-p", "Linger", "--value"], {
      timeoutMs: 10_000,
    });
    const value = res.stdout.trim();
    if (res.code !== 0) return "unknown";
    return value === "yes" ? "enabled" : value === "no" ? "disabled" : "unknown";
  } catch {
    return "unknown";
  }
}
