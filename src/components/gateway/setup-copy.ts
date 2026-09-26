import type { Locale } from "../../lib/i18n/context";
// The wizard's newer copy lives in the shared locale maps so the four languages stay in one
// place; older entries below predate that and are kept as-is.
import enText from "../../lib/i18n/locales/en";
import jaText from "../../lib/i18n/locales/ja";
import koText from "../../lib/i18n/locales/ko";
import zhText from "../../lib/i18n/locales/zh";

const ko = {
  title: "Hermes 게이트웨이 연결",
  selectProfiles: "가져올 기존 프로필",
  selectedProfiles: "선택한 프로필",
  profileNeedsToken: "API 인증 키를 먼저 설정해야 가져올 수 있습니다.",
  profileProvisionToken: "연결 중 인증 키를 생성합니다.",
  noSelectedProfiles:
    "프로필을 선택하지 않았습니다. 게이트웨이는 연결되며 프로필은 연결 후 별도로 등록해야 합니다.",
  intro: "Hermes가 실행되는 위치를 선택하세요.",
  local: "로컬 연결",
  remote: "원격 연결",
  localHelp: "로컬은 이 브라우저의 컴퓨터가 아니라 DeskRPG 서버가 실행되는 호스트입니다.",
  remoteHelp: "다른 서버의 Hermes에 연결합니다.",
  unavailable:
    "이 인스턴스에서는 호스트 접근이 허용되지 않습니다. 관리자에게 호스트 설정을 요청하거나 게이트웨이 주소로 연결하세요.",
  ssh: "SSH로 연결",
  url: "게이트웨이 주소로 연결",
  sshHelp:
    "등록한 SSH 호스트에서 Hermes 를 찾습니다. 내 SSH 설정(~/.ssh/config·ssh-agent) 또는 DeskRPG 전용 키로 호스트를 등록할 수 있습니다.",
  urlHelp: "기존 주소와 인증 키로 연결합니다.",
  host: "SSH 호스트",
  chooseHost: "호스트 선택",
  discover: "설치 찾기",
  discovering: "Hermes 설치를 확인하고 있습니다…",
  empty: "연결할 Hermes 설치를 찾지 못했습니다.",
  inspect: "연결하기",
  startAndConnect: "시작하고 연결",
  stateRunning: "실행 중",
  stateStopped: "중지됨 — 연결하면 게이트웨이를 시작합니다",
  stateProfileGateways:
    "프로필 게이트웨이가 따로 실행 중입니다. 아래 서비스를 멈춘 뒤 다시 찾으세요:",
  profilesIncluded: "포함 프로필",
  noProfiles: "추가 프로필 없음",
  review: "설치 및 연결 검토",
  service: "대상 게이트웨이 서비스",
  changes: "예정된 변경",
  noChanges: "설정 변경 없이 연결 상태를 검증합니다.",
  prepare: "설치 및 연결",
  verify: "검증 및 연결",
  back: "뒤로",
  retry: "다시 확인",
  cancel: "취소",
  cancelling: "현재 작업이 안전하게 끝나기를 기다리고 있습니다…",
  cancelHelp:
    "취소하면 현재 작업이 안전하게 끝난 뒤 다음 단계를 중단합니다. 이미 완료된 설치나 설정은 되돌려지지 않습니다.",
  running: "게이트웨이 준비 중",
  failed: "연결을 완료하지 못했습니다.",
  cancelled: "설정 작업을 중단했습니다.",
  connected: "게이트웨이가 연결되었습니다.",
  profiles: "프로필 확인하기",
  name: "표시 이름",
  address: "게이트웨이 주소",
  token: "API 인증 키",
  connect: "주소로 연결",
  loading: "확인 중…",
  absent:
    "API 연결은 저장되었지만 DeskRPG 플러그인이 없어 아직 준비되지 않았습니다. SSH로 설치하거나 설치 안내를 확인하세요.",
  guide: "플러그인 설치 안내",
  installSsh: "SSH로 설치하기",
  ready: "플러그인 연결 확인 완료",
  pluginAbsent: "플러그인 미설치",
  disabled: "플러그인 비활성화",
  pending: "서비스 재시작 필요",
  unauthorized: "인증 키를 확인하세요. 인증 실패는 플러그인 미설치를 의미하지 않습니다.",
  unreachable: "게이트웨이에 연결할 수 없습니다. 서비스와 네트워크를 확인하세요.",
  unknown: "플러그인 상태를 확인하지 못했습니다.",
  permission: "호스트 설정 권한이 없습니다. 관리자 설정을 확인하세요.",
  busy: "이 대상의 설정 작업이 이미 진행 중입니다. 잠시 후 다시 확인하세요.",
  invalid: "입력한 주소와 연결 대상을 확인하세요.",
  hostKey: "SSH 호스트 신원을 확인할 수 없습니다. 관리자가 알려진 호스트 정보를 확인해야 합니다.",
  inspecting: "설치 상태 확인",
  installing_plugin: "DeskRPG 플러그인 설치",
  enabling_plugin: "플러그인 활성화",
  configuring_api: "API 설정",
  restarting_gateway: "선택한 게이트웨이 서비스 시작 또는 재시작",
  verifying_gateway: "실제 API 및 플러그인 검증",
  importing_profiles: "프로필 가져오기",
  saving_gateway: "게이트웨이 저장",
  step: "설정 단계 진행",
  pluginRevision: "플러그인 고정 버전",
  installing_service: koText["hermes.wizard.step.installingService"],
  updating_plugin: koText["hermes.wizard.step.updatingPlugin"],
  setting_timezone: koText["hermes.wizard.step.settingTimezone"],
  setting_worker_propagation: koText["hermes.wizard.step.settingWorkerPropagation"],
  applying_worker_plugin: koText["hermes.wizard.step.applyingWorkerPlugin"],
  setting_port: koText["hermes.wizard.step.settingPort"],
  pluginVersion: koText["hermes.wizard.review.pluginVersion"],
  reviewTimezoneToggle: koText["hermes.wizard.review.timezoneToggle"],
  installing_hermes: koText["hermes.wizard.step.installingHermes"],
  creating_profile: koText["hermes.wizard.step.creatingProfile"],
  provisioning_keys: koText["hermes.wizard.step.provisioningKeys"],
  checking_model: koText["hermes.wizard.step.checkingModel"],
};
type Copy = typeof ko;
const en: Copy = {
  title: "Connect a Hermes gateway",
  selectProfiles: "Existing profiles to import",
  selectedProfiles: "Selected profiles",
  profileNeedsToken: "Configure an API credential before importing this profile.",
  profileProvisionToken: "An API credential will be created during connection.",
  noSelectedProfiles:
    "No profiles selected. The gateway will connect; register profiles separately afterward.",
  intro: "Where is Hermes running?",
  local: "Local connection",
  remote: "Remote connection",
  localHelp:
    "Local means the host running the DeskRPG server, which may differ from this browser’s computer.",
  remoteHelp: "Connect to Hermes on another server.",
  unavailable:
    "Host access is unavailable on this instance. Ask an administrator to enable host setup, or connect by gateway address.",
  ssh: "Connect over SSH",
  url: "Connect by gateway address",
  sshHelp:
    "Find Hermes on a registered SSH host. Register hosts with your SSH config (~/.ssh/config, ssh-agent) or a DeskRPG key.",
  urlHelp: "Use an existing address and API credential.",
  host: "SSH host",
  chooseHost: "Choose a host",
  discover: "Find installations",
  discovering: "Looking for Hermes installations…",
  empty: "No Hermes installations were found.",
  inspect: "Connect",
  startAndConnect: "Start and connect",
  stateRunning: "Running",
  stateStopped: "Stopped — connecting will start the gateway",
  stateProfileGateways:
    "Profile gateways are running separately. Stop these services, then search again:",
  profilesIncluded: "Profiles",
  noProfiles: "No extra profiles",
  review: "Review setup",
  service: "Target gateway service",
  changes: "Planned changes",
  noChanges: "Verify the connection without changing settings.",
  prepare: "Install and connect",
  verify: "Verify and connect",
  back: "Back",
  retry: "Check again",
  cancel: "Cancel",
  cancelling: "Waiting for the current operation to finish safely…",
  cancelHelp:
    "Cancellation stops before the next step after the current operation finishes safely. Completed installations or settings are not undone.",
  running: "Preparing gateway",
  failed: "Could not complete the connection.",
  cancelled: "Setup was cancelled.",
  connected: "Gateway connected.",
  profiles: "View profiles",
  name: "Display name",
  address: "Gateway address",
  token: "API credential",
  connect: "Connect address",
  loading: "Checking…",
  absent:
    "The API connection is saved, but it is not ready because the DeskRPG plugin is missing. Install over SSH or follow the installation guide.",
  guide: "Plugin installation guide",
  installSsh: "Install over SSH",
  ready: "Plugin connection verified",
  pluginAbsent: "Plugin not installed",
  disabled: "Plugin disabled",
  pending: "Service restart needed",
  unauthorized:
    "Check the API credential. Authentication failure does not mean the plugin is missing.",
  unreachable: "Cannot reach the gateway. Check its service and network.",
  unknown: "Could not determine plugin status.",
  permission: "Host setup is not permitted. Check administrator settings.",
  busy: "Setup is already running for this target. Check again shortly.",
  invalid: "Check the address and selected target.",
  hostKey: "SSH host identity could not be verified. Ask the administrator to check known hosts.",
  inspecting: "Inspect installation",
  installing_plugin: "Install DeskRPG plugin",
  enabling_plugin: "Enable plugin",
  configuring_api: "Configure API",
  restarting_gateway: "Start or restart the selected gateway service",
  verifying_gateway: "Verify live API and plugin",
  importing_profiles: "Import profiles",
  saving_gateway: "Save gateway",
  step: "Setup step in progress",
  pluginRevision: "Pinned plugin revision",
  installing_service: enText["hermes.wizard.step.installingService"],
  updating_plugin: enText["hermes.wizard.step.updatingPlugin"],
  setting_timezone: enText["hermes.wizard.step.settingTimezone"],
  setting_worker_propagation: enText["hermes.wizard.step.settingWorkerPropagation"],
  applying_worker_plugin: enText["hermes.wizard.step.applyingWorkerPlugin"],
  setting_port: enText["hermes.wizard.step.settingPort"],
  pluginVersion: enText["hermes.wizard.review.pluginVersion"],
  reviewTimezoneToggle: enText["hermes.wizard.review.timezoneToggle"],
  installing_hermes: enText["hermes.wizard.step.installingHermes"],
  creating_profile: enText["hermes.wizard.step.creatingProfile"],
  provisioning_keys: enText["hermes.wizard.step.provisioningKeys"],
  checking_model: enText["hermes.wizard.step.checkingModel"],
};
const ja: Copy = {
  ...en,
  title: "Hermesゲートウェイ接続",
  intro: "Hermesの実行場所を選択してください。",
  local: "ローカル接続",
  remote: "リモート接続",
  localHelp: "ローカルとはブラウザーのPCではなく、DeskRPGサーバーが動作するホストです。",
  ssh: "SSHで接続",
  url: "ゲートウェイURLで接続",
  prepare: "インストールして接続",
  back: "戻る",
  retry: "再確認",
  cancel: "キャンセル",
  profiles: "プロファイルを確認",
  connected: "ゲートウェイに接続しました。",
};
const zh: Copy = {
  ...en,
  title: "连接Hermes网关",
  intro: "请选择Hermes运行的位置。",
  local: "本地连接",
  remote: "远程连接",
  localHelp: "本地是指运行DeskRPG服务器的主机，而非浏览器所在的电脑。",
  ssh: "通过SSH连接",
  url: "通过网关地址连接",
  prepare: "安装并连接",
  back: "返回",
  retry: "重新检查",
  cancel: "取消",
  profiles: "查看配置文件",
  connected: "网关已连接。",
};
Object.assign(ja, {
  selectProfiles: "取得する既存のプロファイル",
  selectedProfiles: "選択したプロファイル",
  profileNeedsToken: "取得するには、先にAPI認証キーを設定してください。",
  profileProvisionToken: "接続中にAPI認証キーを生成します。",
  noSelectedProfiles:
    "プロファイルが選択されていません。ゲートウェイ接続後にプロファイルを別途登録してください。",
  remoteHelp: "別のサーバーのHermesに接続します。",
  unavailable:
    "この環境ではホストにアクセスできません。管理者にホスト設定を依頼するか、ゲートウェイURLで接続してください。",
  sshHelp:
    "登録したSSHホストでHermesを探します。自分のSSH設定（~/.ssh/config・ssh-agent）またはDeskRPG専用キーでホストを登録できます。",
  urlHelp: "既存のURLとAPI認証キーで接続します。",
  host: "SSHホスト",
  chooseHost: "ホストを選択",
  discover: "インストールを検索",
  discovering: "Hermesのインストールを確認中…",
  empty: "Hermesのインストールが見つかりません。",
  inspect: "接続",
  startAndConnect: "起動して接続",
  stateRunning: "実行中",
  stateStopped: "停止中 — 接続するとゲートウェイを起動します",
  stateProfileGateways:
    "プロファイルのゲートウェイが別に実行中です。次のサービスを停止してから再検索してください:",
  profilesIncluded: "含まれるプロファイル",
  noProfiles: "追加プロファイルなし",
  review: "設定内容の確認",
  service: "対象ゲートウェイサービス",
  changes: "予定される変更",
  noChanges: "設定を変更せずに接続を検証します。",
  verify: "検証して接続",
  cancelling: "現在の処理が安全に完了するのを待っています…",
  cancelHelp:
    "キャンセルすると現在の処理が安全に完了した後、次の処理を中止します。完了済みのインストールや設定は元に戻りません。",
  running: "ゲートウェイを準備中",
  failed: "接続を完了できませんでした。",
  cancelled: "設定を中断しました。",
  name: "表示名",
  address: "ゲートウェイURL",
  token: "API認証キー",
  connect: "URLで接続",
  loading: "確認中…",
  absent:
    "API接続は保存済みですが、DeskRPGプラグインが未インストールのため準備が完了していません。SSHまたはガイドに従ってインストールしてください。",
  guide: "プラグインのインストールガイド",
  installSsh: "SSHでインストール",
  ready: "プラグイン接続を確認済み",
  pluginAbsent: "プラグイン未インストール",
  disabled: "プラグイン無効",
  pending: "サービスの再起動が必要",
  unauthorized: "API認証キーを確認してください。認証失敗はプラグインの不在を意味しません。",
  unreachable: "ゲートウェイに接続できません。サービスとネットワークを確認してください。",
  unknown: "プラグインの状態を確認できません。",
  permission: "ホストの設定権限がありません。管理者の設定を確認してください。",
  busy: "この対象の設定が進行中です。少し待って再確認してください。",
  invalid: "URLと接続先を確認してください。",
  hostKey: "SSHホストの身元を確認できません。管理者が既知のホスト情報を確認する必要があります。",
  inspecting: "インストール状態を確認",
  installing_plugin: "DeskRPGプラグインをインストール",
  enabling_plugin: "プラグインを有効化",
  configuring_api: "APIを設定",
  restarting_gateway: "選択したゲートウェイサービスを起動または再起動",
  verifying_gateway: "実際のAPIとプラグインを検証",
  importing_profiles: "プロファイルを取得",
  saving_gateway: "ゲートウェイを保存",
  step: "設定処理を実行中",
  pluginRevision: "固定プラグインリビジョン",
  installing_service: jaText["hermes.wizard.step.installingService"],
  updating_plugin: jaText["hermes.wizard.step.updatingPlugin"],
  setting_timezone: jaText["hermes.wizard.step.settingTimezone"],
  setting_worker_propagation: jaText["hermes.wizard.step.settingWorkerPropagation"],
  applying_worker_plugin: jaText["hermes.wizard.step.applyingWorkerPlugin"],
  setting_port: jaText["hermes.wizard.step.settingPort"],
  pluginVersion: jaText["hermes.wizard.review.pluginVersion"],
  reviewTimezoneToggle: jaText["hermes.wizard.review.timezoneToggle"],
  installing_hermes: jaText["hermes.wizard.step.installingHermes"],
  creating_profile: jaText["hermes.wizard.step.creatingProfile"],
  provisioning_keys: jaText["hermes.wizard.step.provisioningKeys"],
  checking_model: jaText["hermes.wizard.step.checkingModel"],
});
Object.assign(zh, {
  selectProfiles: "要导入的现有配置文件",
  selectedProfiles: "已选配置文件",
  profileNeedsToken: "导入此配置文件前，请先配置API凭据。",
  profileProvisionToken: "连接时将创建API凭据。",
  noSelectedProfiles: "未选择配置文件。网关将被连接；之后请单独注册配置文件。",
  remoteHelp: "连接其他服务器上的Hermes。",
  unavailable: "此实例不允许访问主机。请联系管理员启用主机设置，或通过网关地址连接。",
  sshHelp:
    "在已登记的SSH主机上查找Hermes。可使用自己的SSH配置（~/.ssh/config、ssh-agent）或DeskRPG专用密钥登记主机。",
  urlHelp: "使用现有地址和API凭据连接。",
  host: "SSH主机",
  chooseHost: "选择主机",
  discover: "查找安装",
  discovering: "正在检查Hermes安装…",
  empty: "未找到Hermes安装。",
  inspect: "连接",
  startAndConnect: "启动并连接",
  stateRunning: "运行中",
  stateStopped: "已停止 — 连接时将启动网关",
  stateProfileGateways: "配置文件网关正在单独运行。请停止以下服务后重新搜索：",
  profilesIncluded: "包含的配置文件",
  noProfiles: "没有其他配置文件",
  review: "确认安装设置",
  service: "目标网关服务",
  changes: "计划的更改",
  noChanges: "不修改设置，仅验证连接。",
  verify: "验证并连接",
  cancelling: "正在等待当前操作安全完成…",
  cancelHelp: "取消会在当前操作安全完成后停止后续步骤。已完成的安装或设置不会被撤销。",
  running: "正在准备网关",
  failed: "未能完成连接。",
  cancelled: "设置已取消。",
  name: "显示名称",
  address: "网关地址",
  token: "API凭据",
  connect: "连接地址",
  loading: "正在检查…",
  absent: "API连接已保存，但由于缺少DeskRPG插件，尚未准备就绪。请通过SSH安装或查看安装指南。",
  guide: "插件安装指南",
  installSsh: "通过SSH安装",
  ready: "插件连接已验证",
  pluginAbsent: "插件未安装",
  disabled: "插件已禁用",
  pending: "需要重启服务",
  unauthorized: "请检查API凭据。身份验证失败并不表示插件未安装。",
  unreachable: "无法连接网关。请检查服务和网络。",
  unknown: "无法确定插件状态。",
  permission: "没有主机设置权限。请检查管理员设置。",
  busy: "此目标的设置正在进行中。请稍后重试。",
  invalid: "请检查地址和所选目标。",
  hostKey: "无法验证SSH主机身份。请管理员检查已知主机信息。",
  inspecting: "检查安装状态",
  installing_plugin: "安装DeskRPG插件",
  enabling_plugin: "启用插件",
  configuring_api: "配置API",
  restarting_gateway: "启动或重启所选网关服务",
  verifying_gateway: "验证实际API和插件",
  importing_profiles: "导入配置文件",
  saving_gateway: "保存网关",
  step: "设置步骤进行中",
  pluginRevision: "固定插件版本",
  installing_service: zhText["hermes.wizard.step.installingService"],
  updating_plugin: zhText["hermes.wizard.step.updatingPlugin"],
  setting_timezone: zhText["hermes.wizard.step.settingTimezone"],
  setting_worker_propagation: zhText["hermes.wizard.step.settingWorkerPropagation"],
  applying_worker_plugin: zhText["hermes.wizard.step.applyingWorkerPlugin"],
  setting_port: zhText["hermes.wizard.step.settingPort"],
  pluginVersion: zhText["hermes.wizard.review.pluginVersion"],
  reviewTimezoneToggle: zhText["hermes.wizard.review.timezoneToggle"],
  installing_hermes: zhText["hermes.wizard.step.installingHermes"],
  creating_profile: zhText["hermes.wizard.step.creatingProfile"],
  provisioning_keys: zhText["hermes.wizard.step.provisioningKeys"],
  checking_model: zhText["hermes.wizard.step.checkingModel"],
});
export const setupCopy: Record<Locale, Copy> = { ko, en, ja, zh };
export function setupError(copy: Copy, code: unknown): string {
  if (typeof code !== "string") return copy.failed;
  if (/unauthorized/.test(code)) return copy.unauthorized;
  if (/host_key|host_identity|known_host/.test(code)) return copy.hostKey;
  if (/forbidden|bad_origin/.test(code)) return copy.permission;
  if (/busy/.test(code)) return copy.busy;
  if (/unreachable/.test(code)) return copy.unreachable;
  if (/invalid|not_hermes/.test(code)) return copy.invalid;
  return copy.failed;
}
export function setupStep(copy: Copy, code: string): string {
  const aliases: Record<string, keyof Copy> = {
    install_plugin: "installing_plugin",
    enable_plugin: "enabling_plugin",
    configure_api: "configuring_api",
    restart_gateway: "restarting_gateway",
    provision_api_key: "configuring_api",
    start_gateway: "restarting_gateway",
  };
  const key = aliases[code] ?? code;
  return Object.prototype.hasOwnProperty.call(copy, key) ? copy[key as keyof Copy] : copy.step;
}

