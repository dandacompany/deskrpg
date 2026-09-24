import { homedir, hostname } from "node:os";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db, users, gatewayResources, nowForDb } from "@/db";
import { decryptGatewayToken, upsertOwnedGatewayResource } from "@/lib/gateway-resources";
import { registerHermesProfile } from "@/lib/hermes-profiles";
import { isValidProfileName } from "../profile-name";
import {
  checkLingerHost,
  checkModelHost,
  discoverHost,
  inspectHost,
  installHermesHost,
  SetupPackagesMissingError,
  prepareHost,
  setWorkerPropagationHost,
} from "./host";
import { localExecutor, sshExecutor, getSshHosts, sshFailureCode, sshOptions } from "./executor";
import {
  ensureSshTunnel,
  readSshTransportTarget,
  registerSshTransport,
  transportFetch,
} from "./transport";
import { classifyGatewayHost } from "./gateway-host-target";
import {
  collectSetupWarnings,
  hermesInstallAllowed,
  hostSetupAllowed,
  safeSetupError,
  validateGatewayUrl,
} from "./policy";
import { SetupJobStore } from "./store";
import { describeCapabilities } from "./capabilities";
import { hasCommandIn, hermesRootPath, venvPythonPath } from "./platform";
import { managedSsh } from "./ssh-hosts";
import {
  readSshConfigHosts,
  systemSsh,
  systemSshArgs,
  systemSshAvailable,
  validateSystemTarget,
} from "./system-ssh";
import { buildPluginCacheUpdate, buildPluginInfoCacheUpdate } from "../plugin-cache-update";
import { probeDeskrpgPluginWithInfo } from "../plugin-capability";
import { verifySetupGateway } from "./verify";
import { createPluginClient } from "../plugin-client";
import { applyWorkerPlugin, type ApplyWorkerPluginDeps } from "../worker-plugin";
import {
  inheritedWorkerPropagation,
  runWorkerPropagation,
  setupWorkerPluginApplies,
} from "./worker-propagation";
import type {
  HostTarget,
  PreparedHost,
  SetupCapabilities,
  SetupModelState,
  SetupProvisionRequest,
} from "./types";

const stores = globalThis as typeof globalThis & {
  __deskrpgSetupControllers?: Map<string, AbortController>;
};
const controllers = (stores.__deskrpgSetupControllers ??= new Map());
const store = () => new SetupJobStore();
const STEPS = new Set([
  "installing_hermes",
  "inspecting",
  "creating_profile",
  "provisioning_keys",
  "installing_service",
  "installing_plugin",
  "enabling_plugin",
  "updating_plugin",
  "configuring_api",
  "setting_timezone",
  "setting_worker_propagation",
  "setting_port",
  "restarting_gateway",
  "verifying_gateway",
  "checking_model",
  "importing_profiles",
  "applying_worker_plugin",
  "saving_gateway",
]);
/**
 * Steps that always rerun, even on resume. Host state may have changed since the previous job,
 * and both are read-only checks, so redoing them loses nothing.
 * `inspecting` is not skipped for the same reason — every later decision stands on its result.
 */
const ALWAYS_RERUN = new Set(["inspecting", "verifying_gateway", "checking_model"]);

async function role(userId: string) {
  const [user] = await db
    .select({ role: users.systemRole })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return user?.role;
}
function hasCommand(command: string) {
  return hasCommandIn(
    command,
    process.env as Record<string, string | undefined>,
    process.platform,
    (candidate) => {
      accessSync(candidate, constants.X_OK);
      return true;
    },
  );
}
/** Is this process running inside a container? A failed check means "no" — so we never err on the blocking side. */
function inContainer() {
  if (existsSync("/.dockerenv") || existsSync("/run/.containerenv")) return true;
  try {
    return /docker|containerd|kubepods|libpod/.test(readFileSync("/proc/1/cgroup", "utf8"));
  } catch {
    return false;
  }
}
/**
 * Same criterion as the host helper (HOST_BOOTSTRAP) — the venv python under `hermes-agent/{venv,.venv}` in the
 * Hermes home.
 */
