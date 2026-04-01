import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type DeskRpgHomeOptions = {
  homeDir?: string;
  envExamplePath?: string;
};

function upsertEnvLine(envText: string, key: string, value: string) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^#?\\s*${key}=.*$`, "m");

  if (pattern.test(envText)) {
    return envText.replace(pattern, line);
  }

  const normalized = envText.endsWith("\n") || envText.length === 0 ? envText : `${envText}\n`;
  return `${normalized}${line}\n`;
}

export function getDeskRpgHomeDir(options: DeskRpgHomeOptions = {}) {
  return options.homeDir || process.env.DESKRPG_HOME || path.join(os.homedir(), ".deskrpg");
}

export function getDeskRpgEnvPath(options: DeskRpgHomeOptions = {}) {
  return path.join(getDeskRpgHomeDir(options), ".env.local");
}

export function getDeskRpgDataDir(options: DeskRpgHomeOptions = {}) {
  return path.join(getDeskRpgHomeDir(options), "data");
}

export function getDeskRpgSqlitePath(options: DeskRpgHomeOptions = {}) {
  return path.join(getDeskRpgDataDir(options), "deskrpg.db");
}

export function getDeskRpgUploadsDir(options: DeskRpgHomeOptions = {}) {
  return path.join(getDeskRpgHomeDir(options), "uploads");
}

export function getDeskRpgLogsDir(options: DeskRpgHomeOptions = {}) {
  return path.join(getDeskRpgHomeDir(options), "logs");
}

export function getDeskRpgTemplateUploadDir(templateId: string, options: DeskRpgHomeOptions = {}) {
  return path.join(getDeskRpgUploadsDir(options), templateId);
}

export function ensureDeskRpgHome(options: DeskRpgHomeOptions = {}) {
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
