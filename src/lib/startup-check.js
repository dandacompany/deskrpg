// Environment validation at startup/diagnostic time. Shared by server.js (custom server)
// and bin/deskrpg.js (doctor). Same CommonJS format as internal-transport.js, so it loads via both `require` and `import`.
//
// Principle: never put a secret value itself in a message. Only say whether it exists and how long it is.

const { cliMessage } = require("./cli-messages.js");

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
    return cliMessage("hint.hermesMissingSwitchOff", {}, env);
  return cliMessage("hint.hermesMissing", {}, env);
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
    const what = cliMessage(jwtIsPlaceholder ? "env.jwtPlaceholder" : "env.jwtEmpty", {}, env);
    if (isProduction) {
      errors.push(cliMessage("env.jwtProduction", { what }, env));
    } else {
      warnings.push(cliMessage("env.jwtDevelopment", { what }, env));
    }
  }

  if (POSTGRES_DB_TYPES.has(dbTypeRaw) && !databaseUrl) {
    errors.push(cliMessage("env.postgresWithoutUrl", { dbType: dbTypeRaw }, env));
  }

  if (!databaseUrl && !dbTypeRaw) {
    warnings.push(cliMessage("env.sqliteFallback", {}, env));
  }

  if (!internalRpcSecret && jwtSecret) {
    warnings.push(cliMessage("env.rpcFallsBackToJwt", { length: jwtSecret.length }, env));
  }

  if (!internalRpcSecret && !jwtSecret) {
    warnings.push(cliMessage("env.rpcBothEmpty", {}, env));
  }

  return { errors, warnings, dbTarget };
}

/**
 * Turns an error into a single human-readable string. `pg` has a path that throws an
 * error with an empty message (confirmed: on connection failure only `(  )` was printed),
 * so this also checks code/name to avoid producing empty parentheses.
 */
function describeError(error, env = process.env) {
  const unknown = cliMessage("error.unknown", {}, env);
  if (!error) return unknown;
  if (typeof error === "string") return error || unknown;
  const message = typeof error.message === "string" ? error.message.trim() : "";
  if (message) return message;
  const code = typeof error.code === "string" ? error.code : "";
  const name = typeof error.name === "string" ? error.name : "";
  return code || name || unknown;
}

async function probePostgres(databaseUrl, timeoutMs, env) {
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
          () => reject(new Error(cliMessage("db.postgresTimeout", { ms: timeoutMs }, env))),
          timeoutMs,
        );
      }),
    ]);
    return {
      ok: true,
      target: "postgresql",
      message: cliMessage("db.postgresOk", {}, env),
    };
  } catch (error) {
    return {
      ok: false,
      target: "postgresql",
      message: cliMessage("db.postgresFailed", { reason: describeError(error, env) }, env),
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

async function probeSqlite(sqlitePath, env) {
  const fs = require("node:fs");
  const path = require("node:path");

  if (!sqlitePath) {
    return {
      ok: false,
      target: "sqlite",
      message: cliMessage("db.sqliteNoPath", {}, env),
    };
  }

  try {
    await fs.promises.access(sqlitePath, fs.constants.R_OK | fs.constants.W_OK);
    return {
      ok: true,
      target: "sqlite",
      message: cliMessage("db.sqliteOk", { path: sqlitePath }, env),
    };
  } catch {
    // The file not existing yet can be normal — if the parent directory is writable, it's created at boot.
    try {
      await fs.promises.access(path.dirname(sqlitePath), fs.constants.W_OK);
      return {
        ok: true,
        target: "sqlite",
        message: cliMessage("db.sqliteCreatedAtBoot", { path: sqlitePath }, env),
      };
    } catch {
      return {
        ok: false,
        target: "sqlite",
        message: cliMessage("db.sqliteInaccessible", { path: sqlitePath }, env),
      };
    }
  }
}

/**
 * Confirms the DB is actually reachable. Never throws — always returns a result object.
 *
 * @param {{ databaseUrl?: string, sqlitePath?: string, target?: "postgresql" | "sqlite", timeoutMs?: number, env?: Record<string, string | undefined> }} options
 * @returns {Promise<{ ok: boolean, target: "postgresql" | "sqlite", message: string }>}
 */
async function checkDatabaseReachable(options = {}) {
  const {
    databaseUrl,
    sqlitePath,
    target,
    timeoutMs = DEFAULT_DB_PROBE_TIMEOUT_MS,
    env = process.env,
  } = options;

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
          message: cliMessage("db.postgresWithoutUrl", {}, env),
        };
      }
      return await probePostgres(databaseUrl, timeoutMs, env);
    }
    return await probeSqlite(sqlitePath, env);
  } catch (error) {
    return {
      ok: false,
      target: resolved,
      message: cliMessage("db.unexpected", { reason: describeError(error, env) }, env),
    };
  }
}

/**
 * Checks whether the port is already in use. { free: false } if it is.
 *
 * @param {number} port
 * @param {string} [host]
 * @param {Record<string, string | undefined>} [env]
 * @returns {Promise<{ free: boolean, message: string }>}
 */
function checkPortAvailable(port, host = "0.0.0.0", env = process.env) {
  const net = require("node:net");

  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (error) => {
      if (error && error.code === "EADDRINUSE") {
        resolve({
          free: false,
          message: cliMessage("port.inUse", { port }, env),
        });
        return;
      }
      const reason = error instanceof Error ? error.message : String(error);
      resolve({ free: true, message: cliMessage("port.unknown", { port, reason }, env) });
    });
    server.once("listening", () => {
      server.close(() => resolve({ free: true, message: cliMessage("port.free", { port }, env) }));
    });
    server.listen(port, host);
  });
}

/**
 * Prints the inspectEnvironment result as human-readable lines.
 *
 * @returns {boolean} false if there's even one error
 */
function reportEnvironmentInspection(inspection, logger = console, env = process.env) {
  for (const warning of inspection.warnings) {
    logger.warn(cliMessage("report.warning", { message: warning }, env));
  }
  for (const error of inspection.errors) {
    logger.error(cliMessage("report.failure", { message: error }, env));
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
