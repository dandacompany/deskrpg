// src/db/index.ts
import * as pgSchema from "./schema";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

const DB_TYPE = (process.env.DB_TYPE || "postgresql").toLowerCase();
export const isPostgres = DB_TYPE === "postgresql" || DB_TYPE === "postgres";

/** Serialize JSON for DB insert — PG handles objects natively, SQLite needs strings */
export function jsonForDb(value: unknown): unknown {
  if (isPostgres) return value;
  return value == null ? null : JSON.stringify(value);
}

// Schema re-export: use the correct schema for the active DB dialect at runtime.
// PG schema uses uuid().defaultRandom() → gen_random_uuid() (PG-only),
// SQLite schema uses text().$defaultFn(() => crypto.randomUUID()) (JS-level).
// We cast to PG schema types so TypeScript sees the correct column types.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const activeSchema: typeof pgSchema = isPostgres ? pgSchema : require("./schema-sqlite");

// Re-export all table objects from the active schema
export const users = activeSchema.users;
export const characters = activeSchema.characters;
export const channels = activeSchema.channels;
export const channelMembers = activeSchema.channelMembers;
export const maps = activeSchema.maps;
export const mapPortals = activeSchema.mapPortals;
export const npcs = activeSchema.npcs;
export const chatMessages = activeSchema.chatMessages;
export const meetingMinutes = activeSchema.meetingMinutes;
export const tasks = activeSchema.tasks;
export const mapTemplates = activeSchema.mapTemplates;
export const stamps = activeSchema.stamps;
export const tilesetImages = activeSchema.tilesetImages;
export const projects = activeSchema.projects;
export const projectTilesets = activeSchema.projectTilesets;
export const projectStamps = activeSchema.projectStamps;

// Use PG type for all API routes — Drizzle's runtime API is identical across dialects.
type DbInstance = NodePgDatabase<typeof pgSchema>;

let _db: DbInstance | null = null;

export function getDb(): DbInstance {
  if (!_db) {
    if (isPostgres) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { drizzle } = require("drizzle-orm/node-postgres") as typeof import("drizzle-orm/node-postgres");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Pool } = require("pg") as typeof import("pg");
      const databaseUrl = process.env.DATABASE_URL;
      if (!databaseUrl) throw new Error("Missing env var: DATABASE_URL");
      const pool = new Pool({ connectionString: databaseUrl });
      _db = drizzle(pool, { schema: pgSchema });
    } else {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { drizzle } = require("drizzle-orm/better-sqlite3") as typeof import("drizzle-orm/better-sqlite3");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3") as typeof import("better-sqlite3");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require("node:fs") as typeof import("node:fs");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const path = require("node:path") as typeof import("node:path");

      const dbPath = process.env.SQLITE_PATH || path.join(process.cwd(), "data", "deskrpg.db");
      const dbDir = path.dirname(dbPath);
      if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

      const sqlite = new Database(dbPath);
      sqlite.pragma("journal_mode = WAL");
      sqlite.pragma("foreign_keys = ON");
      _db = drizzle(sqlite, { schema: activeSchema }) as unknown as DbInstance;
    }
  }
  return _db;
}

// Proxy for backward compatibility — lazy initialization
export const db = new Proxy({} as DbInstance, {
  get(_, prop) {
    return (getDb() as unknown as Record<string | symbol, unknown>)[prop];
  },
});

export type DB = ReturnType<typeof getDb>;
