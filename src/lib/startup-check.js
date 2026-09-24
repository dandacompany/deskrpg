// Environment validation at startup/diagnostic time. Shared by server.js (custom server)
// and bin/deskrpg.js (doctor). Same CommonJS format as internal-transport.js, so it loads via both `require` and `import`.
//
// Principle: never put a secret value itself in a message. Only say whether it exists and how long it is.

const POSTGRES_DB_TYPES = new Set(["postgresql", "postgres"]);
const DEFAULT_DB_PROBE_TIMEOUT_MS = 5000;

function readTrimmed(env, key) {
  const value = env[key];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Splits environment-variable-only checks into problems that must block startup
 * (errors) and problems that should just be surfaced (warnings).
 * A pure function — it never reads or writes process.env (only receives it as a default).
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ errors: string[], warnings: string[], dbTarget: "postgresql" | "sqlite" }}
 */
/**
 * Returns one line if this machine has no Hermes. Says nothing if Hermes is present.
 *
 * Since 2026-09-19, host setup is open to admins by default — mentions that it can be
 * installed from the connection wizard's "Local connection". If the operator has turned
 * the switch off (`0`), mentions the command to turn it back on.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [homeDir]
 * @returns {string | null}
 */
function hostSetupHint(env = process.env, homeDir = require("node:os").homedir()) {
  const fs = require("node:fs");
  const path = require("node:path");
  const off = (key) => ["0", "false", "no", "off"].includes((env[key] ?? "").trim().toLowerCase());
  try {
    if (fs.existsSync(path.join(homeDir, ".hermes", "hermes-agent"))) return null;
    // The combined image (deskrpg-office) bundles Hermes in the same container and points
    // to it via HERMES_HOME. Checking only `.hermes` under home would wrongly report
    // "no Hermes" in that environment (confirmed: container boot logs).
    const hermesHome = (env.HERMES_HOME ?? "").trim();
    if (hermesHome && fs.existsSync(hermesHome)) return null;
    // Also, if hermes is on PATH, it's already installed.
    const pathDirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
    if (pathDirs.some((dir) => fs.existsSync(path.join(dir, "hermes")))) return null;
  } catch {
    return null;
  }
  if (off("DESKRPG_HOST_SETUP_ENABLED") || off("DESKRPG_HERMES_INSTALL_ENABLED"))
    return "이 컴퓨터에 Hermes 가 없습니다 — 연결 마법사로 함께 설치하려면 `deskrpg host-setup on --with-install` 을 실행한 뒤 다시 시작하세요.";
  return "이 컴퓨터에 Hermes 가 없습니다 — 관리자 계정으로 연결 → 새 게이트웨이 → 로컬 연결에서 설치할 수 있습니다.";
}

const { isPlaceholderSecret } = require("./runtime-paths.js");