function localHermesFound() {
  const root = path.join(
    hermesRootPath(process.platform, process.env as Record<string, string | undefined>, homedir()),
    "hermes-agent",
  );
  return ["venv", ".venv"].some((folder) =>
    existsSync(venvPythonPath(process.platform, path.join(root, folder))),
  );
}
export async function setupCapabilities(userId: string): Promise<SetupCapabilities> {
  const systemRole = await role(userId);
  const enabled = hostSetupAllowed(process.env, systemRole);
  return describeCapabilities({
    role: systemRole,
    switchedOff: systemRole === "system_admin" && !enabled,
    installAllowed: hermesInstallAllowed(process.env, systemRole, "local"),
    platform: process.platform,
    hasSsh: hasCommand("ssh"),
    hasPowershell: process.platform !== "win32" || hasCommand("powershell"),
    inContainer: inContainer(),
    localHermesFound: localHermesFound(),
    hostLabel: hostname(),
    sshHosts: enabled ? getSshHosts() : [],
  });
}
/** SSH host management — admin only (same as the host gate). The private key is never included in any response. */
async function requireHostAdmin(userId: string) {
  if (!hostSetupAllowed(process.env, await role(userId))) throw new Error("setup_forbidden");
  return managedSsh();
}
export async function sshPublicKey(userId: string) {
  return { publicKey: await (await requireHostAdmin(userId)).publicKey() };
}
export async function sshScanHost(userId: string, input: Record<string, unknown>) {
  const keys = await (await requireHostAdmin(userId)).scan(input as never);
  return { keys: keys.map(({ type, fingerprint }) => ({ type, fingerprint })) };
}
export async function sshRegisterHost(userId: string, input: Record<string, unknown>) {
  const fingerprints = input.fingerprints;
  if (
    !Array.isArray(fingerprints) ||
    fingerprints.length === 0 ||
    fingerprints.length > 8 ||
    fingerprints.some((f) => typeof f !== "string" || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(f))
  )
    throw new Error("setup_invalid_request");
  const host = await (await requireHostAdmin(userId)).register(input as never, fingerprints);
  return { host: { id: host.id, label: host.label } };
}
export async function sshRemoveHost(userId: string, hostId: unknown) {
  if (typeof hostId !== "string" || !/^[hs]-[a-f0-9]{10}$/.test(hostId))
    throw new Error("setup_invalid_request");
  const managed = await requireHostAdmin(userId);
  if (hostId.startsWith("s-")) await systemSsh().remove(hostId);
  else await managed.remove(hostId);
  return { removed: hostId };
}
/** Whether the Desktop method is available, plus `~/.ssh/config` aliases (for suggestions). Admin only. */
export async function sshSystemInfo(userId: string) {
  await requireHostAdmin(userId);
  const available = systemSshAvailable();
  return { available, aliases: available ? readSshConfigHosts() : [] };
}
/**
 * Add a host the Desktop way — saved only after one successful connection. Uses the server user's config and agent as-is,
 * and an unseen host key is recorded in the server user's known_hosts (accept-new).
 */
