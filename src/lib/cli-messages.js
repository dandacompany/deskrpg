"use strict";

/**
 * Messages the CLI, the startup check and the custom server print to a terminal.
 *
 * Plain CommonJS so `bin/deskrpg.js` and `server.js` can load it without TypeScript. The terminal's locale picks the
 * language (`LC_ALL` → `LC_MESSAGES` → `LANG`): Korean for `ko*`, English for everything else. `{name}` is replaced by
 * the matching parameter.
 */
const CLI_MESSAGES = {
  ko: {
    "hint.hermesMissing":
      "이 컴퓨터에 Hermes 가 없습니다 — 관리자 계정으로 연결 → 새 게이트웨이 → 로컬 연결에서 설치할 수 있습니다.",
    "hint.hermesMissingSwitchOff":
      "이 컴퓨터에 Hermes 가 없습니다 — 연결 마법사로 함께 설치하려면 `deskrpg host-setup on --with-install` 을 실행한 뒤 다시 시작하세요.",

    "env.jwtPlaceholder": "JWT_SECRET 이 `.env.example` 의 자리표시자 그대로입니다",
    "env.jwtEmpty": "JWT_SECRET 이 비어 있습니다",
    "env.jwtProduction":
      "{what} — 프로덕션에서 로그인 토큰을 서명할 수 없습니다. .env.local 에 충분히 긴 임의 문자열로 JWT_SECRET 을 설정한 뒤 다시 기동하세요(`openssl rand -hex 32`).",
    "env.jwtDevelopment":
      "{what} — 개발 모드에서만 넘어갑니다. 배포 전에 .env.local 에 JWT_SECRET 을 설정하세요.",
    "env.postgresWithoutUrl":
      "DB_TYPE={dbType} 로 지정됐는데 DATABASE_URL 이 없어 접속할 곳이 없습니다 — DATABASE_URL 을 채우거나 DB_TYPE 을 지우고 SQLite 로 동작시키세요.",
    "env.sqliteFallback":
      "DATABASE_URL 도 DB_TYPE 도 없어 PostgreSQL 이 아니라 SQLite 로 동작합니다 — PostgreSQL 을 쓸 생각이었다면 DATABASE_URL 을 설정하세요.",
    "env.rpcFallsBackToJwt":
      "INTERNAL_RPC_SECRET 이 없어 내부 RPC 인증이 JWT_SECRET({length}자) 으로 대체됩니다 — 두 비밀을 분리하려면 INTERNAL_RPC_SECRET 을 따로 설정하세요.",
    "env.rpcBothEmpty":
      "INTERNAL_RPC_SECRET 과 JWT_SECRET 이 모두 비어 내부 RPC 요청이 전부 403 으로 거부됩니다 — 둘 중 하나는 반드시 설정하세요.",

    "error.unknown": "원인 불명",

    "db.postgresTimeout": "{ms}ms 안에 응답이 없었습니다",
    "db.postgresOk": "PostgreSQL 에 접속해 SELECT 1 을 확인했습니다.",
    "db.postgresFailed":
      "PostgreSQL 에 접속하지 못했습니다({reason}) — DATABASE_URL 의 호스트·포트·계정과 DB 기동 상태를 확인하세요.",
    "db.postgresWithoutUrl":
      "DB_TYPE=postgresql 인데 DATABASE_URL 이 없어 접속할 곳이 없습니다 — DATABASE_URL 을 채우세요.",
    "db.sqliteNoPath":
      "SQLite 파일 경로를 알 수 없습니다 — SQLITE_PATH 를 설정하거나 deskrpg init 를 먼저 실행하세요.",
    "db.sqliteOk": "SQLite 파일을 읽고 쓸 수 있습니다: {path}",
    "db.sqliteCreatedAtBoot": "SQLite 파일이 아직 없지만 기동 시 생성됩니다: {path}",
    "db.sqliteInaccessible":
      "SQLite 파일과 그 디렉터리에 접근할 수 없습니다: {path} — 경로와 권한을 확인하거나 deskrpg init 를 실행하세요.",
    "db.unexpected":
      "데이터베이스 확인 중 예상치 못한 오류가 났습니다({reason}) — 드라이버 설치 상태를 확인하세요.",

    "port.inUse":
      "포트 {port} 을 이미 다른 프로세스가 쓰고 있습니다 — deskrpg stop 으로 멈추거나 deskrpg start -p 다른포트 로 띄우세요.",
    "port.unknown": "포트 {port} 점유 여부를 확인하지 못했습니다({reason}).",
    "port.free": "포트 {port} 가 비어 있습니다.",

    "report.warning": "[startup] 경고: {message}",
    "report.failure": "[startup] 실패: {message}",

    "server.environmentInvalid": "[startup] 환경 설정이 올바르지 않아 서버를 시작하지 않습니다.",
    "server.databaseOk": "[startup] DB({target}) 확인: {message}",
    "server.startFailed":
      "[startup] 서버를 시작하지 못했습니다 — 아래 스택의 첫 줄이 직접 원인입니다. `deskrpg doctor` 로 환경·DB·포트를 먼저 점검하세요.",

    "bootstrap.homeFailed": "[startup] 런타임 홈을 준비하지 못했습니다: {message}",
    "bootstrap.envReadFailed": "[startup] 런타임 env 를 읽지 못했습니다: {message}",

    "resetPassword.schemaMissing":
      "users.must_change_password 가 없습니다. 먼저 `deskrpg start` 로 한 번 부팅해 스키마를 올리세요.",

    "doctor.marker.ok": "OK  ",
    "doctor.marker.warn": "경고",
    "doctor.marker.fail": "실패",
    "doctor.runtimeInit": "런타임 초기화",
    "doctor.runtimeDirs": "런타임 디렉터리",
    "doctor.runtimeDirsOk": "data · uploads · logs 모두 있음",
    "doctor.build": "빌드 산출물",
    "doctor.buildOk": "필요한 런타임 파일이 모두 있음",
    "doctor.environment": "환경변수",
    "doctor.environmentOk": "문제 없음 (DB 대상: {target})",
    "doctor.hostSetup": "호스트 설정",
    "doctor.hostSetupOn": "관리자에게 켜짐{install}",
    "doctor.hermesInstallOn": " · Hermes 설치 켜짐",
    "doctor.hermesInstallOff": " · Hermes 설치는 꺼짐",
    "doctor.hostSetupOff": "운영자가 꺼 둠 — 다시 켜려면 deskrpg host-setup on --with-install",
    "doctor.database": "데이터베이스({target})",
    "doctor.port": "포트 {port}",
    "doctor.server": "DeskRPG 서버",
    "doctor.portOurs": "이 DeskRPG 서버가 쓰는 중입니다.",
    "server.running": "실행 중 (PID {pid}) — 포트 {port} 에서 응답합니다.",
    "server.notAnswering":
      "PID {pid} 는 살아 있지만 포트 {port} 에서 응답하지 않습니다 — 아직 켜지는 중이거나 다른 포트로 떴습니다.",
    "server.stalePid":
      "PID 파일(PID {pid})이 남아 있지만 서버가 꺼져 있습니다 — 띄운 셸과 함께 끝났을 수 있습니다. deskrpg start 로 다시 띄우세요.",
    "server.notRunning": "실행 중이 아닙니다.",
    "doctor.problemsFound":
      "DeskRPG 진단에서 문제를 찾았습니다. 위의 [실패] 항목을 먼저 해결하세요.",

    "hostSetup.on": "켜짐",
    "hostSetup.off": "꺼짐",
    "hostSetup.statusHost": "연결 마법사의 호스트 설정: {state}",
    "hostSetup.statusInstall": "이 컴퓨터에 Hermes 설치: {state}",
    "hostSetup.howToEnable":
      "\n켜려면: deskrpg host-setup on --with-install   (그 뒤 deskrpg 를 다시 시작)",
    "hostSetup.enabled": "연결 마법사의 호스트 설정을 켰습니다{install}.",
    "hostSetup.enabledWithInstall": " (Hermes 설치 포함)",
    "hostSetup.disabled": "호스트 설정과 Hermes 설치를 모두 껐습니다.",
    "hostSetup.restartToApply":
      "적용하려면 deskrpg 를 다시 시작하세요 — 이 값은 켤 때 한 번만 읽습니다.",
    "hostSetup.howToInstall":
      "이 컴퓨터에 Hermes 까지 설치하려면: deskrpg host-setup on --with-install",
  },
  en: {
    "hint.hermesMissing":
      "Hermes is not installed on this computer — sign in as an admin and install it from Connect → New gateway → Local connection.",
    "hint.hermesMissingSwitchOff":
      "Hermes is not installed on this computer — to install it with the connection wizard, run `deskrpg host-setup on --with-install` and restart.",

    "env.jwtPlaceholder": "JWT_SECRET is still the `.env.example` placeholder",
    "env.jwtEmpty": "JWT_SECRET is empty",
    "env.jwtProduction":
      "{what} — login tokens cannot be signed in production. Set JWT_SECRET in .env.local to a long random string and restart (`openssl rand -hex 32`).",
    "env.jwtDevelopment":
      "{what} — allowed in development mode only. Set JWT_SECRET in .env.local before deploying.",
    "env.postgresWithoutUrl":
      "DB_TYPE={dbType} is set but DATABASE_URL is missing, so there is nothing to connect to — set DATABASE_URL, or remove DB_TYPE to run on SQLite.",
    "env.sqliteFallback":
      "Neither DATABASE_URL nor DB_TYPE is set, so DeskRPG runs on SQLite instead of PostgreSQL — set DATABASE_URL if you meant to use PostgreSQL.",
    "env.rpcFallsBackToJwt":
      "INTERNAL_RPC_SECRET is missing, so internal RPC authentication falls back to JWT_SECRET ({length} chars) — set INTERNAL_RPC_SECRET separately to keep the two secrets apart.",
    "env.rpcBothEmpty":
      "INTERNAL_RPC_SECRET and JWT_SECRET are both empty, so every internal RPC request is rejected with 403 — set at least one of them.",

    "error.unknown": "unknown cause",

    "db.postgresTimeout": "no response within {ms}ms",
    "db.postgresOk": "Connected to PostgreSQL and confirmed SELECT 1.",
    "db.postgresFailed":
      "Could not connect to PostgreSQL ({reason}) — check the host, port and account in DATABASE_URL, and that the database is running.",
    "db.postgresWithoutUrl":
      "DB_TYPE=postgresql but DATABASE_URL is missing, so there is nothing to connect to — set DATABASE_URL.",
    "db.sqliteNoPath":
      "The SQLite file path is unknown — set SQLITE_PATH or run deskrpg init first.",
    "db.sqliteOk": "The SQLite file is readable and writable: {path}",
    "db.sqliteCreatedAtBoot":
      "The SQLite file does not exist yet but will be created at startup: {path}",
    "db.sqliteInaccessible":
      "Cannot access the SQLite file or its directory: {path} — check the path and permissions, or run deskrpg init.",
    "db.unexpected":
      "An unexpected error occurred while checking the database ({reason}) — check the driver installation.",

    "port.inUse":
      "Port {port} is already used by another process — stop it with deskrpg stop, or start on another port with deskrpg start -p <port>.",
    "port.unknown": "Could not check whether port {port} is in use ({reason}).",
    "port.free": "Port {port} is free.",

    "report.warning": "[startup] warning: {message}",
    "report.failure": "[startup] failure: {message}",

    "server.environmentInvalid":
      "[startup] The environment is misconfigured, so the server will not start.",
    "server.databaseOk": "[startup] DB ({target}) OK: {message}",
    "server.startFailed":
      "[startup] The server failed to start — the first line of the stack below is the direct cause. Check the environment, DB and port with `deskrpg doctor` first.",

    "bootstrap.homeFailed": "[startup] Could not prepare the runtime home: {message}",
    "bootstrap.envReadFailed": "[startup] Could not read the runtime env: {message}",

    "resetPassword.schemaMissing":
      "users.must_change_password does not exist. Boot once with `deskrpg start` first to upgrade the schema.",

    "doctor.marker.ok": "OK  ",
    "doctor.marker.warn": "WARN",
    "doctor.marker.fail": "FAIL",
    "doctor.runtimeInit": "Runtime initialized",
    "doctor.runtimeDirs": "Runtime directories",
    "doctor.runtimeDirsOk": "data · uploads · logs all present",
    "doctor.build": "Build output",
    "doctor.buildOk": "all required runtime files present",
    "doctor.environment": "Environment",
    "doctor.environmentOk": "no problems (DB target: {target})",
    "doctor.hostSetup": "Host setup",
    "doctor.hostSetupOn": "on for admins{install}",
    "doctor.hermesInstallOn": " · Hermes install on",
    "doctor.hermesInstallOff": " · Hermes install off",
    "doctor.hostSetupOff":
      "turned off by the operator — to turn it back on, run deskrpg host-setup on --with-install",
    "doctor.database": "Database ({target})",
    "doctor.port": "Port {port}",
    "doctor.server": "DeskRPG server",
    "doctor.portOurs": "In use by this DeskRPG server.",
    "server.running": "Running (PID {pid}) — answering on port {port}.",
    "server.notAnswering":
      "PID {pid} is alive but port {port} does not answer — it may still be starting, or it runs on another port.",
    "server.stalePid":
      "A PID file (PID {pid}) is left but the server is not running — it may have ended with the shell that started it. Start it again with deskrpg start.",
    "server.notRunning": "Not running.",
    "doctor.problemsFound": "DeskRPG doctor found problems. Fix the [FAIL] items above first.",

    "hostSetup.on": "on",
    "hostSetup.off": "off",
    "hostSetup.statusHost": "Connection wizard host setup: {state}",
    "hostSetup.statusInstall": "Hermes install on this computer: {state}",
    "hostSetup.howToEnable":
      "\nTo turn it on: deskrpg host-setup on --with-install   (then restart deskrpg)",
    "hostSetup.enabled": "Turned on the connection wizard host setup{install}.",
    "hostSetup.enabledWithInstall": " (including Hermes install)",
    "hostSetup.disabled": "Turned off both host setup and Hermes install.",
    "hostSetup.restartToApply":
      "Restart deskrpg to apply — this value is read only once at startup.",
    "hostSetup.howToInstall":
      "To also install Hermes on this computer: deskrpg host-setup on --with-install",
  },
};

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {"ko" | "en"}
 */
function cliLocale(env = process.env) {
  const raw = env.LC_ALL || env.LC_MESSAGES || env.LANG || "";
  return raw.toLowerCase().startsWith("ko") ? "ko" : "en";
}

/**
 * @param {string} key
 * @param {Record<string, string | number>} [params]
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
function cliMessage(key, params = {}, env = process.env) {
  const table = CLI_MESSAGES[cliLocale(env)];
  const text = table[key] ?? CLI_MESSAGES.en[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (placeholder, name) =>
    name in params ? String(params[name]) : placeholder,
  );
}

module.exports = { CLI_MESSAGES, cliLocale, cliMessage };