// Browser-owned presentation codes only: never import the server host executor here.
const hostErrorGroups: Record<string, string> = {
  managed_service_required: "service",
  service_identity_ambiguous: "identity",
  service_identity_mismatch: "identity",
  listener_owner_required: "identity",
  listener_ownership_unverified: "identity",
  gateway_identity_unverified: "identity",
  candidate_changed: "identity",
  invalid_candidate: "identity",
  external_secret_provider: "secret",
  api_key_invalid: "credential",
  multiplex_override_present: "multiplex",
  multiplex_conflict: "multiplex",
  port_conflict: "port",
  plugin_identity_ambiguous: "pluginIdentity",
  plugin_install_failed: "install",
  plugin_security_review_required: "securityReview",
  plugin_source_unavailable: "sourceUnavailable",
  gateway_restart_failed: "restart",
  gateway_verification_failed: "verify",
  profile_verification_failed: "profile",
  profile_import_failed: "profile",
  host_operation_failed: "host",
  unsafe_host_path: "config",
  invalid_host_config: "config",
  hermes_not_found: "missing",
  ssh_unknown_host: "ssh",
  ssh_connection_failed: "ssh",
  ssh_auth_failed: "sshAuth",
  hermes_version_unsupported: "hermesVersion",
  plugin_update_failed: "pluginUpdate",
  plugin_update_unsupported_host: "pluginUpdateHost",
  plugin_update_candidate_not_found: "pluginUpdateCandidate",
  service_install_failed: "serviceInstall",
  windows_scheduled_task_missing: "windowsTask",
  host_output_too_large: "outputTooLarge",
  host_spill_cleanup_failed: "spillCleanup",
  timezone_invalid: "timezoneInvalid",
  timezone_write_failed: "timezoneWrite",
  worker_propagation_write_failed: "workerPropagationWrite",
  port_write_failed: "portWrite",
  command_timeout: "timeout",
  output_limit: "host",
  profile_name_invalid: "profileName",
  profile_exists: "profileExists",
  profile_create_failed: "profileCreate",
  profile_key_failed: "profileKey",
  profile_provision_forbidden: "profileProvision",
  profile_verify_failed: "profileVerify",
  hermes_already_installed: "hermesInstalled",
  hermes_install_forbidden: "hermesInstallForbidden",
  hermes_install_failed: "hermesInstallFailed",
  curl_missing: "curlMissing",
  system_packages_missing: "systemPackages",
  git_missing: "gitMissing",
  python_bootstrap_failed: "pythonBootstrap",
  hermes_installer_unavailable: "hermesInstaller",
  resume_unavailable: "resumeUnavailable",
};
const hostRemediation: Record<Locale, Record<string, string>> = {
  ko: {
    sshAuth:
      "서버에 닿았지만 DeskRPG 키가 거절됐습니다. 1단계의 공개키 명령을 연결할 서버에서, 등록한 사용자 계정으로 실행했는지 확인하세요(~/.ssh/authorized_keys). 등록 화면은 '+ 새 SSH 호스트 등록' 에서 다시 볼 수 있습니다.",
    securityReview:
      "Hermes 보안 스캔이 설치를 차단했습니다. 관리자가 해당 버전의 검사 결과와 코드를 검토해야 합니다. 이 마법사는 차단을 자동 해제하지 않습니다.",
    sourceUnavailable:
      "플러그인 배포 저장소에 접근할 수 없습니다. 관리자가 배포 주소와 네트워크 접근을 확인해야 합니다.",
    service:
      "관리되는 게이트웨이 서비스를 찾지 못했습니다. 관리자가 Hermes 서비스를 등록하고 실행 상태를 확인한 뒤 다시 확인하세요.",
    identity:
      "선택한 설치와 실행 중인 게이트웨이의 소유 관계를 확인할 수 없습니다. 관리자가 서비스의 Hermes 경로·프로필·API 포트를 확인한 뒤 설치를 다시 검색하세요.",
    secret:
      "외부 비밀 관리자가 API 인증 키를 관리합니다. 해당 관리자에서 키를 설정한 뒤 다시 확인하세요. 이 화면에서는 기존 비밀 제공자 설정을 덮어쓰지 않습니다.",
    credential:
      "호스트의 API 인증 키가 유효하지 않습니다. 관리자가 Hermes 인증 설정을 수정한 뒤 다시 확인하세요.",
    multiplex:
      "프로필의 API 포트 설정과 게이트웨이 multiplex 설정이 충돌합니다. 관리자가 리스너 소유 프로필과 프로필별 포트 설정을 정리한 뒤 다시 확인하세요.",
    port: "선택한 API 포트를 다른 프로세스가 사용 중입니다. 관리자가 포트 사용자를 확인하고 Hermes 포트 충돌을 해결한 뒤 다시 확인하세요.",
    pluginIdentity:
      "DeskRPG 플러그인 설치를 하나로 식별할 수 없습니다. 관리자가 중복되거나 다른 출처의 플러그인을 확인한 뒤 다시 시도하세요.",
    install:
      "플러그인을 설치하지 못했습니다. 관리자가 호스트의 네트워크와 설치 권한을 확인한 뒤 다시 확인하세요.",
    restart:
      "선택한 게이트웨이 서비스를 시작하거나 재시작하지 못했습니다. 관리자가 해당 서비스의 상태와 로그를 확인한 뒤 다시 확인하세요.",
    verify:
      "설정 후 실제 게이트웨이 API 또는 플러그인을 검증하지 못했습니다. 관리자가 서비스와 API 인증 상태를 확인한 뒤 다시 확인하세요.",
    profile:
      "게이트웨이 프로필의 인증 또는 가져오기를 완료하지 못했습니다. 관리자가 프로필별 API 인증 설정을 확인한 뒤 다시 시도하세요.",
    host: "호스트 작업을 완료하지 못했습니다. 관리자가 호스트 상태와 설정을 확인한 뒤 다시 시도하세요.",
    config:
      "안전하게 사용할 수 없는 호스트 경로나 설정이 발견되었습니다. 관리자가 Hermes 설치 경로·파일 권한·설정 형식을 확인해야 합니다.",
    missing:
      "Hermes 실행 파일을 찾지 못했습니다. 관리자가 해당 호스트의 Hermes 설치와 실행 경로를 확인한 뒤 다시 검색하세요.",
    ssh: "허용된 SSH 호스트에 연결할 수 없습니다. 관리자가 호스트 별칭·네트워크·키 인증을 확인한 뒤 다시 시도하세요.",
    timeout:
      "호스트 작업 시간이 초과되었습니다. 관리자가 호스트와 네트워크 상태를 확인한 뒤 다시 시도하세요.",
    hermesVersion: koText["hermes.wizard.error.hermesVersionUnsupported"],
    pluginUpdate: koText["hermes.wizard.error.pluginUpdateFailed"],
    pluginUpdateHost: koText["hermes.wizard.error.pluginUpdateUnsupportedHost"],
    pluginUpdateCandidate: koText["hermes.wizard.error.pluginUpdateCandidateNotFound"],
    serviceInstall: koText["hermes.wizard.error.serviceInstallFailed"],
    windowsTask: koText["hermes.wizard.error.windowsScheduledTaskMissing"],
    outputTooLarge: koText["hermes.wizard.error.hostOutputTooLarge"],
    spillCleanup: koText["hermes.wizard.error.hostSpillCleanupFailed"],
    timezoneInvalid: koText["hermes.wizard.error.timezoneInvalid"],
    timezoneWrite: koText["hermes.wizard.error.timezoneWriteFailed"],
    workerPropagationWrite: koText["hermes.wizard.error.workerPropagationWriteFailed"],
    portWrite: koText["hermes.wizard.error.portWriteFailed"],
    profileName: koText["hermes.wizard.error.profileNameInvalid"],
    profileExists: koText["hermes.wizard.error.profileExists"],
    profileCreate: koText["hermes.wizard.error.profileCreateFailed"],
    profileKey: koText["hermes.wizard.error.profileKeyFailed"],
    profileProvision: koText["hermes.wizard.error.profileProvisionForbidden"],
    profileVerify: koText["hermes.wizard.error.profileVerifyFailed"],
    hermesInstalled: koText["hermes.wizard.error.hermesAlreadyInstalled"],
    hermesInstallForbidden: koText["hermes.wizard.error.hermesInstallForbidden"],
    hermesInstallFailed: koText["hermes.wizard.error.hermesInstallFailed"],
    curlMissing: koText["hermes.wizard.error.curlMissing"],
    systemPackages: koText["hermes.wizard.error.systemPackages"],
    gitMissing: koText["hermes.wizard.error.gitMissing"],
    pythonBootstrap: koText["hermes.wizard.error.pythonBootstrap"],
    hermesInstaller: koText["hermes.wizard.error.hermesInstallerUnavailable"],
    resumeUnavailable: koText["hermes.wizard.error.resumeUnavailable"],
  },
  en: {
    sshAuth:
      "The server was reached but DeskRPG's key was rejected. Make sure you ran step 1's public-key command on the target server, as the registered user (~/.ssh/authorized_keys). You can reopen it from '+ Register a new SSH host'.",
    securityReview:
      "Hermes security scanning blocked installation. An administrator must review the findings and code for this version. This wizard never overrides the block.",
    sourceUnavailable:
      "The plugin source repository is unavailable. Ask the administrator to verify the distribution URL and network access.",
    service:
      "No managed gateway service was found. Ask the administrator to register the Hermes service and check its state, then check again.",
    identity:
      "The selected installation cannot be matched safely to the running gateway. Ask the administrator to check its Hermes path, profile and API port, then discover installations again.",
    secret:
      "An external secret provider manages the API credential. Configure the credential through that provider, then check again. Existing provider settings will be preserved.",
    credential:
      "The host API credential is invalid. Ask the administrator to correct Hermes authentication settings, then check again.",
    multiplex:
      "Profile API port settings conflict with gateway multiplex settings. Ask the administrator to reconcile the listener-owner profile and profile port settings, then check again.",
    port: "Another process is using the selected API port. Ask the administrator to identify the listener and resolve the Hermes port conflict, then check again.",
    pluginIdentity:
      "The DeskRPG plugin installation is ambiguous. Ask the administrator to check duplicate plugins or plugins from other sources, then retry.",
    install:
      "Plugin installation failed. Ask the administrator to check host network access and installation permissions, then check again.",
    restart:
      "The selected gateway service could not start or restart. Ask the administrator to check that service’s status and logs, then check again.",
    verify:
      "The live gateway API or plugin could not be verified after setup. Ask the administrator to check the service and API authentication, then check again.",
    profile:
      "Profile authentication or import could not be completed. Ask the administrator to check profile-scoped API credentials, then retry.",
    host: "The host operation did not complete. Ask the administrator to check the host and its configuration, then retry.",
    config:
      "An unsafe host path or invalid configuration was found. Ask the administrator to check the Hermes installation path, file permissions and configuration format.",
    missing:
      "The Hermes executable was not found. Ask the administrator to check the host’s Hermes installation and executable path, then discover again.",
    ssh: "Cannot connect to the approved SSH host. Ask the administrator to check the alias, network and key authentication, then retry.",
    timeout:
      "The host operation timed out. Ask the administrator to check the host and network, then retry.",
    hermesVersion: enText["hermes.wizard.error.hermesVersionUnsupported"],
    pluginUpdate: enText["hermes.wizard.error.pluginUpdateFailed"],
    pluginUpdateHost: enText["hermes.wizard.error.pluginUpdateUnsupportedHost"],
    pluginUpdateCandidate: enText["hermes.wizard.error.pluginUpdateCandidateNotFound"],
    serviceInstall: enText["hermes.wizard.error.serviceInstallFailed"],
    windowsTask: enText["hermes.wizard.error.windowsScheduledTaskMissing"],
    outputTooLarge: enText["hermes.wizard.error.hostOutputTooLarge"],
    spillCleanup: enText["hermes.wizard.error.hostSpillCleanupFailed"],
    timezoneInvalid: enText["hermes.wizard.error.timezoneInvalid"],
    timezoneWrite: enText["hermes.wizard.error.timezoneWriteFailed"],
    workerPropagationWrite: enText["hermes.wizard.error.workerPropagationWriteFailed"],
    portWrite: enText["hermes.wizard.error.portWriteFailed"],
    profileName: enText["hermes.wizard.error.profileNameInvalid"],
    profileExists: enText["hermes.wizard.error.profileExists"],
    profileCreate: enText["hermes.wizard.error.profileCreateFailed"],
    profileKey: enText["hermes.wizard.error.profileKeyFailed"],
    profileProvision: enText["hermes.wizard.error.profileProvisionForbidden"],
    profileVerify: enText["hermes.wizard.error.profileVerifyFailed"],
    hermesInstalled: enText["hermes.wizard.error.hermesAlreadyInstalled"],
    hermesInstallForbidden: enText["hermes.wizard.error.hermesInstallForbidden"],
    hermesInstallFailed: enText["hermes.wizard.error.hermesInstallFailed"],
    curlMissing: enText["hermes.wizard.error.curlMissing"],
    systemPackages: enText["hermes.wizard.error.systemPackages"],
    gitMissing: enText["hermes.wizard.error.gitMissing"],
    pythonBootstrap: enText["hermes.wizard.error.pythonBootstrap"],
    hermesInstaller: enText["hermes.wizard.error.hermesInstallerUnavailable"],
    resumeUnavailable: enText["hermes.wizard.error.resumeUnavailable"],
  },
  ja: {
    sshAuth:
      "サーバーには届きましたが DeskRPG のキーが拒否されました。手順 1 の公開鍵コマンドを 接続先サーバーで、登録したユーザーとして 実行したか確認してください（~/.ssh/authorized_keys）。「+ 新しい SSH ホストを登録」から再表示できます。",
    securityReview:
      "Hermesのセキュリティ検査がインストールをブロックしました。管理者がこのバージョンの検査結果とコードを確認してください。このウィザードはブロックを解除しません。",
    sourceUnavailable:
      "プラグインの配布リポジトリにアクセスできません。管理者が配布URLとネットワークを確認してください。",
    service:
      "管理対象のゲートウェイサービスが見つかりません。管理者がHermesサービスを登録し、実行状態を確認してから再確認してください。",
    identity:
      "選択したインストールと実行中のゲートウェイの対応を確認できません。管理者がHermesのパス、プロファイル、APIポートを確認してから再検索してください。",
    secret:
      "外部シークレットプロバイダーがAPI認証キーを管理しています。そのプロバイダーでキーを設定してから再確認してください。既存のプロバイダー設定は維持されます。",
    credential:
      "ホストのAPI認証キーが無効です。管理者がHermes認証設定を修正してから再確認してください。",
    multiplex:
      "プロファイルのAPIポートとゲートウェイのmultiplex設定が競合しています。管理者がリスナー所有プロファイルとポート設定を確認してから再試行してください。",
    port: "別のプロセスが選択したAPIポートを使用しています。管理者がポートの使用者を確認し、競合を解決してから再確認してください。",
    pluginIdentity:
      "DeskRPGプラグインのインストールを特定できません。管理者が重複や別の配布元のプラグインを確認してから再試行してください。",
    install:
      "プラグインをインストールできませんでした。管理者がホストのネットワークとインストール権限を確認してから再試行してください。",
    restart:
      "選択したゲートウェイサービスを起動または再起動できません。管理者が該当サービスの状態とログを確認してから再試行してください。",
    verify:
      "設定後の実際のAPIまたはプラグインを検証できません。管理者がサービスとAPI認証を確認してから再試行してください。",
    profile:
      "プロファイルの認証または取得が完了していません。管理者がプロファイルごとのAPI認証設定を確認してから再試行してください。",
    host: "ホストの処理を完了できません。管理者がホストと設定を確認してから再試行してください。",
    config:
      "安全に使用できないパスまたは無効な設定が見つかりました。管理者がHermesのパス、ファイル権限、設定形式を確認してください。",
    missing:
      "Hermesの実行ファイルが見つかりません。管理者がインストールと実行パスを確認してから再検索してください。",
    ssh: "許可されたSSHホストに接続できません。管理者がホスト別名、ネットワーク、鍵認証を確認してから再試行してください。",
    timeout:
      "ホスト処理がタイムアウトしました。管理者がホストとネットワークを確認してから再試行してください。",
    hermesVersion: jaText["hermes.wizard.error.hermesVersionUnsupported"],
    pluginUpdate: jaText["hermes.wizard.error.pluginUpdateFailed"],
    pluginUpdateHost: jaText["hermes.wizard.error.pluginUpdateUnsupportedHost"],
    pluginUpdateCandidate: jaText["hermes.wizard.error.pluginUpdateCandidateNotFound"],
    serviceInstall: jaText["hermes.wizard.error.serviceInstallFailed"],
    windowsTask: jaText["hermes.wizard.error.windowsScheduledTaskMissing"],
    outputTooLarge: jaText["hermes.wizard.error.hostOutputTooLarge"],
    spillCleanup: jaText["hermes.wizard.error.hostSpillCleanupFailed"],
    timezoneInvalid: jaText["hermes.wizard.error.timezoneInvalid"],
    timezoneWrite: jaText["hermes.wizard.error.timezoneWriteFailed"],
    workerPropagationWrite: jaText["hermes.wizard.error.workerPropagationWriteFailed"],
    portWrite: jaText["hermes.wizard.error.portWriteFailed"],
    profileName: jaText["hermes.wizard.error.profileNameInvalid"],
    profileExists: jaText["hermes.wizard.error.profileExists"],
    profileCreate: jaText["hermes.wizard.error.profileCreateFailed"],
    profileKey: jaText["hermes.wizard.error.profileKeyFailed"],
    profileProvision: jaText["hermes.wizard.error.profileProvisionForbidden"],
    profileVerify: jaText["hermes.wizard.error.profileVerifyFailed"],
    hermesInstalled: jaText["hermes.wizard.error.hermesAlreadyInstalled"],
    hermesInstallForbidden: jaText["hermes.wizard.error.hermesInstallForbidden"],
    hermesInstallFailed: jaText["hermes.wizard.error.hermesInstallFailed"],
    curlMissing: jaText["hermes.wizard.error.curlMissing"],
    systemPackages: jaText["hermes.wizard.error.systemPackages"],
    gitMissing: jaText["hermes.wizard.error.gitMissing"],
    pythonBootstrap: jaText["hermes.wizard.error.pythonBootstrap"],
    hermesInstaller: jaText["hermes.wizard.error.hermesInstallerUnavailable"],
    resumeUnavailable: jaText["hermes.wizard.error.resumeUnavailable"],
  },
  zh: {
    sshAuth:
      "已连接到服务器，但 DeskRPG 的密钥被拒绝。请确认已在目标服务器上、以注册的用户身份运行第 1 步的公钥命令（~/.ssh/authorized_keys）。可从「+ 注册新的 SSH 主机」重新打开。",
    securityReview:
      "Hermes安全扫描阻止了安装。管理员需要审查此版本的扫描结果和代码。此向导不会自动绕过阻止。",
    sourceUnavailable: "无法访问插件源仓库。请管理员检查分发地址和网络访问。",
    service: "未找到受管理的网关服务。请管理员注册Hermes服务并检查运行状态，然后重新检查。",
    identity:
      "无法安全确认所选安装与运行中网关的对应关系。请管理员检查Hermes路径、配置文件和API端口，然后重新搜索安装。",
    secret:
      "API凭据由外部密钥提供程序管理。请通过该提供程序配置凭据，然后重新检查。现有提供程序设置将被保留。",
    credential: "主机API凭据无效。请管理员修正Hermes身份验证设置，然后重新检查。",
    multiplex:
      "配置文件的API端口与网关multiplex设置冲突。请管理员调整监听器所属配置文件和各配置文件端口，然后重新检查。",
    port: "其他进程正在使用所选API端口。请管理员确认端口使用者并解决Hermes端口冲突，然后重新检查。",
    pluginIdentity:
      "无法唯一识别DeskRPG插件安装。请管理员检查重复插件或来自其他来源的插件，然后重试。",
    install: "插件安装失败。请管理员检查主机网络和安装权限，然后重新检查。",
    restart: "无法启动或重启所选网关服务。请管理员检查该服务的状态和日志，然后重新检查。",
    verify: "设置后无法验证实际网关API或插件。请管理员检查服务和API身份验证，然后重新检查。",
    profile: "无法完成配置文件身份验证或导入。请管理员检查各配置文件的API凭据，然后重试。",
    host: "主机操作未完成。请管理员检查主机及其配置，然后重试。",
    config: "发现不安全的主机路径或无效配置。请管理员检查Hermes安装路径、文件权限和配置格式。",
    missing: "未找到Hermes可执行文件。请管理员检查主机上的Hermes安装和执行路径，然后重新搜索。",
    ssh: "无法连接已批准的SSH主机。请管理员检查别名、网络和密钥身份验证，然后重试。",
    timeout: "主机操作超时。请管理员检查主机和网络，然后重试。",
    hermesVersion: zhText["hermes.wizard.error.hermesVersionUnsupported"],
    pluginUpdate: zhText["hermes.wizard.error.pluginUpdateFailed"],
    pluginUpdateHost: zhText["hermes.wizard.error.pluginUpdateUnsupportedHost"],
    pluginUpdateCandidate: zhText["hermes.wizard.error.pluginUpdateCandidateNotFound"],
    serviceInstall: zhText["hermes.wizard.error.serviceInstallFailed"],
    windowsTask: zhText["hermes.wizard.error.windowsScheduledTaskMissing"],
    outputTooLarge: zhText["hermes.wizard.error.hostOutputTooLarge"],
    spillCleanup: zhText["hermes.wizard.error.hostSpillCleanupFailed"],
    timezoneInvalid: zhText["hermes.wizard.error.timezoneInvalid"],
    timezoneWrite: zhText["hermes.wizard.error.timezoneWriteFailed"],
    workerPropagationWrite: zhText["hermes.wizard.error.workerPropagationWriteFailed"],
    portWrite: zhText["hermes.wizard.error.portWriteFailed"],
    profileName: zhText["hermes.wizard.error.profileNameInvalid"],
    profileExists: zhText["hermes.wizard.error.profileExists"],
    profileCreate: zhText["hermes.wizard.error.profileCreateFailed"],
    profileKey: zhText["hermes.wizard.error.profileKeyFailed"],
    profileProvision: zhText["hermes.wizard.error.profileProvisionForbidden"],
    profileVerify: zhText["hermes.wizard.error.profileVerifyFailed"],
    hermesInstalled: zhText["hermes.wizard.error.hermesAlreadyInstalled"],
    hermesInstallForbidden: zhText["hermes.wizard.error.hermesInstallForbidden"],
    hermesInstallFailed: zhText["hermes.wizard.error.hermesInstallFailed"],
    curlMissing: zhText["hermes.wizard.error.curlMissing"],
    systemPackages: zhText["hermes.wizard.error.systemPackages"],
    gitMissing: zhText["hermes.wizard.error.gitMissing"],
    pythonBootstrap: zhText["hermes.wizard.error.pythonBootstrap"],
    hermesInstaller: zhText["hermes.wizard.error.hermesInstallerUnavailable"],
    resumeUnavailable: zhText["hermes.wizard.error.resumeUnavailable"],
  },
};
export function setupHostError(locale: Locale, code: unknown): string | undefined {
  return typeof code === "string" ? hostRemediation[locale][hostErrorGroups[code]] : undefined;
}
/**
 * A warning that persists even when the job succeeds — not mixed with error guidance since it isn't a failure.
 * A code not listed here is never rendered (prevents leaking a raw code).
 */
