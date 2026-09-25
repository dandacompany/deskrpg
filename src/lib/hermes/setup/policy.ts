import type { SetupModelState } from "./types";

const OFF = new Set(["0", "false", "no", "off"]);
/** Whether the operator turned the switch off. Empty means on — these switches exist for refusing. */
function switchedOff(value: string | undefined) {
  return OFF.has((value ?? "").trim().toLowerCase());
}

/**
 * Whether the setup wizard that runs commands on the host (local/SSH) may be opened.
 *
 * 2026-09-19 Dante's decision: `system_admin` opens it without an env var. Host setup runs commands with the server
 * process's privileges, so it's still admin-only — the gateway record owner is not "the owner of this machine".
 * Operators can turn it off with `DESKRPG_HOST_SETUP_ENABLED=0` (previously it had to be turned on with `1`).
 */
export function hostSetupAllowed(env: Record<string, string | undefined>, role?: string) {
  return role === "system_admin" && !switchedOff(env.DESKRPG_HOST_SETUP_ENABLED);
}

/**
 * Hermes install — the only path by which DeskRPG runs an external install script on the host.
 * Besides the host gate it can be turned off separately with `DESKRPG_HERMES_INSTALL_ENABLED=0`. Opened for local
 * and SSH (SSH only reaches hosts the admin registered and whose fingerprint was confirmed).
 */
export function hermesInstallAllowed(
  env: Record<string, string | undefined>,
  role?: string,
  mode?: string,
) {
  return (
    hostSetupAllowed(env, role) &&
    !switchedOff(env.DESKRPG_HERMES_INSTALL_ENABLED) &&
    (mode === "local" || mode === "ssh")
  );
}

export function sameOriginMutation(
  origin: string | null,
  host: string | null,
  site?: string | null,
) {
  if (!origin || !host || site === "cross-site") return false;
  try {
    const parsed = new URL(origin);
    return (
      ["http:", "https:"].includes(parsed.protocol) &&
      parsed.host === host &&
      parsed.origin === origin
    );
  } catch {
    return false;
  }
}

export function validateGatewayUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) throw new Error("setup_invalid_request");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("setup_invalid_request");
  }
  const host = url.hostname
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/\.+$/, "");
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    host.startsWith("169.254.") ||
    /^fe[89ab][0-9a-f]:/.test(host) ||
    host.startsWith("::ffff:") ||
    host === "metadata.google.internal" ||
    host.endsWith(".deskrpg-ssh.invalid")
  )
    throw new Error("setup_invalid_request");
  return url.toString().replace(/\/+$/, "");
}

const SAFE_CODES = new Set([
  "setup_forbidden",
  "setup_bad_origin",
  "setup_busy",
  "setup_not_found",
  "setup_invalid_request",
  "setup_failed",
  "setup_cancelled",
  "setup_interrupted",
  "gateway_unreachable",
  "gateway_not_hermes",
  "gateway_unauthorized",
  "plugin_unauthorized",
  "plugin_unknown",
  "profile_import_failed",
  "hermes_not_found",
  "hermes_version_unsupported",
  "plugin_install_failed",
  "plugin_update_failed",
  // Update-only — the address is reachable but commands can't run on that host (e.g. a host address seen from a
  // container).
  "plugin_update_unsupported_host",
  "plugin_update_candidate_not_found",
  "plugin_verify_failed",
  "service_install_failed",
  "windows_scheduled_task_missing",
  "timezone_invalid",
  "timezone_write_failed",
  "worker_propagation_write_failed",
  "port_write_failed",
  "plugin_security_review_required",
  "plugin_source_unavailable",
  "plugin_enable_failed",
  "plugin_verify_failed",
  "gateway_restart_failed",
  "gateway_start_failed",
  "port_conflict",
  "multiplex_conflict",
  "listener_owner_required",
  "service_unavailable",
  "service_not_found",
  "candidate_not_found",
  "candidate_changed",
  "configuration_failed",
  "token_missing",
  "token_invalid",
  "ssh_unknown_host",
  "ssh_connection_failed",
  "ssh_auth_failed",
  "ssh_key_not_found",
  "ssh_system_unavailable",
  "ssh_host_key_failed",
  "ssh_unavailable",
  "ssh_timeout",
  "command_timeout",
  "command_failed",
  "output_limit",
  "unsupported_platform",
  "invalid_candidate",
  "host_operation_failed",
  "unsafe_host_path",
  "invalid_host_config",
  "managed_service_required",
  "service_identity_ambiguous",
  "service_identity_mismatch",
  "external_secret_provider",
  "api_key_invalid",
  "multiplex_override_present",
  "listener_ownership_unverified",
  "plugin_identity_ambiguous",
  "gateway_verification_failed",
  "profile_verification_failed",
  "invalid_host_operation",
  "host_busy",
  "profile_name_invalid",
  "profile_exists",
  "profile_create_failed",
  "profile_key_failed",
  "profile_provision_forbidden",
  "profile_verify_failed",
  "hermes_already_installed",
  "hermes_install_forbidden",
  "hermes_install_failed",
  "curl_missing",
  "system_packages_missing",
  "git_missing",
  "python_bootstrap_failed",
  "hermes_installer_unavailable",
  "resume_unavailable",
]);
/** A notice, not a failure. Goes out only in the job's `warnings` and never onto the error path. */
export const SETUP_WARNING_CODES = new Set([
  "profile_not_served",
  "model_provider_required",
  "linger_required",
  // A Windows scheduled task doesn't keep running after logout; it starts at the next logon.
  "logon_required",
]);
const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Same rules as the host. Reserved words include `default` — the owner key is handled by configure. */
export const RESERVED_PROFILE_NAMES = new Set(["hermes", "test", "tmp", "root", "sudo", "default"]);
export function validateProfileName(value: unknown): string {
  if (typeof value !== "string") throw new Error("profile_name_invalid");
  const trimmed = value.trim();
  if (!PROFILE_NAME.test(trimmed) || RESERVED_PROFILE_NAMES.has(trimmed))
    throw new Error("profile_name_invalid");
  return trimmed;
}
export function validateProfileDescription(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("profile_name_invalid");
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 200 || /[\r\n\0]/.test(trimmed)) throw new Error("profile_name_invalid");
  return trimmed;
}
/**
 * The range the wizard picks alternative ports from. The host uses the same range.
 * An accepted value is only submitted after the screen has obtained explicit consent.
 */