export async function sshSystemAdd(userId: string, input: Record<string, unknown>) {
  await requireHostAdmin(userId);
  if (!systemSshAvailable()) throw new Error("ssh_system_unavailable");
  const target = validateSystemTarget(input);
  const probe = await localExecutor(
    "ssh",
    [
      ...systemSshArgs({ ...target, id: "", label: "", addedAt: "" }),
      ...sshOptions("accept-new"),
      "-T",
      "--",
      target.target,
      "true",
    ],
    { timeoutMs: 20_000 },
  );
  if (probe.code === 255) throw new Error(sshFailureCode(probe.stderr));
  if (probe.code !== 0) throw new Error("ssh_connection_failed");
  const host = await systemSsh().add(target);
  return { host: { id: host.id, label: host.label } };
}
async function requireHost(userId: string, target: HostTarget) {
  if (!hostSetupAllowed(process.env, await role(userId))) throw new Error("setup_forbidden");
  if (target.mode === "local") return localExecutor;
  if (target.mode === "ssh" && target.hostId) return sshExecutor(target.hostId);
  throw new Error("setup_invalid_request");
}
/** An SSH target is always Linux — only local execution uses the actual platform this server runs on. */
function hostPlatform(target: HostTarget): string {
  return target.mode === "ssh" ? "linux" : process.platform;
}
export async function discoverSetupHost(userId: string, target: HostTarget) {
  return discoverHost(await requireHost(userId, target), hostPlatform(target));
}
export async function inspectSetupHost(userId: string, target: HostTarget, candidateId: string) {
  return inspectHost(await requireHost(userId, target), candidateId, hostPlatform(target));
}
/**
 * Checks only the model credentials. Creates no job and answers immediately.
 * The existing host gate must still pass, but the check itself never turns into a failure for any reason.
 */
export async function checkSetupModel(
  userId: string,
  target: HostTarget,
  candidateId: string,
): Promise<SetupModelState> {
  return checkModelHost(
    await requireHost(userId, target),
    candidateId,
    undefined,
    hostPlatform(target),
  );
}

function assertPrepared(value: PreparedHost) {
  let parsed: URL;
  try {
    parsed = new URL(value.baseUrl);
  } catch {
    throw new Error("setup_failed");
  }
  if (
    parsed.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/" ||
    typeof value.token !== "string" ||
    value.token.length < 16 ||
    value.token.length > 4096
  )
    throw new Error("setup_failed");
  if (
    !Array.isArray(value.profiles) ||
    value.profiles.length > 1000 ||
    value.profiles.some(
      (p) =>
        !isValidProfileName(p.name) ||
        typeof p.token !== "string" ||
        p.token.length < 16 ||
        p.token.length > 4096,
    )
  )
    throw new Error("profile_import_failed");
  return Number(parsed.port || 80);
}