const warningKeys: Record<string, string> = {
  profile_not_served: "hermes.wizard.warn.profileNotServed",
  model_provider_required: "hermes.wizard.warn.modelProviderRequired",
  linger_required: "hermes.wizard.warn.lingerRequired",
  logon_required: "hermes.wizard.warn.logonRequired",
  worker_plugin_apply_failed: "hermes.wizard.warn.workerPluginApplyFailed",
};
export function setupWarning(locale: Locale, code: unknown): string | undefined {
  if (typeof code !== "string") return undefined;
  const key = warningKeys[code];
  if (!key) return undefined;
  const text = { ko: koText, en: enText, ja: jaText, zh: zhText }[locale];
  return text[key as keyof typeof text] ?? enText[key as keyof typeof enText];
}

/**
 * Install milestone code → text. Per the contract, the host only sends codes agreed on in
 * advance, so an unknown code returns undefined and renders nothing (prevents leaking raw output).
 */
const progressKeys: Record<string, string> = {
  deps: "hermes.wizard.progress.deps",
  clone: "hermes.wizard.progress.clone",
  venv: "hermes.wizard.progress.venv",
  node_modules: "hermes.wizard.progress.node_modules",
  skills: "hermes.wizard.progress.skills",
  done: "hermes.wizard.progress.done",
};
export function setupProgress(locale: Locale, code: unknown): string | undefined {
  if (typeof code !== "string") return undefined;
  const key = progressKeys[code];
  if (!key) return undefined;
  const text = { ko: koText, en: enText, ja: jaText, zh: zhText }[locale];
  return text[key as keyof typeof text] ?? enText[key as keyof typeof enText];
}

const repairableWarnings = new Set([
  "gateway_unreachable",
  "api_key_missing",
  "plugin_pending_restart",
  "pending_restart",
  "plugin_disabled",
  "plugin_absent",
]);
export function isSetupWarningBlocking(code: string | undefined): boolean {
  return !!code && !repairableWarnings.has(code);
}
