// Drops the 2026-04 task system (tasks / npc_reports). The user decided to retire it without
// migrating the data, so both tables are dropped with no recovery. The same work on the
// PostgreSQL side is drizzle/0012_drop_legacy_tasks.sql. Called by both bootstrap paths
// (src/db/index.ts, server-db.js) — adding it to only one leaves the dead tables behind on
// the DB that path opens, and the schema comparison tests diverge.
"use strict";

// npc_reports references tasks, so drop the child first.
const LEGACY_TASK_TABLES = ["npc_reports", "tasks"];

/** Drops the legacy task tables. Idempotent — fine to run on every boot. */
function dropLegacyTaskTables(sqlite) {
  for (const table of LEGACY_TASK_TABLES) {
    sqlite.exec(`DROP TABLE IF EXISTS ${table}`);
  }
}

module.exports = { LEGACY_TASK_TABLES, dropLegacyTaskTables };
