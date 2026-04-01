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
  envText = upsertEnvLine(envText, "DB_TYPE", "sqlite");
  envText = upsertEnvLine(envText, "SQLITE_PATH", sqlitePath);

  const hasJwtSecret = /^#?\s*JWT_SECRET=.*$/m.test(envText);
  if (!hasJwtSecret || /^#?\s*JWT_SECRET=\s*$/m.test(envText)) {
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
  getDeskRpgDataDir,
  getDeskRpgEnvPath,
  getDeskRpgHomeDir,
  getDeskRpgLogsDir,
  getDeskRpgSqlitePath,
  getDeskRpgTemplateUploadDir,
  getDeskRpgUploadsDir,
};
