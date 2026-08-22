// OpenClaw 은퇴 — SQLite 런타임 마이그레이션.
//
// 두 경로가 이 함수를 부른다: API 라우트(src/db/index.ts)와 소켓 서버(src/db/server-db.js).
// 그 둘은 각자 ensureSqliteCompatibility 를 갖고 있고, 예전에 한쪽에만 컬럼을 더했다가
// 그 경로에서만 "no such column" 이 나는 조용한 회귀를 실제로 겪었다. 이번 변경은 컬럼
// 추가가 아니라 **데이터 이관 + 삭제**라 한쪽만 빠지면 훨씬 나쁘다 — 한쪽 경로는 페르소나를
// agent_config 에서 읽고 다른 쪽은 사라진 openclaw_config 에서 읽으려 든다.
// 그래서 SQL 을 복사하지 않고 여기 한 곳에 둔다.
//
// PostgreSQL 쪽 같은 작업은 drizzle/0005_retire_openclaw_config.sql 에 있다. 두 파일은
// 같은 네 단계를 같은 순서로 밟는다.

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
 * openclaw_config 를 agent_config 로 옮기고, 레거시 OpenClaw NPC 를 백업 후 삭제하고,
 * openclaw_config 열을 없앤다. 여러 번 불러도 안전하다.
 *
 * @param {import('better-sqlite3').Database} sqlite
 * @returns {{migrated: number, removed: number} | null} 실제로 무언가 한 경우에만 non-null
 */
function retireOpenclawConfig(sqlite) {
  const cols = tableColumns(sqlite, "npcs");
  if (cols.length === 0) return null; // npcs 테이블이 아직 없다(빈 런타임 DB)
  if (!cols.includes("openclaw_config")) return null; // 이미 은퇴됨

  // agent_config 가 없으면 이관할 곳이 없다. 호출부가 컬럼 추가를 먼저 하지만,
  // 순서가 뒤바뀌어도 데이터를 잃지 않도록 여기서도 막는다.
  if (!cols.includes("agent_config")) return null;

  const hasAdapterType = cols.includes("adapter_type");

  const run = sqlite.transaction(() => {
    // 1) 페르소나를 올바른 이름의 열로. 이미 채워진 행은 건드리지 않는다.
    const migrated = sqlite
      .prepare("UPDATE npcs SET agent_config = openclaw_config WHERE agent_config IS NULL")
      .run().changes;

    // 2) 레거시 OpenClaw NPC 는 어떤 백엔드로도 대화할 수 없다. 지우되, 되돌릴 수 없는
    //    삭제이므로 행 전체를 백업 테이블에 남긴다 — 페르소나를 되살려 Hermes 프로필에
    //    다시 묶을 수 있어야 한다.
    let removed = 0;
    if (hasAdapterType) {
      sqlite.exec(
        "CREATE TABLE IF NOT EXISTS npcs_openclaw_backup AS SELECT * FROM npcs WHERE adapter_type = 'openclaw'",
      );
      removed = sqlite.prepare("DELETE FROM npcs WHERE adapter_type = 'openclaw'").run().changes;
    }

    // 3) 이름과 내용이 어긋난 열을 없앤다. SQLite 3.35+ 는 DROP COLUMN 을 지원한다.
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
