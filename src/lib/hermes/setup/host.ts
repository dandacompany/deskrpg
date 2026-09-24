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
  // 키 거절. 이 목록에 없으면 아래에서 host_operation_failed 로 뭉개져, 화면이 공개키 등록을 안내하지 못한다.
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
/** 실패가 아닌 알림만 담는다. 오류 경로에는 절대 오르지 않는다. */
const HOST_WARNING_CODES = new Set(["profile_not_served", "model_provider_required"]);
const DIGEST = /^[a-f0-9]{64}$/;
/** 마법사가 제안할 수 있는 포트 범위. 호스트가 이 밖의 값을 올리면 제안 자체를 버린다. */
const SUGGEST_MIN = 8642;
const SUGGEST_MAX = 8699;
/**
 * `port_conflict` 만 대안 포트를 하나 들고 온다. 코드는 그대로이고 숫자 하나만 더 실린다 —
 * 제안이 없으면 `suggestedPort` 는 undefined 이고 화면은 지금처럼 오류만 보여 준다.
 */
/** 설치에 필요한 시스템 패키지가 없다 — 코드와 패키지 관리자만 싣는다(명령 문자열은 화면이 만든다). */
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
    // 이름은 Error 그대로 둔다 — 오류 문자열을 코드로 비교하는 기존 경로가 바뀌면 안 된다.
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
 * 설치 진행 이정표. 호스트가 무엇을 올리든 이 목록 밖의 값은 버린다 —
 * 줄 내용이 코드를 가장해 잡에 실리는 경로를 아예 없앤다.
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
/** 헬퍼가 준 프로필 이름 목록 — 모양이 어긋난 값은 버린다(화면에 그대로 싣는 값이다). */
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
  /** SSH 대상은 언제나 리눅스다 — 로컬 실행일 때만 `process.platform` 을 기본으로 쓴다. */
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
      // 숫자 문자열만 받는다. 범위 판정은 호스트가 또 한다 — 여기서 먼저 잘라 호스트 호출 자체를 막는다.
      const port = Number(option);
      if (!/^[0-9]{4,5}$/.test(option) || !Number.isInteger(port) || port < 1024 || port > 65535)
        throw new Error("setup_invalid_request");
    } else if (option.length > 1024 || /[\r\n\0]/.test(option))
      throw new Error("setup_invalid_request");
  }
  const timeout =
    action === "install" || action === "install-service"
      ? 170
      : // 헬퍼는 서비스 정지 한도 + 기동 여유를 최대 300초까지 기다린다(RESTART_MAX). 바깥이 먼저 끊기면
        // 원인이 command_timeout 으로 바뀌고 헬퍼의 gateway_restart_failed 판정을 잃는다.
        action === "restart"
        ? 330
        : action === "verify"
          ? 110
          : // 호스트가 CLI 를 45초까지 기다린다 — 바깥 상한이 그보다 좁으면 판정이 늘 timeout 이 된다.
            action === "check-model"
            ? 60
            : 45;
  try {
    // 파이썬이 하나도 없으면 Hermes 도 없다 — 탐색은 빈 목록(→ 설치 제안), 그 밖은 hermes_not_found.
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
 * 로컬 Hermes 설치. 게이트 판정은 호출자(service.ts)가 이미 끝냈다고 가정하지 않고,
 * 이 함수는 설치가 없다는 것과 결과 지문만 책임진다. 설치 출력은 어디에도 남지 않는다.
 */
export async function installHermesHost(
  execute: HostExecutor,
  signal?: AbortSignal,
  /** SSH 대상은 언제나 리눅스다 — 로컬 실행일 때만 `process.platform` 을 기본으로 쓴다. */
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
    // 관측 순서는 지키되 목록 밖의 값과 중복은 버린다. 설치 출력의 원문은 여기에 오를 수 없다.
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
    // 설치 로그·stderr 가 예외에 실려 있을 수 있다. 절대 그대로 흘리지 않는다.
    throw new Error("hermes_install_failed");
  }
}
/**
 * 모델 자격 증명 확인. **절대 던지지 않는다** — 판정할 수 없으면 `unknown` 이고,
 * 호출자는 이 결과로 설정을 중단하지 않는다.
 */
