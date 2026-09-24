// SQLite-side verification for the project registry table (0017).
//
// The most important thing is **whether rows and the cursor survive the migration**. Losing
// `event_cursor` makes that channel miss an entire stretch of events, and it shows up as a
// silent failure (the screen looks fine, cards just stop moving).
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { ensureProjectRegistry } = require("./sqlite-project-registry.js");

// better-sqlite3 opens with foreign keys on. Without a referenced target, the INSERT would fail
// on an FK error before we even get to see the unique constraint we're testing — hence these minimal stubs.
const REFERENCED_STUBS = `
  CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL);
  CREATE TABLE channels (id TEXT PRIMARY KEY NOT NULL);
  CREATE TABLE gateway_resources (id TEXT PRIMARY KEY NOT NULL);
  CREATE TABLE npcs (id TEXT PRIMARY KEY NOT NULL);
  CREATE TABLE meeting_minutes (id TEXT PRIMARY KEY NOT NULL);
  INSERT INTO channels (id) VALUES ('chan-1'), ('chan-2');
  INSERT INTO gateway_resources (id) VALUES ('gw-1'), ('gw-2');
`;

/** The shape through 0016 — channel_id is the PK, and id/is_event_carrier don't exist. */
const LEGACY_BOARDS_DDL = `
  CREATE TABLE channel_kanban_boards (
    channel_id TEXT PRIMARY KEY NOT NULL,
    gateway_id TEXT NOT NULL,
    board_slug TEXT NOT NULL,
    board_name_synced_at TEXT,
    event_cursor TEXT,
    last_polled_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_channel_kanban_boards_gateway_id ON channel_kanban_boards(gateway_id);
`;

type Row = Record<string, unknown>;

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((c) => String(c.name));
}

function legacyDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(REFERENCED_STUBS);
  db.exec(LEGACY_BOARDS_DDL);
  const insert = db.prepare(`
    INSERT INTO channel_kanban_boards
      (channel_id, gateway_id, board_slug, board_name_synced_at, event_cursor, last_polled_at, last_error, created_at, updated_at)
    VALUES (@channel_id, @gateway_id, @board_slug, @synced, @cursor, @polled, @error, @created, @updated)`);
  insert.run({
    channel_id: "chan-1",
    gateway_id: "gw-1",
    board_slug: "deskrpg-aaa",
    synced: "2026-09-01T00:00:00.000Z",
    cursor: "CURSOR-A",
    polled: "2026-09-02T00:00:00.000Z",
    error: null,
    created: "2026-08-01T00:00:00.000Z",
    updated: "2026-09-02T00:00:00.000Z",
  });
  insert.run({
    channel_id: "chan-2",
    gateway_id: "gw-2",
    board_slug: "deskrpg-bbb",
    synced: null,
    cursor: null,
    polled: null,
    error: "plugin_absent",
    created: "2026-08-05T00:00:00.000Z",
    updated: "2026-08-05T00:00:00.000Z",
  });
  return db;
}

test("the migration carries rows and event_cursor over as-is", () => {
  const db = legacyDb();
  ensureProjectRegistry(db);

  const rows = db.prepare("SELECT * FROM channel_kanban_boards ORDER BY channel_id").all() as Row[];
  assert.equal(rows.length, 2, "행이 사라졌습니다");

  assert.equal(rows[0].channel_id, "chan-1");
  assert.equal(rows[0].board_slug, "deskrpg-aaa");
  assert.equal(rows[0].event_cursor, "CURSOR-A", "커서를 잃으면 사건을 한 구간 놓칩니다");
  assert.equal(rows[0].board_name_synced_at, "2026-09-01T00:00:00.000Z");
  assert.equal(rows[0].created_at, "2026-08-01T00:00:00.000Z");

  assert.equal(rows[1].channel_id, "chan-2");
  assert.equal(rows[1].event_cursor, null);
  assert.equal(rows[1].last_error, "plugin_absent");
});

test("every migrated row is an event-carrier board", () => {
  const db = legacyDb();
  ensureProjectRegistry(db);
  const rows = db.prepare("SELECT id, is_event_carrier FROM channel_kanban_boards").all() as Row[];
  for (const row of rows) {
    assert.equal(row.is_event_carrier, 1, "이관 전 유일한 보드는 이미 크론 사건을 받고 있었습니다");
    assert.match(String(row.id), /^[0-9a-f-]{36}$/, "대리 키가 채워지지 않았습니다");
  }
});