export async function startSetup(
  userId: string,
  target: HostTarget,
  candidateId: string,
  selectedProfiles: string[],
  timezone?: string,
  provision?: SetupProvisionRequest,
  installHermes?: boolean,
  resumeFrom?: string,
  /** Present only when the screen explicitly accepted the alternative-port suggestion. */
  setPort?: number,
  /** Worker propagation checkbox (plugin 0.16.0). If undefined, host settings are left untouched. */
  workerPropagation?: boolean,
) {
  const executor = await requireHost(userId, target);
  // Host gate + install switch + target (local·ssh). Per-target conditions are decided by hermesInstallAllowed.
  if (installHermes && !hermesInstallAllowed(process.env, await role(userId), target.mode))
    throw new Error("hermes_install_forbidden");
  const jobs = store();
  const targetKey = JSON.stringify(target);
  // Only resume a failed job of the same user and same target. Decided before taking the lock so we never tie up a
  // host with someone else's job.
  const inherited = resumeFrom
    ? (jobs.resumable(userId, resumeFrom, targetKey).completed ?? [])
    : [];
  const done = (name: string) => inherited.includes(name) && !ALWAYS_RERUN.has(name);
  // Host-wide lock: default and named candidates may share config/plugin installation.
  const release = jobs.lock(targetKey);
  let job;
  try {
    job = jobs.create(userId, targetKey, { completed: inherited });
  } catch (error) {
    release();
    throw error;
  }
  const controller = new AbortController();
  controllers.set(job.id, controller);
  const checkCancelled = () => {
    if (jobs.cancelled(userId, job.id) || controller.signal.aborted)
      throw new Error("setup_cancelled");
  };
  // The next step starting means the previous step finished without throwing — that is when it goes into `completed`.
  let pending: string | null = null;
  const complete = (name: string) => {
    const prior = jobs.get(userId, job.id);
    const completed = prior.completed ?? [];
    if (!completed.includes(name)) jobs.update(userId, job.id, { completed: [...completed, name] });
  };
  const settle = () => {
    if (pending) complete(pending);
    pending = null;
  };
  const step = (name: string) => {
    checkCancelled();
    if (!STEPS.has(name)) return;
    if (pending && pending !== name) complete(pending);
    pending = name;
    const prior = jobs.get(userId, job.id);
    if (prior.steps.at(-1) !== name) jobs.update(userId, job.id, { steps: [...prior.steps, name] });
  };
  // The server owns this job; request completion does not cancel its subprocess.
  void (async () => {
    try {
      let selectedCandidateId = candidateId;
      if (installHermes) {
        // A resume that already finished installing does not reinstall. Nor does it roll back the install — it only
        // rediscovers candidates.
        if (!done("installing_hermes")) {
          step("installing_hermes");
          const { installerDigest, milestones } = await installHermesHost(
            executor,
            controller.signal,
            hostPlatform(target),
          );
          jobs.update(userId, job.id, {
            installerDigest,
            // Keep only the last milestone. It is a code, not the line content.
            ...(milestones.length ? { progress: milestones[milestones.length - 1] } : {}),
          });
          checkCancelled();
        }
        // New candidates appear after installing — the client cannot know, so the server rediscovers them.
        const candidates = await discoverHost(executor, hostPlatform(target));
        const fresh = candidates.find((item) => item.label === "Hermes default");
        if (!fresh) throw new Error("hermes_install_failed");
        selectedCandidateId = fresh.id;
      }
      step("inspecting");
      // Cancel only at safe command boundaries. The helper owns its process group
      // watchdog; killing the launcher cannot prove every descendant stopped.
      const boundedExecutor: typeof executor = (command, args, options) =>
        executor(command, args, { ...options, signal: undefined });
      const prepared = await prepareHost(
        boundedExecutor,
        selectedCandidateId,
        step,
        controller.signal,
        timezone,
        provision,
        done,
        setPort,
        hostPlatform(target),
        workerPropagation,
      );
      const collected = collectSetupWarnings(prepared.warnings, Boolean(installHermes));
      if (collected.length) jobs.update(userId, job.id, { warnings: collected });
      const remotePort = assertPrepared(prepared);
      const selected = new Set(selectedProfiles);
      if (
        selectedProfiles.some((name) => !prepared.profiles.some((profile) => profile.name === name))
      )
        throw new Error("profile_import_failed");
      checkCancelled();
      const probeUrl =
        target.mode === "ssh"
          ? await ensureSshTunnel(target.hostId!, remotePort)
          : prepared.baseUrl;
      step("verifying_gateway");
      const capability = await verifySetupGateway(probeUrl, prepared.token, transportFetch);
      if (capability.status !== "plugin_ready")
        throw new Error(
          capability.status === "plugin_unauthorized"
            ? "plugin_unauthorized"
            : "plugin_verify_failed",
        );
      checkCancelled();
      // The check runs before saving the gateway, and whatever the result, it never stops setup.
      step("checking_model");
      const modelState = await checkModelHost(
        boundedExecutor,
        selectedCandidateId,
        controller.signal,
        hostPlatform(target),
      );
      // An SSH target's gateway must survive logout and reboot — if Linger is off we only show guidance.
      // Windows local means something different: a scheduled task starts at the next logon.
      const windowsLocal = target.mode === "local" && process.platform === "win32";
      const lingerOff =
        target.mode === "ssh" && (await checkLingerHost(boundedExecutor)) === "disabled";
      const extraWarnings = [
        ...(lingerOff ? ["linger_required"] : []),
        ...(windowsLocal ? ["logon_required"] : []),
      ];
      jobs.update(userId, job.id, {
        warnings: collectSetupWarnings(
          [...(prepared.warnings ?? []), ...extraWarnings],
          Boolean(installHermes),
          modelState,
        ),
      });
      checkCancelled();
      const baseUrl =
        target.mode === "ssh"
          ? await registerSshTransport(target.hostId!, remotePort)
          : prepared.baseUrl;
      step("saving_gateway");
      const gateway = await upsertOwnedGatewayResource({
        ownerUserId: userId,
        baseUrl,
        token: prepared.token,
        displayName: target.mode === "ssh" ? `Hermes · ${target.hostId}` : `Hermes · ${hostname()}`,
      });
      // Preserve a recoverable resource link even if profile import is interrupted.
      jobs.update(userId, job.id, { gatewayId: gateway.id });
      await db
        .update(gatewayResources)
        .set({
          lastValidatedAt: nowForDb(),
          lastValidationStatus: "valid",
          lastValidationError: null,
          pluginStatus: capability.status,
          pluginVersion: capability.version,
          pluginCheckedAt: nowForDb(),
          // Board provisioning (kanban-boards.ts) uses it for the contract check — without it, it re-probes even
          // with a fresh cache.
          ...buildPluginInfoCacheUpdate(capability.info),
        })
        .where(eq(gatewayResources.id, gateway.id));
      step("importing_profiles");
      for (const profile of prepared.profiles.filter((profile) => selected.has(profile.name))) {
        checkCancelled();
        const result = await registerHermesProfile({
          userId,
          gatewayId: gateway.id,
          profileName: profile.name,
          token: profile.token,
        });
        if ("error" in result) throw new Error("profile_import_failed");
      }
      checkCancelled();
      // If enabling was chosen, apply it to existing employees too. Even if that fails the connection is done — leave
      // only a warning; it can be redone with the apply button on the gateway screen.
      if (
        setupWorkerPluginApplies(workerPropagation, prepared.workerPropagation, capability.info)
      ) {
        step("applying_worker_plugin");
        const applied = await runWorkerPropagationApply(gateway);
        if (!applied) {
          const prior = jobs.get(userId, job.id).warnings ?? [];
          jobs.update(userId, job.id, {
            warnings: [...new Set([...prior, "worker_plugin_apply_failed"])],
          });
        }
      }
      settle();
      jobs.update(userId, job.id, { status: "succeeded" });
    } catch (error) {
      const code =
        controller.signal.aborted || jobs.cancelled(userId, job.id)
          ? "setup_cancelled"
          : safeSetupError(error);
      jobs.update(userId, job.id, {
        status: code === "setup_cancelled" ? "cancelled" : "failed",
        error: code,
        ...(error instanceof SetupPackagesMissingError
          ? {
              missingPackages: error.packages,
              ...(error.manager ? { packageManager: error.manager } : {}),
            }
          : {}),
      });
    } finally {
      controllers.delete(job.id);
      release();
    }
  })().catch(() => {
    /* persist failure if storage failed; never log raw host output */
  });
  return job;
}
type GatewayRow = typeof gatewayResources.$inferSelect;