export async function checkModelHost(
  execute: HostExecutor,
  candidateId: string,
  signal?: AbortSignal,
  /** SSH 대상은 언제나 리눅스다 — 로컬 실행일 때만 `process.platform` 을 기본으로 쓴다. */
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
  /** SSH 대상은 언제나 리눅스다 — 로컬 실행일 때만 `process.platform` 을 기본으로 쓴다. */
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
 * 워커 전파 운영자 설정을 켜거나 끈다(루트 config 한 키, 되읽기 확인). 돌려주는 값은 **실제 상태**다 —
 * 끄기를 써도 루트 .env 의 환경변수가 켜 두었으면 `enabled` 다. 게이트웨이를 재시작하지 않는다.
 */
export async function setWorkerPropagationHost(
  execute: HostExecutor,
  candidateId: string,
  enabled: boolean,
  /** SSH 대상은 언제나 리눅스다 — 로컬 실행일 때만 `process.platform` 을 기본으로 쓴다. */
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
  /** SSH 대상은 언제나 리눅스다 — 로컬 실행일 때만 `process.platform` 을 기본으로 쓴다. */
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
  /** 재개에서 이미 성공한 단계. 되돌리지 않고 다시 하지도 않는다. `inspecting` 은 언제나 다시 돈다. */
  skipStep?: (step: string) => boolean,
  /** 화면이 제안을 명시적으로 수락했을 때만 온다. 후보 홈의 `.env` 에만 쓴다. */
  setPort?: number,
  /** SSH 대상은 언제나 리눅스다 — 로컬 실행일 때만 `process.platform` 을 기본으로 쓴다. */
  platform: string = process.platform,
  /**
   * 워커 전파를 이 값으로 맞춘다(마법사 체크박스·갱신의 이어받기). undefined 면 건드리지 않는다.
   * 이미 그 상태면 아무것도 하지 않는다.
   */
  workerPropagation?: boolean,
): Promise<PreparedHost> {
  const skip = (step: string) => skipStep?.(step) === true;
  // 서비스를 등록하면 유닛 정의가 생기고 후보 id(정의의 해시)가 바뀐다. 이후 단계는 새 id 를 써야 한다.
  let candidateId = initialCandidateId;
  const stage = async (step: string, action: string, option?: string) => {
    checkAbort(signal);
    onStep(step);
    checkAbort(signal);
    return invoke(execute, action, candidateId, signal, option, platform);
  };
  const requestedKeys = assertProvisionRequest(provision);
  const warnings: string[] = [];
  // 포트를 먼저 옮겨야 이어지는 inspect 가 빈 포트를 보고 충돌 없이 진행한다.
  // 실제 적용은 아래 `restarting_gateway` 가 한다 — 여기서는 `.env` 만 고친다.
  if (setPort !== undefined && !skip("setting_port"))
    await stage("setting_port", "set-port", String(setPort));
  const state = inspection(await stage("inspecting", "inspect"));
  // 새 프로필은 플러그인·API 작업보다 앞에 만들어야 재시작 한 번으로 서빙된다.
  const provisionKeys = [...requestedKeys];
  if (provision?.createProfile && skip("creating_profile")) {
    // 이미 만들어진 프로필이다. 다시 만들면 `profile_exists` 로 죽는다 — 키 발급 대상에만 넣는다.
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
    // 허용 목록 밖이면 서빙되지 않으므로 키를 발급해도 검증할 수 없다.
    if (!notServed && !provisionKeys.includes(provision.createProfile.name))
      provisionKeys.push(provision.createProfile.name);
  }
  const provisioned: string[] = [];
  if (provisionKeys.length && !skip("provisioning_keys")) {
    // 여러 프로필을 한 단계에서 처리한다 — 진행 기록에 프로필 이름은 남기지 않는다.
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
  // 재시작이 필요한지는 **호스트가 말해 준다**(`changes`). 여기서 "무엇을 했으니 필요하다" 를
  // 따로 추론하면 호스트 판정과 어긋난다. 예전에는 configure·timezone 이 돌 때만 재시작해서,
  // 플러그인만 뒤처진 흔한 경우(최소 버전은 넘지만 핀보다 낮음)에 새 코드가 설치만 되고
  // 옛 코드가 계속 서빙됐다. 조건이 여럿 참이어도 재시작은 한 번이다.
  // 워커 전파는 플러그인이 호출마다 설정을 읽는 것이 계약이지만, 로드 때 읽는 버전이 섞여 있어도
  // 새 값이 서빙되도록 이미 도는 재시작에 얹는다(조건이 여럿 참이어도 재시작은 한 번이다).
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
  // 키를 발급했으면 그 키로 실제 서빙을 확인한다. verify 는 인증에 실패한 프로필을 그냥 뺀다.
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
 * 사용자 단위 systemd 서비스가 로그아웃·재부팅 뒤에도 사는가(`loginctl` Linger). SSH 대상에서만 묻는다.
 * **절대 던지지 않는다** — 판정할 수 없으면(macOS·loginctl 없음) `unknown` 이고 설정을 멈추지 않는다.
 * 켜는 일은 보통 sudo 가 필요해 DeskRPG 가 하지 않는다 — 꺼져 있으면 명령을 안내한다(2026-09-19 단테 결정).
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