test("each channel has exactly one event-carrier board", () => {
  const db = legacyDb();
  ensureProjectRegistry(db);
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO channel_kanban_boards
             (id, channel_id, gateway_id, board_slug, is_event_carrier, created_at, updated_at)
           VALUES ('dup', 'chan-1', 'gw-1', 'deskrpg-second', 1, 'x', 'x')`,
        )
        .run(),
    /UNIQUE/,
    "둘째 carrier 가 들어갔습니다 — 크론 사건이 두 번 소비됩니다",
  );
});

test("multiple different boards can attach to the same channel", () => {
  const db = legacyDb();
  ensureProjectRegistry(db);
  db.prepare(
    `INSERT INTO channel_kanban_boards
       (id, channel_id, gateway_id, board_slug, is_event_carrier, created_at, updated_at)
     VALUES ('second', 'chan-1', 'gw-1', 'deskrpg-aaa-b2c3d4e5', 0, 'x', 'x')`,
  ).run();
  const count = db
    .prepare("SELECT COUNT(*) AS n FROM channel_kanban_boards WHERE channel_id = 'chan-1'")
    .get() as Row;
  assert.equal(count.n, 2);
});

test("the same slug can't attach twice to the same channel", () => {
  const db = legacyDb();
  ensureProjectRegistry(db);
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO channel_kanban_boards
             (id, channel_id, gateway_id, board_slug, is_event_carrier, created_at, updated_at)
           VALUES ('dup2', 'chan-1', 'gw-1', 'deskrpg-aaa', 0, 'x', 'x')`,
        )
        .run(),
    /UNIQUE/,
  );
});

test("idempotent — rows stay the same after running twice", () => {
  const db = legacyDb();
  ensureProjectRegistry(db);
  const first = db.prepare("SELECT id FROM channel_kanban_boards ORDER BY channel_id").all();
  ensureProjectRegistry(db);
  const second = db.prepare("SELECT id FROM channel_kanban_boards ORDER BY channel_id").all();
  assert.deepEqual(second, first, "두 번째 실행이 표를 다시 만들었습니다");
});

test("the metadata tables get created, and a subproject slug is unique within its project", () => {
  const db = legacyDb();
  ensureProjectRegistry(db);
  assert.ok(columns(db, "channel_projects").includes("origin_meeting_id"));
  assert.ok(columns(db, "channel_projects").includes("hermes_project_id"));
  assert.ok(columns(db, "channel_subprojects").includes("tenant_slug"));

  const boardId = (db.prepare("SELECT id FROM channel_kanban_boards LIMIT 1").get() as Row).id;
  db.prepare(
    `INSERT INTO channel_projects (id, board_link_id, channel_id, status, created_at, updated_at)
     VALUES ('p1', ?, 'chan-1', 'planned', 'x', 'x')`,
  ).run(boardId);
  db.prepare(
    `INSERT INTO channel_subprojects (id, project_id, tenant_slug, name, status, created_at, updated_at)
     VALUES ('s1', 'p1', 'research', '리서치', 'planned', 'x', 'x')`,
  ).run();
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO channel_subprojects (id, project_id, tenant_slug, name, status, created_at, updated_at)
           VALUES ('s2', 'p1', 'research', '리서치 둘', 'planned', 'x', 'x')`,
        )
        .run(),
    /UNIQUE/,
  );
});

test("an empty DB boots straight into the new shape without a rebuild", () => {
  const db = new Database(":memory:");
  db.exec(REFERENCED_STUBS);
  db.exec(`
    CREATE TABLE channel_kanban_boards (
      id TEXT PRIMARY KEY NOT NULL,
      channel_id TEXT NOT NULL,
      gateway_id TEXT NOT NULL,
      board_slug TEXT NOT NULL,
      is_event_carrier INTEGER NOT NULL DEFAULT 0,
      board_name_synced_at TEXT, event_cursor TEXT, last_polled_at TEXT, last_error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );`);
  ensureProjectRegistry(db);
  assert.ok(columns(db, "channel_kanban_boards").includes("is_event_carrier"));
  assert.equal(
    db.prepare("SELECT 1 FROM sqlite_master WHERE name='channel_kanban_boards__new'").get(),
    undefined,
    "빈 DB 에 임시 표가 남았습니다",
  );
});
