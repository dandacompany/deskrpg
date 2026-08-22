// OpenClaw 은퇴 마이그레이션 — 데이터를 옮기고 지우는 작업이라 계약을 고정해 둔다.
//
// 특히 두 가지: (1) 페르소나가 한 글자도 잃지 않고 옮겨질 것, (2) 여러 번 돌아도 안전할 것.
// 이 함수는 서버가 뜰 때마다 두 경로(API·소켓)에서 각각 불린다.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");

const { retireOpenclawConfig } = require("./sqlite-openclaw-retirement.js");

/** 은퇴 전 모습의 npcs 테이블을 만든다. */
function legacyDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deskrpg-retire-"));
  const db = new Database(path.join(dir, "t.db"));
  db.exec(`
    CREATE TABLE npcs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      openclaw_config TEXT NOT NULL,
      adapter_type TEXT NOT NULL DEFAULT 'openclaw',
      agent_config TEXT
    )
  `);
  db.__dir = dir;
  return db;
}

function cleanup(db) {
  const dir = db.__dir;
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

test("페르소나를 agent_config 로 그대로 옮긴다", () => {
  const db = legacyDb();
  const persona = JSON.stringify({ personaConfig: { identity: "긴 정체성 문서".repeat(50) } });
  db.prepare("INSERT INTO npcs VALUES (?,?,?,?,?)").run("n1", "단비", persona, "hermes", null);

  const result = retireOpenclawConfig(db);

  assert.equal(result.migrated, 1);
  const row = db.prepare("SELECT agent_config FROM npcs WHERE id = 'n1'").get();
  assert.equal(row.agent_config, persona, "페르소나가 바이트 단위로 보존되어야 합니다");
  cleanup(db);
});

test("openclaw NPC 는 백업 테이블로 옮긴 뒤 지운다", () => {
  const db = legacyDb();
  db.prepare("INSERT INTO npcs VALUES (?,?,?,?,?)").run("n1", "레거시", "{}", "openclaw", null);
  db.prepare("INSERT INTO npcs VALUES (?,?,?,?,?)").run("n2", "단비", "{}", "hermes", null);

  const result = retireOpenclawConfig(db);

  assert.equal(result.removed, 1);
  assert.deepEqual(
    db
      .prepare("SELECT id FROM npcs ORDER BY id")
      .all()
      .map((r) => r.id),
    ["n2"],
    "hermes NPC 는 남아야 합니다",
  );
  const backup = db.prepare("SELECT id, name FROM npcs_openclaw_backup").all();
  assert.deepEqual(backup, [{ id: "n1", name: "레거시" }], "지운 행은 백업에 남아야 합니다");
  cleanup(db);
});

test("openclaw_config 열을 없앤다", () => {
  const db = legacyDb();
  db.prepare("INSERT INTO npcs VALUES (?,?,?,?,?)").run("n1", "단비", "{}", "hermes", null);

  retireOpenclawConfig(db);

  const cols = db
    .prepare("PRAGMA table_info(npcs)")
    .all()
    .map((c) => c.name);
  assert.ok(!cols.includes("openclaw_config"), "정본이 둘이면 어느 쪽인지 알 수 없어집니다");
  cleanup(db);
});

test("이미 채워진 agent_config 는 덮어쓰지 않는다", () => {
  const db = legacyDb();
  db.prepare("INSERT INTO npcs VALUES (?,?,?,?,?)").run(
    "n1",
    "단비",
    '{"old":true}',
    "hermes",
    '{"new":true}',
  );

  retireOpenclawConfig(db);

  const row = db.prepare("SELECT agent_config FROM npcs WHERE id='n1'").get();
  assert.equal(row.agent_config, '{"new":true}');
  cleanup(db);
});

test("여러 번 돌려도 안전하다 — 서버가 뜰 때마다 불린다", () => {
  const db = legacyDb();
  db.prepare("INSERT INTO npcs VALUES (?,?,?,?,?)").run("n1", "단비", '{"a":1}', "hermes", null);

  const first = retireOpenclawConfig(db);
  const second = retireOpenclawConfig(db);
  const third = retireOpenclawConfig(db);

  assert.equal(first.migrated, 1);
  assert.equal(second, null, "두 번째 호출은 할 일이 없어야 합니다");
  assert.equal(third, null);
  assert.equal(
    db.prepare("SELECT agent_config FROM npcs WHERE id='n1'").get().agent_config,
    '{"a":1}',
  );
  cleanup(db);
});

test("npcs 테이블이 없는 빈 DB 에서도 죽지 않는다", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deskrpg-retire-empty-"));
  const db = new Database(path.join(dir, "t.db"));
  assert.equal(retireOpenclawConfig(db), null);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