function inspectEnvironment(env = process.env) {
  const errors = [];
  const warnings = [];

  const nodeEnv = readTrimmed(env, "NODE_ENV");
  const isProduction = nodeEnv === "production";
  const dbTypeRaw = readTrimmed(env, "DB_TYPE").toLowerCase();
  const databaseUrl = readTrimmed(env, "DATABASE_URL");
  const jwtSecret = readTrimmed(env, "JWT_SECRET");
  const internalRpcSecret = readTrimmed(env, "INTERNAL_RPC_SECRET");

  // Uses the same rule as src/db/index.ts: DB_TYPE || (DATABASE_URL ? postgresql : sqlite)
  const effectiveDbType = dbTypeRaw || (databaseUrl ? "postgresql" : "sqlite");
  const dbTarget = POSTGRES_DB_TYPES.has(effectiveDbType) ? "postgresql" : "sqlite";

  // The placeholder text copied straight from `.env.example` isn't a secret. Signing
  // session tokens with a public value would let anyone forge someone else's session,
  // so this is blocked exactly like an empty value.
  const jwtIsPlaceholder = Boolean(jwtSecret) && isPlaceholderSecret(jwtSecret);
  if (!jwtSecret || jwtIsPlaceholder) {
    const what = jwtIsPlaceholder
      ? "JWT_SECRET 이 `.env.example` 의 자리표시자 그대로입니다"
      : "JWT_SECRET 이 비어 있습니다";
    if (isProduction) {
      errors.push(
        `${what} — 프로덕션에서 로그인 토큰을 서명할 수 없습니다. .env.local 에 충분히 긴 임의 문자열로 JWT_SECRET 을 설정한 뒤 다시 기동하세요(\`openssl rand -hex 32\`).`,
      );
    } else {
      warnings.push(
        `${what} — 개발 모드에서만 넘어갑니다. 배포 전에 .env.local 에 JWT_SECRET 을 설정하세요.`,
      );
    }
  }

  if (POSTGRES_DB_TYPES.has(dbTypeRaw) && !databaseUrl) {
    errors.push(
      `DB_TYPE=${dbTypeRaw} 로 지정됐는데 DATABASE_URL 이 없어 접속할 곳이 없습니다 — DATABASE_URL 을 채우거나 DB_TYPE 을 지우고 SQLite 로 동작시키세요.`,
    );
  }

  if (!databaseUrl && !dbTypeRaw) {
    warnings.push(
      "DATABASE_URL 도 DB_TYPE 도 없어 PostgreSQL 이 아니라 SQLite 로 동작합니다 — PostgreSQL 을 쓸 생각이었다면 DATABASE_URL 을 설정하세요.",
    );
  }

  if (!internalRpcSecret && jwtSecret) {
    warnings.push(
      `INTERNAL_RPC_SECRET 이 없어 내부 RPC 인증이 JWT_SECRET(${jwtSecret.length}자) 으로 대체됩니다 — 두 비밀을 분리하려면 INTERNAL_RPC_SECRET 을 따로 설정하세요.`,
    );
  }

  if (!internalRpcSecret && !jwtSecret) {
    warnings.push(
      "INTERNAL_RPC_SECRET 과 JWT_SECRET 이 모두 비어 내부 RPC 요청이 전부 403 으로 거부됩니다 — 둘 중 하나는 반드시 설정하세요.",
    );
  }

  return { errors, warnings, dbTarget };
}

/**
 * Turns an error into a single human-readable string. `pg` has a path that throws an
 * error with an empty message (confirmed: on connection failure only `(  )` was printed),
 * so this also checks code/name to avoid producing empty parentheses.
 */
function describeError(error) {
  if (!error) return "원인 불명";
  if (typeof error === "string") return error || "원인 불명";
  const message = typeof error.message === "string" ? error.message.trim() : "";
  if (message) return message;
  const code = typeof error.code === "string" ? error.code : "";
  const name = typeof error.name === "string" ? error.name : "";
  return code || name || "원인 불명";
}

