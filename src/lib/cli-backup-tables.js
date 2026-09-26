"use strict";

// `deskrpg db backups` — lists and, on request, drops the backup tables that data migrations left
// behind. Nothing drops them automatically: a backup is the only way back from a migration's delete,
// so removing one is the operator's explicit, irreversible choice.
//
// When a table was created is not recorded anywhere (a CREATE TABLE ... AS carries no timestamp, the
// drizzle ledger stores the migration's authoring time rather than when it ran, and the SQLite
// bootstrap keeps no ledger at all). So the retention clock starts the first time this command sees
// a table and is kept in a small JSON file in the data directory. That can only under-count a
// table's age, never over-count it: nothing is dropped earlier than asked.

const fs = require("node:fs");
const path = require("node:path");

/**
 * Every table a data migration creates as a backup. PostgreSQL: drizzle/0005, drizzle/0008.
 * SQLite: sqlite-openclaw-retirement.js, sqlite-npc-profile-ownership.js (which skips the tasks and
 * npc_reports copies). Only names in this list are ever dropped.
 */
const BACKUP_TABLES = Object.freeze([
  "npcs_openclaw_backup",
  "npcs_appearance_conflicts",
  "npcs_unprofiled_backup",
  "npcs_duplicate_backup",
  "npcs_removed_chat_messages_backup",
  "npcs_removed_tasks_backup",
  "npcs_removed_npc_sessions_backup",
  "npcs_removed_npc_reports_backup",
]);

const DEFAULT_RETENTION = "90d";
const DAY_MS = 24 * 60 * 60 * 1000;

/** "90d" → milliseconds. Days only: a unit that reads differently to different people is refused. */
function parseRetention(value) {
  const match = /^(\d+)d$/.exec(String(value ?? ""));
  if (!match) throw new Error("invalid_retention");
  return Number(match[1]) * DAY_MS;
}

const quote = (name) => `"${name}"`;

function sqliteBackupStore(db) {
  return {
    async list() {
      const present = new Set(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all()
          .map((row) => row.name),
      );
      return BACKUP_TABLES.filter((name) => present.has(name)).map((name) => ({
        name,
        rows: db.prepare(`SELECT count(*) AS n FROM ${quote(name)}`).get().n,
      }));
    },
    async drop(name) {
      if (!BACKUP_TABLES.includes(name)) throw new Error("not_a_backup_table");
      db.exec(`DROP TABLE IF EXISTS ${quote(name)}`);
    },
  };
}

function pgBackupStore(pool) {
  return {
    async list() {
      const { rows } = await pool.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)",
        [BACKUP_TABLES],
      );
      const present = new Set(rows.map((row) => row.table_name));
      const out = [];
      for (const name of BACKUP_TABLES.filter((n) => present.has(n))) {
        const counted = await pool.query(`SELECT count(*)::int AS n FROM ${quote(name)}`);
        out.push({ name, rows: counted.rows[0].n });
      }
      return out;
    },
    async drop(name) {
      if (!BACKUP_TABLES.includes(name)) throw new Error("not_a_backup_table");
      await pool.query(`DROP TABLE IF EXISTS ${quote(name)}`);
    },
  };
}

function readLedger(ledgerPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeLedger(ledgerPath, ledger) {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
}

function parseArgs(argv) {
  const options = { prune: false, yes: false, retention: DEFAULT_RETENTION };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--prune") options.prune = true;
    else if (arg === "--yes") options.yes = true;
    else if (arg === "--older-than") options.retention = argv[++i];
    else throw new Error(`unknown_option:${arg}`);
  }
  return { ...options, retentionMs: parseRetention(options.retention) };
}

const days = (ms) => Math.floor(ms / DAY_MS);

/**
 * Runs the command against one database. `databaseKey` names that database in the ledger (a
 * SQLite path, or host:port/db for PostgreSQL — never a password), so two installs sharing a home
 * directory keep separate clocks. Returns the exit code.
 */
async function runBackupsCommand({ argv, store, ledgerPath, databaseKey, now, log }) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    log(`Error: ${error.message}. Usage: deskrpg db backups [--prune [--older-than 90d] [--yes]]`);
    return 1;
  }

  const tables = await store.list();
  const ledger = readLedger(ledgerPath);
  const seen = { ...(ledger[databaseKey] ?? {}) };
  const nowIso = new Date(now).toISOString();
  for (const name of Object.keys(seen)) {
    if (!tables.some((table) => table.name === name)) delete seen[name];
  }
  for (const table of tables) seen[table.name] ??= nowIso;
  const entries = tables.map((table) => {
    const ageMs = now - Date.parse(seen[table.name]);
    return { ...table, firstSeen: seen[table.name], ageMs, due: ageMs >= options.retentionMs };
  });

  if (entries.length === 0) {
    log("No migration backup tables in this database.");
  } else {
    log("Migration backup tables (age counts from the first time this command saw them):");
    for (const entry of entries) {
      log(
        `  ${entry.name.padEnd(36)} ${entry.rows} rows  first seen ${entry.firstSeen.slice(0, 10)} (${days(entry.ageMs)} days)`,
      );
    }
  }

  if (options.prune && entries.length > 0) {
    const due = entries.filter((entry) => entry.due);
    if (due.length === 0) {
      log(`Nothing is old enough to drop (retention ${options.retention}).`);
    } else if (!options.yes) {
      log(`Dry run — would drop ${due.length} table(s) older than ${options.retention}:`);
      for (const entry of due) log(`  ${entry.name} (${entry.rows} rows)`);
      log("Dropping is permanent: the data these backups hold cannot be restored afterwards.");
      log("Re-run with --yes to drop them.");
    } else {
      for (const entry of due) {
        await store.drop(entry.name);
        delete seen[entry.name];
        log(`Dropped ${entry.name} (${entry.rows} rows).`);
      }
    }
  }

  if (Object.keys(seen).length > 0) ledger[databaseKey] = seen;
  else delete ledger[databaseKey];
  writeLedger(ledgerPath, ledger);
  return 0;
}

module.exports = {
  BACKUP_TABLES,
  DEFAULT_RETENTION,
  parseRetention,
  pgBackupStore,
  runBackupsCommand,
  sqliteBackupStore,
};
