// OpenClaw retirement — SQLite runtime migration.
//
// Two paths call this function: the API routes (src/db/index.ts) and the socket server
// (src/db/server-db.js). Each has its own ensureSqliteCompatibility, and there's a real prior
// incident where a column was added to only one of them, producing a silent "no such column"
// regression on that path alone. This change isn't a column addition but **data migration +
// deletion**, so missing it on one side is much worse — one path would read the persona from
// agent_config while the other tries to read it from the now-gone openclaw_config.
// So the SQL lives in exactly one place here instead of being copied.
//
// The same work on the PostgreSQL side is in drizzle/0005_retire_openclaw_config.sql. Both
// files take the same four steps in the same order.

/** @param {import('better-sqlite3').Database} sqlite */
function tableColumns(sqlite, table) {
  try {
    return sqlite
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((c) => c.name);
  } catch {
    return [];
  }
}

/**
 * Moves openclaw_config to agent_config, backs up and deletes legacy OpenClaw NPCs, and drops
 * the openclaw_config column. Safe to call multiple times.
 *
 * @param {import('better-sqlite3').Database} sqlite
 * @returns {{migrated: number, removed: number} | null} non-null only if it actually did something
 */
function retireOpenclawConfig(sqlite) {
  const cols = tableColumns(sqlite, "npcs");
  if (cols.length === 0) return null; // the npcs table doesn't exist yet (empty runtime DB)
  if (!cols.includes("openclaw_config")) return null; // already retired

  // With no agent_config, there's nowhere to migrate to. The caller adds the column first,
  // but this guards against data loss here too in case the order gets reversed.
  if (!cols.includes("agent_config")) return null;

  const hasAdapterType = cols.includes("adapter_type");

  const run = sqlite.transaction(() => {
    // 1) Move the persona to the correctly named column. Leave already-filled rows alone.
    const migrated = sqlite
      .prepare("UPDATE npcs SET agent_config = openclaw_config WHERE agent_config IS NULL")
      .run().changes;

    // 2) A legacy OpenClaw NPC can't converse through any backend. Delete it, but since this
    //    can't be undone, keep the full row in a backup table — the persona should be
    //    recoverable and rebindable to a Hermes profile.
    let removed = 0;
    if (hasAdapterType) {
      sqlite.exec(
        "CREATE TABLE IF NOT EXISTS npcs_openclaw_backup AS SELECT * FROM npcs WHERE adapter_type = 'openclaw'",
      );
      removed = sqlite.prepare("DELETE FROM npcs WHERE adapter_type = 'openclaw'").run().changes;
    }

    // 3) Drop the column whose name no longer matches its content. SQLite 3.35+ supports DROP COLUMN.
    sqlite.exec("ALTER TABLE npcs DROP COLUMN openclaw_config");

    return { migrated, removed };
  });

  const result = run();
  if (result.migrated || result.removed) {
    console.log(
      `[db] OpenClaw 은퇴: 페르소나 ${result.migrated}건을 agent_config 로 옮기고, ` +
        `레거시 NPC ${result.removed}건을 npcs_openclaw_backup 으로 옮긴 뒤 삭제했습니다.`,
    );
  }
  return result;
}

module.exports = { retireOpenclawConfig };
