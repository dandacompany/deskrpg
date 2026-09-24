// OpenClaw retirement migration — this moves and deletes data, so its contract is pinned down here.
//
// Two things in particular: (1) the persona must migrate without losing a single character,
// (2) it must be safe to run multiple times. This function is called from both paths (API,
// socket) every time the server boots.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");

const { retireOpenclawConfig } = require("./sqlite-openclaw-retirement.js");

/** Creates an npcs table in its pre-retirement shape. */
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

test("moves the persona to agent_config as-is", () => {
  const db = legacyDb();
  const persona = JSON.stringify({ personaConfig: { identity: "긴 정체성 문서".repeat(50) } });
  db.prepare("INSERT INTO npcs VALUES (?,?,?,?,?)").run("n1", "단비", persona, "hermes", null);

  const result = retireOpenclawConfig(db);

  assert.equal(result.migrated, 1);
  const row = db.prepare("SELECT agent_config FROM npcs WHERE id = 'n1'").get();
  assert.equal(row.agent_config, persona, "페르소나가 바이트 단위로 보존되어야 합니다");
  cleanup(db);
});

test("moves an openclaw NPC to the backup table before deleting it", () => {
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

test("drops the openclaw_config column", () => {
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

test("doesn't overwrite an already-filled agent_config", () => {
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

test("is safe to run multiple times — called every time the server boots", () => {
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

test("doesn't crash on an empty DB with no npcs table", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deskrpg-retire-empty-"));
  const db = new Database(path.join(dir, "t.db"));
  assert.equal(retireOpenclawConfig(db), null);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