export const SETUP_PORT_SUGGEST_MIN = 8642;
export const SETUP_PORT_SUGGEST_MAX = 8699;
/** Values accepted by `set-port`. Allows wider than the suggestion range but rejects reserved and out-of-range
 * ports. */
export function validateSetupPort(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1024 || value > 65535)
    throw new Error("setup_invalid_request");
  return value;
}
const TIMEZONE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+\-.]+)*$/;
/** Only lets IANA-name shapes through. Actual existence is decided by the host. */
export function validateTimezone(value: unknown): string {
  if (typeof value !== "string") throw new Error("timezone_invalid");
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 64 || !TIMEZONE.test(trimmed))
    throw new Error("timezone_invalid");
  // A shape check alone lets `Asia/../Seoul` through. Python's zoneinfo rejects such names, so
  // it isn't dangerous, but it would leave an unresolvable value in the operator's config.yaml — cut it here.
  if (trimmed.split("/").some((segment) => segment === "." || segment === ".."))
    throw new Error("timezone_invalid");
  return trimmed;
}
/**
 * Builds the list of warnings to leave on the job.
 *
 * A freshly installed Hermes can't have model credentials. Originally this was to be judged by whether the model
 * list was empty, but `/v1/models` returns 200 and one model even with no providers (measured: new MiniPC account).
 * So the fact "we installed it" is itself used as the signal.
 */
export function collectSetupWarnings(
  hostWarnings: string[] | undefined,
  installedHermes: boolean,
  modelState?: SetupModelState,
) {
  const warnings = [...new Set(hostWarnings ?? [])];
  // If confirmation is possible, confirmation wins. `ready` overrides the "just installed" assumption.
  if (modelState === "ready")
    return warnings.filter((warning) => warning !== "model_provider_required");
  const required = modelState === "missing" || installedHermes;
  if (required && !warnings.includes("model_provider_required"))
    warnings.push("model_provider_required");
  return warnings;
}
export function safeSetupError(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  return SAFE_CODES.has(code) ? code : "setup_failed";
}

export type SetupFailureLogEntry = {
  code: "setup_failed";
  errorName: string;
  stackFrames: string[];
};

/**
 * What the setup route may log for an opaque `setup_failed`, so operators can find where it happened.
 * The wizard handles tokens, so the error message is never included. A message can span several lines
 * of `stack` — even lines that begin with "at " (remote stderr, URLs) — so a line is kept only when it is
 * shaped like a V8 call site ending in a local path or node: module with `:line:column`. The error name is
 * kept only when it looks like a class name.
 */
const STACK_FRAME = /^at (?:[\w$.<>[\] ]+ \()?(?:file:\/\/)?(?:\/|node:)[^\s()@=]*:\d+:\d+\)?$/;
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

export function setupFailureLogEntry(code: string, error: unknown): SetupFailureLogEntry | null {
  if (code !== "setup_failed") return null;
  const stackFrames =
    error instanceof Error && typeof error.stack === "string"
      ? error.stack
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => STACK_FRAME.test(line))
          .slice(0, 5)
      : [];
  const errorName =
    error instanceof Error ? (ERROR_NAME.test(error.name) ? error.name : "Error") : typeof error;
  return { code, errorName, stackFrames };
}