/**
 * Finds the host of a registered gateway (owner only). A local address means this server; an SSH tunnel means that host.
 * An address with no way to run commands, like `host.docker.internal` seen from a container, throws a dedicated code.
 */
async function resolveGatewayHost(
  userId: string,
  gatewayId: string,
): Promise<{ gateway: GatewayRow; target: HostTarget; port: number }> {
  const [gateway] = await db
    .select()
    .from(gatewayResources)
    .where(eq(gatewayResources.id, gatewayId))
    .limit(1);
  // We cannot let anyone run commands on someone else's gateway host — not even a user it was shared with.
  if (!gateway || gateway.ownerUserId !== userId) throw new Error("setup_not_found");
  const kind = classifyGatewayHost(gateway.baseUrl);
  if (kind.mode === "local") return { gateway, target: { mode: "local" }, port: kind.port };
  if (kind.mode === "ssh") {
    const ssh = await readSshTransportTarget(gateway.baseUrl);
    if (!ssh) throw new Error("ssh_unknown_host");
    return { gateway, target: { mode: "ssh", hostId: ssh.hostId }, port: ssh.remotePort };
  }
  throw new Error("plugin_update_unsupported_host");
}

/**
 * The existing apply (`POST /deskrpg/worker-plugin`, owner key) followed by the plugin info cache refresh.
 * The gateway screen's apply button, the wizard and "설정에서 켜기" all use this.
 */
