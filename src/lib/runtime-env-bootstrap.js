/**
 * Prepares the runtime home and lifts **only the values missing from the environment**
 * from it into `process.env`.
 *
 * Why this sits in the server startup path: while `ensureDeskRpgHome` was called only from
 * `deskrpg init`, containers had **no path at all** to create JWT_SECRET. When the entry
 * point unset the placeholder, nothing else created it, and startup just stalled (measured
 * on Hostinger, 2026-09-16). Now npm (`deskrpg start`), Docker, and local dev all pass
 * through this same function.
 *
 * Priority has three tiers:
 *   1. An already-set environment variable  → used as-is. **Never overwritten**
 *   2. A value stored in the runtime home    → survives restarts/updates (when the home is a volume)
 *   3. Neither exists                        → `ensureDeskRpgHome` creates it and writes it to the home
 *
 * An empty string is treated as "not set". A container environment variable can be defined
 * but empty, so checking presence alone would let an empty value shadow the home file.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { parseEnv } = require("node:util");

const { cliMessage } = require("./cli-messages.js");

/** Parses a single `KEY=value` line. A comment, blank line, or malformed line yields null. */
function parseEnvLine(line) {
  const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
  if (!match) return null;
  const [, key, rawValue] = match;
  return { key, value: rawValue.trim().replace(/^["']|["']$/g, "") };
}

/**
 * @param {string} text        the runtime home's env file contents
 * @param {Record<string, string | undefined>} env  the target environment (defaults to `process.env`)
 * @returns {string[]} the key names actually filled in
 */
function applyEnvText(text, env) {
  const applied = [];
  // Capture the incoming environment before reading the home file. A saved URL must not
  // override a saved SQLite selection, but an external URL outranks home defaults.
  const externalPostgres =
    Boolean(env.DATABASE_URL) &&
    (!env.DB_TYPE || ["postgresql", "postgres"].includes(env.DB_TYPE.toLowerCase()));
  // Keep Node's dotenv syntax (quoted # and multiline values) when the CLI uses this
  // loader instead of process.loadEnvFile. Older Node versions retain the fallback.
  const entries =
    typeof parseEnv === "function"
      ? Object.entries(parseEnv(text)).map(([key, value]) => ({ key, value }))
      : text.split(/\r?\n/).map(parseEnvLine).filter(Boolean);
  for (const parsed of entries) {
    if (externalPostgres && ["DB_TYPE", "SQLITE_PATH"].includes(parsed.key)) continue;
    const current = env[parsed.key];
    // An empty string is also treated as "absent" — otherwise an empty env var would shadow the home file.
    if (current !== undefined && current !== "") continue;
    env[parsed.key] = parsed.value;
    applied.push(parsed.key);
  }
  return applied;
}

/**
 * @param {object} [options]
 * @param {string} [options.packageRoot]  the base path to locate `src/lib/runtime-paths.js`
 * @param {Record<string, string | undefined>} [options.env]
 * @param {(message: string) => void} [options.warn]
 * @returns {{ envPath: string | null, applied: string[] }}
 */
function bootstrapRuntimeEnv(options = {}) {
  const packageRoot = options.packageRoot || path.join(__dirname, "..", "..");
  const env = options.env || process.env;
  const warn = options.warn || ((message) => console.warn(message));

  let runtimePaths;
  try {
    runtimePaths = require(path.join(packageRoot, "src", "lib", "runtime-paths.js"));
  } catch {
    // A build without the runtime-paths module is left as-is — there's no reason to block startup.
    return { envPath: null, applied: [] };
  }

  let envPath;
  try {
    envPath = runtimePaths.ensureDeskRpgHome({ homeDir: env.DESKRPG_HOME }).envPath;
  } catch (err) {
    warn(cliMessage("bootstrap.homeFailed", { message: err.message }, env));
    return { envPath: null, applied: [] };
  }

  let text;
  try {
    text = fs.readFileSync(envPath, "utf8");
  } catch (err) {
    warn(cliMessage("bootstrap.envReadFailed", { message: err.message }, env));
    return { envPath, applied: [] };
  }

  return { envPath, applied: applyEnvText(text, env) };
}

module.exports = { bootstrapRuntimeEnv, applyEnvText, parseEnvLine };
