const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function upsertEnvLine(envText, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^#?\\s*${key}=.*$`, "m");

  if (pattern.test(envText)) {
    return envText.replace(pattern, line);
  }

  const normalized = envText.endsWith("\n") || envText.length === 0 ? envText : `${envText}\n`;
  return `${normalized}${line}\n`;
}

function getDeskRpgHomeDir(options = {}) {
  return options.homeDir || process.env.DESKRPG_HOME || path.join(os.homedir(), ".deskrpg");
}

function getDeskRpgEnvPath(options = {}) {
  return path.join(getDeskRpgHomeDir(options), ".env.local");
}

function getDeskRpgDataDir(options = {}) {
  return path.join(getDeskRpgHomeDir(options), "data");
}

function getDeskRpgSqlitePath(options = {}) {
  return path.join(getDeskRpgDataDir(options), "deskrpg.db");
}

function getDeskRpgUploadsDir(options = {}) {
  return path.join(getDeskRpgHomeDir(options), "uploads");
}

function getDeskRpgLogsDir(options = {}) {
  return path.join(getDeskRpgHomeDir(options), "logs");
}

function getDeskRpgTemplateUploadDir(templateId, options = {}) {
  return path.join(getDeskRpgUploadsDir(options), templateId);
}

/**
 * Is this a placeholder left for a human to fill in? Catches `.env.example`'s guidance text
 * and values that are only slightly modified from it. A value too short to be a real
 * secret is also treated as a placeholder.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isPlaceholderSecret(value) {
  const normalized = value.trim().replace(/^["']|["']$/g, "");
  if (normalized.length < 24) return true;
  // Checking only the prefix would miss our own defaults, like `deskrpg-change-this-secret-…`.
  // At 48 characters it also passes the length check, so an untouched install silently ships with a public key (observed 2026-09-16).
  if (/change[-_ ]?(me|this)/i.test(normalized)) return true;
  // `my` is deliberately excluded. Flagging it would misjudge a **real** user key like
  // `my-production-key-…` as a placeholder and let the runtime overwrite it — this
  // function's premise is that a value the user set themselves wins. None of our
  // guidance text starts with `my`.
  return /^(change|replace|set|your|example|placeholder|todo|fixme|insert)[-_ ]?/i.test(normalized);
}

function ensureDeskRpgHome(options = {}) {
  const homeDir = getDeskRpgHomeDir(options);
  const envPath = getDeskRpgEnvPath(options);
  const dataDir = getDeskRpgDataDir(options);
  const uploadsDir = getDeskRpgUploadsDir(options);
  const logsDir = getDeskRpgLogsDir(options);
  const sqlitePath = getDeskRpgSqlitePath(options);

  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });

  if (!fs.existsSync(envPath)) {
    if (options.envExamplePath && fs.existsSync(options.envExamplePath)) {
      fs.copyFileSync(options.envExamplePath, envPath);
    } else {
      fs.writeFileSync(envPath, "");
    }
  }

  let envText = fs.readFileSync(envPath, "utf8");
  // Fill defaults only; startup must preserve the user's saved dialect and data path.
  for (const [key, fallback] of [
    ["DB_TYPE", "sqlite"],
    ["SQLITE_PATH", sqlitePath],
  ]) {
    const saved = envText.match(new RegExp(`^\\s*${key}=(.*)$`, "m"));
    if (!saved?.[1].trim().replace(/^["']|["']$/g, "")) {
      envText = upsertEnvLine(envText, key, fallback);
    }
  }

  // A runtime that copied `.env.example` has guidance text sitting in the JWT_SECRET slot.
  // Checking only for emptiness would mistake that guidance text for a real secret, and
  // every installation would sign session tokens and encrypt gateway tokens with the same
  // public key. A placeholder is treated exactly like a missing value.
  const jwtLine = envText.match(/^#?\s*JWT_SECRET=(.*)$/m);
  const jwtValue = jwtLine ? jwtLine[1].trim() : "";
  if (!jwtValue || isPlaceholderSecret(jwtValue)) {
    envText = upsertEnvLine(envText, "JWT_SECRET", crypto.randomBytes(24).toString("hex"));
  }

  fs.writeFileSync(envPath, envText);

  return {
    homeDir,
    envPath,
    dataDir,
    uploadsDir,
    logsDir,
    sqlitePath,
  };
}

module.exports = {
  ensureDeskRpgHome,
  isPlaceholderSecret,
  upsertEnvLine,
  getDeskRpgDataDir,
  getDeskRpgEnvPath,
  getDeskRpgHomeDir,
  getDeskRpgLogsDir,
  getDeskRpgSqlitePath,
  getDeskRpgTemplateUploadDir,
  getDeskRpgUploadsDir,
};