export function gatewayWorkerPluginDeps(gateway: GatewayRow): ApplyWorkerPluginDeps {
  // deskrpg-allow-token-arg: an argument the server uses to call Hermes, not a response.
  const token = decryptGatewayToken(gateway.tokenEncrypted);
  const client = createPluginClient({ baseUrl: gateway.baseUrl, defaultToken: token });
  return {
    ensure: () => client.ensureWorkerPlugin(),
    refreshCache: async () => {
      const probed = await probeDeskrpgPluginWithInfo({
        fetchImpl: transportFetch,
        baseUrl: gateway.baseUrl,
        // deskrpg-allow-token-arg: an argument the server uses to call Hermes, not a response.
        token,
      });
      await db
        .update(gatewayResources)
        .set({
          ...buildPluginCacheUpdate(probed.capability),
          ...buildPluginInfoCacheUpdate(probed.info),
        })
        .where(eq(gatewayResources.id, gateway.id));
    },
  };
}

/** Apply at the end of the wizard. true on success — the result list is re-read from the cache by the gateway screen. */
async function runWorkerPropagationApply(gateway: GatewayRow): Promise<boolean> {
  try {
    return (await applyWorkerPlugin(gatewayWorkerPluginDeps(gateway))).ok;
  } catch {
    return false;
  }
}

/**
 * "설정에서 켜기" (gateway screen) and [끄기] on resume. Writes the host root config, and when enabling also runs the
 * existing apply. It is short, so it does not run as a job, but it takes the host lock so it never overlaps an
 * install/update on the same host.
 * Does not restart the gateway — the plugin reads the config on every call (0.16.0 contract).
 */
export async function setGatewayWorkerPropagation(
  userId: string,
  gatewayId: string,
  enabled: boolean,
) {
  const { gateway, target, port } = await resolveGatewayHost(userId, gatewayId);
  const executor = await requireHost(userId, target);
  const platform = hostPlatform(target);
  const candidate = (await discoverHost(executor, platform)).find((item) => item.port === port);
  if (!candidate) throw new Error("plugin_update_candidate_not_found");
  const release = store().lock(JSON.stringify(target));
  try {
    return await runWorkerPropagation(enabled, {
      setFlag: (value) => setWorkerPropagationHost(executor, candidate.id, value, platform),
      ...gatewayWorkerPluginDeps(gateway),
    });
  } finally {
    release();
  }
}

/**
 * Upgrades **only the plugin** of an already registered, in-use gateway to the pinned version.
 *
 * The wizard (`startSetup`) cannot be reused as-is: that flow upserts the gateway at the end,
 * overwriting the display name with `Hermes · <host>` (`gateway-resources.ts:133`) and re-importing
 * the profiles. Not touching the user-given name and sharing settings is this path's contract.
 *
 * So it reuses the pipeline (`prepareHost`), closes the steps an update does not need with `skipStep`,
 * and when done writes **only the plugin cache** — token, address and name stay as they are.
 */
