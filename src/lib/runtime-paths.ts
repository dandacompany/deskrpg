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

/**
 * Is this a placeholder written for a human to fill in? Catches `.env.example`'s guidance
 * text and values that are only slightly modified from it. A value too short to be used as a
 * real secret also counts as a placeholder.
 */
export function isPlaceholderSecret(value: string): boolean {
  const normalized = value.trim().replace(/^["']|["']$/g, "");
  if (normalized.length < 24) return true;
  // A prefix-only check would miss our own default like `deskrpg-change-this-secret-…`.
  // It's 48 characters, so it also passes the length check — an untouched install would
  // silently come up with a publicly known key (observed 2026-09-16).
  if (/change[-_ ]?(me|this)/i.test(normalized)) return true;
  // `my` is excluded. A **real** user key like `my-production-key-…` would otherwise be
  // judged a placeholder and get overwritten by the runtime — this function's premise is that
  // a value the user entered themselves wins. None of our guidance text starts with `my`.
  return /^(change|replace|set|your|example|placeholder|todo|fixme|insert)[-_ ]?/i.test(normalized);
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
  // Checking only whether the value is empty would mistake that guidance text for a real
  // secret, and every install would sign session tokens and encrypt gateway tokens with the
  // same publicly known key. A placeholder is treated exactly the same as no value at all.
  const jwtLine = envText.match(/^#?\s*JWT_SECRET=(.*)$/m);
  const jwtValue = jwtLine ? jwtLine[1].trim() : "";
  if (!jwtValue || isPlaceholderSecret(jwtValue)) {
    envText = upsertEnvLine(envText, "JWT_SECRET", crypto.randomBytes(24).toString("hex"));
  }

  // Standalone (non-Docker) runs on HTTP localhost — secure cookies must be off
  // so browsers accept the Set-Cookie header.
  const hasCookieSecure = /^#?\s*COOKIE_SECURE=.*$/m.test(envText);
  if (!hasCookieSecure) {
    envText = upsertEnvLine(envText, "COOKIE_SECURE", "false");
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
