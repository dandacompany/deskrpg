// Pins the exact Korean startup-check output. Moving the strings into cli-messages.js must not change a byte
// for Korean-locale users.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const startupCheck = require("./startup-check.js");

const KO = { LANG: "ko_KR.UTF-8" };
const JWT = "x".repeat(32);
const RPC = "y".repeat(32);

function inspect(env) {
  return startupCheck.inspectEnvironment({ ...KO, ...env });
}

test("Korean environment inspection messages are unchanged", () => {
  assert.deepEqual(inspect({ NODE_ENV: "production", INTERNAL_RPC_SECRET: RPC }), {
    errors: [
      "JWT_SECRET 이 비어 있습니다 — 프로덕션에서 로그인 토큰을 서명할 수 없습니다. .env.local 에 충분히 긴 임의 문자열로 JWT_SECRET 을 설정한 뒤 다시 기동하세요(`openssl rand -hex 32`).",
    ],
    warnings: [
      "DATABASE_URL 도 DB_TYPE 도 없어 PostgreSQL 이 아니라 SQLite 로 동작합니다 — PostgreSQL 을 쓸 생각이었다면 DATABASE_URL 을 설정하세요.",
    ],
    dbTarget: "sqlite",
  });
  assert.deepEqual(
    inspect({
      NODE_ENV: "production",
      JWT_SECRET: "change-me-to-a-random-64-char-string",
      INTERNAL_RPC_SECRET: RPC,
      DATABASE_URL: "postgres://x",
    }).errors,
    [
      "JWT_SECRET 이 `.env.example` 의 자리표시자 그대로입니다 — 프로덕션에서 로그인 토큰을 서명할 수 없습니다. .env.local 에 충분히 긴 임의 문자열로 JWT_SECRET 을 설정한 뒤 다시 기동하세요(`openssl rand -hex 32`).",
    ],
  );
  assert.deepEqual(
    inspect({ DB_TYPE: "postgresql", JWT_SECRET: JWT, INTERNAL_RPC_SECRET: RPC }).errors,
    [
      "DB_TYPE=postgresql 로 지정됐는데 DATABASE_URL 이 없어 접속할 곳이 없습니다 — DATABASE_URL 을 채우거나 DB_TYPE 을 지우고 SQLite 로 동작시키세요.",
    ],
  );
  assert.deepEqual(inspect({ JWT_SECRET: JWT, DATABASE_URL: "postgres://x" }).warnings, [
    "INTERNAL_RPC_SECRET 이 없어 내부 RPC 인증이 JWT_SECRET(32자) 으로 대체됩니다 — 두 비밀을 분리하려면 INTERNAL_RPC_SECRET 을 따로 설정하세요.",
  ]);
  assert.deepEqual(inspect({ DATABASE_URL: "postgres://x" }).warnings, [
    "JWT_SECRET 이 비어 있습니다 — 개발 모드에서만 넘어갑니다. 배포 전에 .env.local 에 JWT_SECRET 을 설정하세요.",
    "INTERNAL_RPC_SECRET 과 JWT_SECRET 이 모두 비어 내부 RPC 요청이 전부 403 으로 거부됩니다 — 둘 중 하나는 반드시 설정하세요.",
  ]);
});

test("Korean Hermes install hints are unchanged", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "deskrpg-ko-hint-"));
  try {
    assert.equal(
      startupCheck.hostSetupHint({ ...KO, PATH: "" }, home),
      "이 컴퓨터에 Hermes 가 없습니다 — 관리자 계정으로 연결 → 새 게이트웨이 → 로컬 연결에서 설치할 수 있습니다.",
    );
    assert.equal(
      startupCheck.hostSetupHint({ ...KO, PATH: "", DESKRPG_HOST_SETUP_ENABLED: "0" }, home),
      "이 컴퓨터에 Hermes 가 없습니다 — 연결 마법사로 함께 설치하려면 `deskrpg host-setup on --with-install` 을 실행한 뒤 다시 시작하세요.",
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Korean database probe messages are unchanged", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deskrpg-ko-db-"));
  const existing = path.join(dir, "a.db");
  fs.writeFileSync(existing, "");
  const probe = (options) => startupCheck.checkDatabaseReachable({ ...options, env: KO });
  try {
    assert.equal(
      (await probe({ target: "postgresql" })).message,
      "DB_TYPE=postgresql 인데 DATABASE_URL 이 없어 접속할 곳이 없습니다 — DATABASE_URL 을 채우세요.",
    );
    assert.equal(
      (await probe({ target: "sqlite" })).message,
      "SQLite 파일 경로를 알 수 없습니다 — SQLITE_PATH 를 설정하거나 deskrpg init 를 먼저 실행하세요.",
    );
    assert.equal(
      (await probe({ sqlitePath: existing })).message,
      `SQLite 파일을 읽고 쓸 수 있습니다: ${existing}`,
    );
    const fresh = path.join(dir, "b.db");
    assert.equal(
      (await probe({ sqlitePath: fresh })).message,
      `SQLite 파일이 아직 없지만 기동 시 생성됩니다: ${fresh}`,
    );
    assert.equal(
      (await probe({ sqlitePath: "/definitely/missing/dir/deskrpg.db" })).message,
      "SQLite 파일과 그 디렉터리에 접근할 수 없습니다: /definitely/missing/dir/deskrpg.db — 경로와 권한을 확인하거나 deskrpg init 를 실행하세요.",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Korean port probe messages are unchanged", async () => {
  const net = require("node:net");
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const { port } = blocker.address();
  try {
    assert.deepEqual(await startupCheck.checkPortAvailable(port, "127.0.0.1", KO), {
      free: false,
      message: `포트 ${port} 을 이미 다른 프로세스가 쓰고 있습니다 — deskrpg stop 으로 멈추거나 deskrpg start -p 다른포트 로 띄우세요.`,
    });
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
  assert.deepEqual(await startupCheck.checkPortAvailable(port, "127.0.0.1", KO), {
    free: true,
    message: `포트 ${port} 가 비어 있습니다.`,
  });
});

test("Korean inspection report prefixes are unchanged", () => {
  const lines = [];
  const logger = { warn: (line) => lines.push(line), error: (line) => lines.push(line) };
  startupCheck.reportEnvironmentInspection({ warnings: ["W"], errors: ["E"] }, logger, KO);
  assert.deepEqual(lines, ["[startup] 경고: W", "[startup] 실패: E"]);
});