export async function startPluginUpdate(userId: string, gatewayId: string) {
  const { gateway, target, port } = await resolveGatewayHost(userId, gatewayId);
  const executor = await requireHost(userId, target);
  const platform = hostPlatform(target);
  const candidates = await discoverHost(executor, platform);
  // The port in the address is this gateway's identity — the label can differ per host.
  const candidate = candidates.find((item) => item.port === port);
  if (!candidate) throw new Error("plugin_update_candidate_not_found");
  // If the old plugin had propagated links, carry them over enabled. The screen sees the job's marker, notifies
  // once and offers [끄기].
  const inherit = inheritedWorkerPropagation(candidate);

  const jobs = store();
  const targetKey = JSON.stringify(target);
  const release = jobs.lock(targetKey);
  let job;
  try {
    job = jobs.create(userId, targetKey, {});
  } catch (error) {
    release();
    throw error;
  }
  const controller = new AbortController();
  controllers.set(job.id, controller);
  const step = (name: string) => {
    if (jobs.cancelled(userId, job.id) || controller.signal.aborted)
      throw new Error("setup_cancelled");
    if (!STEPS.has(name)) return;
    const prior = jobs.get(userId, job.id);
    if (prior.steps.at(-1) !== name) jobs.update(userId, job.id, { steps: [...prior.steps, name] });
  };

  void (async () => {
    try {
      // Close the steps that must not run in an update. Profiles, keys, port and timezone are settings already in
      // operation, and service registration is not something to redo on a running gateway.
      const skipStep = (name: string) =>
        name === "setting_port" ||
        name === "creating_profile" ||
        name === "provisioning_keys" ||
        name === "installing_service" ||
        name === "configuring_api" ||
        name === "setting_timezone";
      await prepareHost(
        executor,
        candidate.id,
        step,
        controller.signal,
        undefined,
        undefined,
        skipStep,
        undefined,
        platform,
        inherit ? true : undefined,
      );
      if (inherit) jobs.update(userId, job.id, { workerPropagationInherited: true });
      // Verify via our address that the new version is actually served (for ssh, transportFetch opens the tunnel).
      const probed = await probeDeskrpgPluginWithInfo({
        fetchImpl: transportFetch,
        baseUrl: gateway.baseUrl,
        // deskrpg-allow-token-arg: an argument the server uses to call Hermes, not a response.
        token: decryptGatewayToken(gateway.tokenEncrypted),
      });
      await db
        .update(gatewayResources)
        .set({
          ...buildPluginCacheUpdate(probed.capability),
          ...buildPluginInfoCacheUpdate(probed.info),
        })
        .where(eq(gatewayResources.id, gatewayId));
      if (probed.capability.status !== "plugin_ready") throw new Error("plugin_verify_failed");
      jobs.update(userId, job.id, { status: "succeeded", gatewayId });
    } catch (error) {
      const code =
        controller.signal.aborted || jobs.cancelled(userId, job.id)
          ? "setup_cancelled"
          : safeSetupError(error);
      jobs.update(userId, job.id, {
        status: code === "setup_cancelled" ? "cancelled" : "failed",
        error: code,
      });
    } finally {
      controllers.delete(job.id);
      release();
    }
  })().catch(() => {
    /* Also swallows the case where the failure could not be recorded on the job — host output is never logged. */
  });

  return job;
}

export function getSetupJob(userId: string, id: string) {
  return store().get(userId, id);
}
export function cancelSetupJob(userId: string, id: string) {
  const job = store().cancel(userId, id); // owner check precedes cancellation
  controllers.get(id)?.abort();
  return job;
}

export async function connectSetupUrl(
  userId: string,
  input: { url?: unknown; token?: unknown; displayName?: unknown },
) {
  const baseUrl = validateGatewayUrl(input.url);
  const token = typeof input.token === "string" ? input.token.trim() : "";
  if (token.length < 16 || token.length > 4096 || /[\r\n]/.test(token))
    throw new Error("setup_invalid_request");
  const displayName =
    typeof input.displayName === "string" ? input.displayName.trim().slice(0, 120) : "";
  const capability = await verifySetupGateway(baseUrl, token);
  if (capability.status === "plugin_unauthorized") throw new Error("plugin_unauthorized");
  if (capability.status === "unknown") throw new Error("plugin_unknown");
  const gateway = await upsertOwnedGatewayResource({
    ownerUserId: userId,
    baseUrl,
    token,
    displayName,
  });
  await db
    .update(gatewayResources)
    .set({
      lastValidatedAt: nowForDb(),
      lastValidationStatus: "valid",
      lastValidationError: null,
      pluginStatus: capability.status,
      pluginVersion: capability.version,
      pluginCheckedAt: nowForDb(),
      ...buildPluginInfoCacheUpdate(capability.info),
    })
    .where(eq(gatewayResources.id, gateway.id));
  return { gatewayId: gateway.id, pluginStatus: capability.status };
}
