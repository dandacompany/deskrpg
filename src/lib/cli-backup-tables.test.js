"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");

const {
  BACKUP_TABLES,
  parseRetention,
  pgBackupStore,
  runBackupsCommand,
  sqliteBackupStore,
} = require("./cli-backup-tables.js");

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-26T00:00:00Z");

function tempLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deskrpg-backups-"));
  return path.join(dir, "backup-tables.json");
}

/** A DB holding two backup tables and a real table that must never be touched. */
function seededDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE npcs (id TEXT PRIMARY KEY);
    INSERT INTO npcs VALUES ('live');
    CREATE TABLE npcs_openclaw_backup (id TEXT);
    INSERT INTO npcs_openclaw_backup VALUES ('a'), ('b');
    CREATE TABLE npcs_duplicate_backup (id TEXT);
  `);
  return db;
}

function run(db, argv, ledgerPath, now = NOW) {
  const lines = [];
  return runBackupsCommand({
    argv,
    store: sqliteBackupStore(db),
    ledgerPath,
    databaseKey: "sqlite:test.db",
    now,
    log: (line) => lines.push(line),
  }).then((code) => ({ code, out: lines.join("\n") }));
}

const tableNames = (db) =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);

function writeLedger(ledgerPath, firstSeen) {
  fs.writeFileSync(ledgerPath, JSON.stringify({ "sqlite:test.db": firstSeen }));
}

test("the list of backup tables covers what the 0005 and 0008 migrations leave behind", () => {
  assert.deepEqual([...BACKUP_TABLES].sort(), [
    "npcs_appearance_conflicts",
    "npcs_duplicate_backup",
    "npcs_openclaw_backup",
    "npcs_removed_chat_messages_backup",
    "npcs_removed_npc_reports_backup",
    "npcs_removed_npc_sessions_backup",
    "npcs_removed_tasks_backup",
    "npcs_unprofiled_backup",
  ]);
});

test("parseRetention reads days and rejects anything else", () => {
  assert.equal(parseRetention("90d"), 90 * DAY);
  assert.equal(parseRetention("0d"), 0);
  for (const bad of ["90", "3w", "-1d", "1.5d", ""]) {
    assert.throws(() => parseRetention(bad), /invalid_retention/, bad);
  }
});

test("an empty DB lists nothing and prunes nothing", async () => {
  const db = new Database(":memory:");
  const ledger = tempLedger();
  const listed = await run(db, [], ledger);
  assert.equal(listed.code, 0);
  assert.match(listed.out, /No migration backup tables/);
  const pruned = await run(db, ["--prune", "--yes"], ledger);
  assert.equal(pruned.code, 0);
  assert.deepEqual(tableNames(db), []);
});

test("listing shows row counts and starts each table's clock the first time it is seen", async () => {
  const db = seededDb();
  const ledger = tempLedger();
  const { code, out } = await run(db, [], ledger);
  assert.equal(code, 0);
  assert.match(out, /npcs_openclaw_backup\s+2 rows/);
  assert.match(out, /npcs_duplicate_backup\s+0 rows/);
  const saved = JSON.parse(fs.readFileSync(ledger, "utf8"))["sqlite:test.db"];
  assert.equal(saved.npcs_openclaw_backup, new Date(NOW).toISOString());
  assert.equal(saved.npcs_duplicate_backup, new Date(NOW).toISOString());
});

test("a table first seen today is kept by a 90-day prune, even with --yes", async () => {
  const db = seededDb();
  const ledger = tempLedger();
  const { code, out } = await run(db, ["--prune", "--yes"], ledger);
  assert.equal(code, 0);
  assert.match(out, /Nothing is old enough/);
  assert.ok(tableNames(db).includes("npcs_openclaw_backup"));
});

test("without --yes a prune is a dry run that drops nothing", async () => {
  const db = seededDb();
  const ledger = tempLedger();
  writeLedger(ledger, {
    npcs_openclaw_backup: new Date(NOW - 100 * DAY).toISOString(),
    npcs_duplicate_backup: new Date(NOW - 100 * DAY).toISOString(),
  });
  const { code, out } = await run(db, ["--prune"], ledger);
  assert.equal(code, 0);
  assert.match(out, /Dry run/);
  assert.match(out, /npcs_openclaw_backup/);
  assert.deepEqual(tableNames(db), ["npcs", "npcs_duplicate_backup", "npcs_openclaw_backup"]);
});

test("--yes drops only backups past the retention and never a live table", async () => {
  const db = seededDb();
  const ledger = tempLedger();
  writeLedger(ledger, {
    npcs_openclaw_backup: new Date(NOW - 100 * DAY).toISOString(),
    npcs_duplicate_backup: new Date(NOW - 30 * DAY).toISOString(),
  });
  const { code, out } = await run(db, ["--prune", "--yes"], ledger);
  assert.equal(code, 0);
  assert.match(out, /Dropped npcs_openclaw_backup \(2 rows\)/);
  assert.deepEqual(tableNames(db), ["npcs", "npcs_duplicate_backup"]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM npcs").get().n, 1);
  const saved = JSON.parse(fs.readFileSync(ledger, "utf8"))["sqlite:test.db"];
  assert.equal("npcs_openclaw_backup" in saved, false, "a dropped table leaves the ledger");
  assert.ok(saved.npcs_duplicate_backup);
});

test("--older-than changes the retention", async () => {
  const db = seededDb();
  const ledger = tempLedger();
  writeLedger(ledger, {
    npcs_openclaw_backup: new Date(NOW - 100 * DAY).toISOString(),
    npcs_duplicate_backup: new Date(NOW - 30 * DAY).toISOString(),
  });
  await run(db, ["--prune", "--older-than", "7d", "--yes"], ledger);
  assert.deepEqual(tableNames(db), ["npcs"]);
});

test("an unknown option or a bad retention is refused without touching anything", async () => {
  const db = seededDb();
  const ledger = tempLedger();
  assert.equal((await run(db, ["--prune", "--older-than", "3w", "--yes"], ledger)).code, 1);
  assert.equal((await run(db, ["--drop-everything"], ledger)).code, 1);
  assert.deepEqual(tableNames(db), ["npcs", "npcs_duplicate_backup", "npcs_openclaw_backup"]);
});

test("every table a migration creates with CREATE TABLE ... AS is in the list", () => {
  // A new data migration that backs something up must also teach this command about it.
  const root = path.join(__dirname, "..", "..");
  const sources = [
    ...fs
      .readdirSync(path.join(root, "drizzle"))
      .filter((f) => f.endsWith(".sql"))
      .map((f) => path.join(root, "drizzle", f)),
    ...fs
      .readdirSync(path.join(root, "src", "db"))
      .filter((f) => /^sqlite-.*\.js$/.test(f) && !f.endsWith(".test.js"))
      .map((f) => path.join(root, "src", "db", f)),
  ];
  const created = new Set();
  for (const file of sources) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?"?([a-z_]+)"? AS\b/gi)) {
      created.add(m[1]);
    }
  }
  assert.ok(created.size > 0, "the scan found nothing — its pattern is stale");
  for (const name of created) assert.ok(BACKUP_TABLES.includes(name), `${name} is not listed`);
});

test("the PostgreSQL store only counts and drops listed tables", async () => {
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push(sql);
      if (sql.startsWith("SELECT table_name")) {
        assert.deepEqual(params, [BACKUP_TABLES]);
        return { rows: [{ table_name: "npcs_openclaw_backup" }] };
      }
      if (sql.startsWith("SELECT count")) return { rows: [{ n: 2 }] };
      return { rows: [] };
    },
  };
  const store = pgBackupStore(pool);
  assert.deepEqual(await store.list(), [{ name: "npcs_openclaw_backup", rows: 2 }]);
  await store.drop("npcs_openclaw_backup");
  await assert.rejects(() => store.drop("npcs"), /not_a_backup_table/);
  assert.equal(queries.at(-1), 'DROP TABLE IF EXISTS "npcs_openclaw_backup"');
});
