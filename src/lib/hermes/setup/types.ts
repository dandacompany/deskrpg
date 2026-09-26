import type { WorkerPropagation } from "../deskrpg-plugin-types";

export type SetupMode = "local" | "ssh" | "url";
export type SetupCandidate = {
  id: string;
  label: string;
  version: string;
  service: string;
  pluginInstalled: boolean;
  pluginEnabled: boolean;
  /** plugin.yaml's version. null if not installed or the manifest does not state a version. */
  pluginVersion: string | null;
  port: number;
  hasToken: boolean;
  /** Top-level timezone in config.yaml. null if empty — only then does the wizard fill it in. */
  timezone: string | null;
  warning?: string;
  /** Gateway state at discovery time. If stopped, connecting starts it. */
  gatewayState?: "running" | "stopped" | "profile_gateways";
  /** Profiles this gateway serves under /p/<name>/ (excluding default). */
  profiles?: string[];
  /** Profile gateways running separately while default is stopped — they must be stopped first to connect. */
  profileGateways?: string[];
  /**
   * Worker propagation (plugin 0.16.0) operator setting — root config's `plugins.entries.deskrpg.worker_propagation`
   * or `DESKRPG_WORKER_PROPAGATION` in the root .env. Absent if a malformed value is received.
   */
  workerPropagation?: WorkerPropagation;
  /** Whether any profile has a `plugins/deskrpg` link propagated by the plugin — a trace an old plugin left enabled. */
  workerLinked?: boolean;
};
export type SetupInspection = {
  candidate: SetupCandidate;
  pluginStatus: "plugin_ready" | "plugin_absent" | "plugin_unauthorized" | "unknown";
  changes: string[];
  profiles?: { name: string; hasToken: boolean; canProvision?: boolean }[];
};
export type SetupJob = {
  id: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  steps: string[];
  error?: string;
  gatewayId?: string;
  /** Warning codes that are not failures. Remain even if the job succeeds (profile_not_served, model_provider_required). */
  warnings?: string[];
  /** sha256 (lowercase hex, 64 chars) of the install script install-hermes ran. Not a secret — an audit record. */
  installerDigest?: string;
  /**
   * The last observed install milestone code (`deps`·`clone`·`venv`·`node_modules`·`skills`·`done`).
   * A single predefined code, not raw install output.
   */
  progress?: string;
  /** System package codes missing in the pre-install check (curl·git·cxx). The UI builds the install command. */
  missingPackages?: string[];
  /** That server's package manager (apt·dnf·pacman·macos). Absent if unknown. */
  packageManager?: string;
  /**
   * Names of steps that succeeded. `steps` is "what was attempted" and does not know success — resume reads this list.
   * A resume job starts by inheriting the previous job's list as-is.
   * "Skipped" as the UI sees it is a step that is in `completed` but not in `steps`.
   */
  completed?: string[];
  /**
   * The plugin update saw the old version's worker propagation (a link per profile) and carried it over with the
   * operator setting on. The UI sees this and announces "계속 켭니다 [끄기]" once.
   */
  workerPropagationInherited?: boolean;
};
/** Model credential check result. Always `unknown` when the verdict is ambiguous, and never fails the setup. */
export type SetupModelState = "ready" | "missing" | "unknown";
export type SetupCapabilities = {
  local: boolean;
  ssh: boolean;
  hostLabel: string;
  sshHosts: { id: string; label: string }[];
  /** Is local open, is Hermes absent here, and is the install switch not turned off? */
  canInstallHermes: boolean;
  /** May we install on the SSH target? (Discovery reports whether each host has Hermes.) */
  canInstallHermesSsh?: boolean;
  /** Is Hermes installed in this server user's home? */
  localHermesFound?: boolean;
  /** Why local cannot be opened. null if open. */
  localReason?:
    "not_admin" | "disabled" | "unsupported_platform" | "container_without_hermes" | null;
  /** Why SSH cannot be opened. null if open (it opens even with no registered host — registration happens in the UI). */
  sshReason?: "not_admin" | "disabled" | "ssh_missing" | null;
};
/** Server-only secrets must never be serialized into setup responses. */
export type PreparedHost = {
  baseUrl: string;
  token: string;
  profiles: { name: string; token: string }[];
  /** Warning codes that are not failures. The server puts them on the job as-is. */
  warnings?: string[];
  /** Worker propagation state after setup finishes. Absent if the host did not report it. */
  workerPropagation?: WorkerPropagation;
};
export type SetupProvisionRequest = {
  createProfile?: { name: string; description?: string };
  provisionKeys?: string[];
};
export type HostTarget = { mode: "local" | "ssh"; hostId?: string };
export type CommandResult = { stdout: string; stderr: string; code: number };
export type HostExecutor = ((
  command: string,
  args: string[],
  /** `env` puts values that cannot be sent via argv (the Windows PowerShell launcher's payload) into the child process environment. */
  options?: {
    input?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    env?: Record<string, string>;
  },
) => Promise<CommandResult>) & {
  /** Largest stdout (bytes) this transport delivers reliably, when smaller than the helper's own cap. */
  stdoutLimit?: number;
  /**
   * Copies one file from the host to a local path (scp). Offered where stdout is capped, so a larger
   * reply can be spilled to a private file on the host and fetched instead (`receiveSpill`).
   */
  fetchFile?: (
    remotePath: string,
    localPath: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ) => Promise<void>;
};