async function probePostgres(databaseUrl, timeoutMs) {
  const { Client } = require("pg");
  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
    statement_timeout: timeoutMs,
  });

  let timer = null;
  try {
    await Promise.race([
      (async () => {
        await client.connect();
        await client.query("SELECT 1");
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${timeoutMs}ms 안에 응답이 없었습니다`)),
          timeoutMs,
        );
      }),
    ]);
    return {
      ok: true,
      target: "postgresql",
      message: "PostgreSQL 에 접속해 SELECT 1 을 확인했습니다.",
    };
  } catch (error) {
    return {
      ok: false,
      target: "postgresql",
      message: `PostgreSQL 에 접속하지 못했습니다(${describeError(error)}) — DATABASE_URL 의 호스트·포트·계정과 DB 기동 상태를 확인하세요.`,
    };
  } finally {
    if (timer) clearTimeout(timer);
    try {
      await client.end();
    } catch {
      // If it couldn't even connect, end() also fails — this doesn't affect the diagnostic result.
    }
  }
}

async function probeSqlite(sqlitePath) {
  const fs = require("node:fs");
  const path = require("node:path");

  if (!sqlitePath) {
    return {
      ok: false,
      target: "sqlite",
      message:
        "SQLite 파일 경로를 알 수 없습니다 — SQLITE_PATH 를 설정하거나 deskrpg init 를 먼저 실행하세요.",
    };
  }

  try {
    await fs.promises.access(sqlitePath, fs.constants.R_OK | fs.constants.W_OK);
    return {
      ok: true,
      target: "sqlite",
      message: `SQLite 파일을 읽고 쓸 수 있습니다: ${sqlitePath}`,
    };
  } catch {
    // The file not existing yet can be normal — if the parent directory is writable, it's created at boot.
    try {
      await fs.promises.access(path.dirname(sqlitePath), fs.constants.W_OK);
      return {
        ok: true,
        target: "sqlite",
        message: `SQLite 파일이 아직 없지만 기동 시 생성됩니다: ${sqlitePath}`,
      };
    } catch {
      return {
        ok: false,
        target: "sqlite",
        message: `SQLite 파일과 그 디렉터리에 접근할 수 없습니다: ${sqlitePath} — 경로와 권한을 확인하거나 deskrpg init 를 실행하세요.`,
      };
    }
  }
}

/**
 * Confirms the DB is actually reachable. Never throws — always returns a result object.
 *
 * @param {{ databaseUrl?: string, sqlitePath?: string, target?: "postgresql" | "sqlite", timeoutMs?: number }} options
 * @returns {Promise<{ ok: boolean, target: "postgresql" | "sqlite", message: string }>}
 */
async function checkDatabaseReachable(options = {}) {
  const { databaseUrl, sqlitePath, target, timeoutMs = DEFAULT_DB_PROBE_TIMEOUT_MS } = options;

  // Which DB to probe must match what the app actually uses. `deskrpg init` copies
  // .env.example, so a leftover PostgreSQL DATABASE_URL line stays even in a SQLite
  // runtime — deciding by URL presence alone would give a SQLite user a false
  // "PostgreSQL connection failed" diagnosis (confirmed).
  const resolved = target || (databaseUrl ? "postgresql" : "sqlite");

  try {
    if (resolved === "postgresql") {
      if (!databaseUrl) {
        return {
          ok: false,
          target: "postgresql",
          message:
            "DB_TYPE=postgresql 인데 DATABASE_URL 이 없어 접속할 곳이 없습니다 — DATABASE_URL 을 채우세요.",
        };
      }
      return await probePostgres(databaseUrl, timeoutMs);
    }
    return await probeSqlite(sqlitePath);
  } catch (error) {
    return {
      ok: false,
      target: resolved,
      message: `데이터베이스 확인 중 예상치 못한 오류가 났습니다(${describeError(error)}) — 드라이버 설치 상태를 확인하세요.`,
    };
  }
}

/**
 * Checks whether the port is already in use. { free: false } if it is.
 *
 * @param {number} port
 * @param {string} [host]
 * @returns {Promise<{ free: boolean, message: string }>}
 */
function checkPortAvailable(port, host = "0.0.0.0") {
  const net = require("node:net");

  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (error) => {
      if (error && error.code === "EADDRINUSE") {
        resolve({
          free: false,
          message: `포트 ${port} 을 이미 다른 프로세스가 쓰고 있습니다 — deskrpg stop 으로 멈추거나 deskrpg start -p 다른포트 로 띄우세요.`,
        });
        return;
      }
      const reason = error instanceof Error ? error.message : String(error);
      resolve({ free: true, message: `포트 ${port} 점유 여부를 확인하지 못했습니다(${reason}).` });
    });
    server.once("listening", () => {
      server.close(() => resolve({ free: true, message: `포트 ${port} 가 비어 있습니다.` }));
    });
    server.listen(port, host);
  });
}

/**
 * Prints the inspectEnvironment result as human-readable lines.
 *
 * @returns {boolean} false if there's even one error
 */
function reportEnvironmentInspection(inspection, logger = console) {
  for (const warning of inspection.warnings) {
    logger.warn(`[startup] 경고: ${warning}`);
  }
  for (const error of inspection.errors) {
    logger.error(`[startup] 실패: ${error}`);
  }
  return inspection.errors.length === 0;
}

module.exports = {
  DEFAULT_DB_PROBE_TIMEOUT_MS,
  checkDatabaseReachable,
  checkPortAvailable,
  hostSetupHint,
  inspectEnvironment,
  reportEnvironmentInspection,
};
