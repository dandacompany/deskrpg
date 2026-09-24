// SQLite-side verification for the map editor retirement (0013).
//
// An empty DB never gets the map editor tables created in the first place, and opening an
// existing DB that still has the tables and old appearances makes both bootstrap paths drop
// the tables and fold the appearance into an office look. This is a deletion the user approved
// knowing it would lose data, so map editor data is not recovered.
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { createRequire } from "node:module";

import { OFFICE_LOOKS } from "@/game/three/office-looks";

const require = createRequire(import.meta.url);
const { SQLITE_BASE_SCHEMA } = require("./sqlite-base-schema.js");
const { ensureSqliteCompatibility } = require("./server-db.js");
const { MAP_EDITOR_TABLES, OFFICE_LOOK_IDS, normalizeAppearanceJson, retireMapEditor } =
  require("./sqlite-map-editor-drop.js") as {
    MAP_EDITOR_TABLES: string[];
    OFFICE_LOOK_IDS: string[];
    normalizeAppearanceJson: (raw: string | null) => string | null;
    retireMapEditor: (sqlite: Database.Database) => void;
  };

// Exact copy of the definition that was in the base schema through 0012 (including FK relations).
const MAP_EDITOR_DDL = `
  CREATE TABLE IF NOT EXISTS maps (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    tilemap_path TEXT NOT NULL,
    config TEXT,
    created_at TEXT,
    updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS map_portals (
    id TEXT PRIMARY KEY NOT NULL,
    from_map_id TEXT REFERENCES maps(id),
    to_map_id TEXT REFERENCES maps(id),
    from_x INTEGER NOT NULL,
    from_y INTEGER NOT NULL,
    to_x INTEGER NOT NULL,
    to_y INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS map_templates (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    cols INTEGER NOT NULL,
    rows INTEGER NOT NULL,
    spawn_col INTEGER NOT NULL,
    spawn_row INTEGER NOT NULL,
    created_by TEXT REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS stamps (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    cols INTEGER NOT NULL,
    rows INTEGER NOT NULL,
    layers TEXT NOT NULL,
    tilesets TEXT NOT NULL,
    built_in INTEGER NOT NULL DEFAULT 0,
    created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS tileset_images (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    columns INTEGER NOT NULL,
    tilecount INTEGER NOT NULL,
    image TEXT NOT NULL,
    built_in INTEGER NOT NULL DEFAULT 0,
    created_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tileset_images_name ON tileset_images(name);
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS project_tilesets (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    tileset_id TEXT NOT NULL REFERENCES tileset_images(id) ON DELETE CASCADE,
    firstgid INTEGER NOT NULL,
    added_at TEXT NOT NULL,
    UNIQUE(project_id, tileset_id)
  );
  CREATE TABLE IF NOT EXISTS project_stamps (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    stamp_id TEXT NOT NULL REFERENCES stamps(id) ON DELETE CASCADE,
    added_at TEXT NOT NULL,
    UNIQUE(project_id, stamp_id)
  );
`;

/** One old-style layered appearance — no look ID, just layer keys. */
function legacyLayers(bodyType?: string): string {
  const value: Record<string, unknown> = {
    layers: {
      body: { itemKey: "body", variant: "light" },
      hair: { itemKey: "hair", variant: "bob" },
    },
    torso: { type: "torso", variant: "shirt" },
  };
  if (bodyType !== undefined) value.bodyType = bodyType;
  return JSON.stringify(value);
}

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name),
  );
}

function appearanceOf(db: Database.Database, table: string, id: string): string | null {
  const row = db.prepare(`SELECT appearance FROM ${table} WHERE id = ?`).get(id) as
    { appearance: string | null } | undefined;
  return row ? row.appearance : null;
}

/**
 * Seeds one conversion scenario each into the three tables that hold an appearance. The id
 * combines the table name and scenario, so a failure message immediately shows which table diverged.
 */
const APPEARANCE_CASES: Array<{ key: string; value: string | null; expected: string | null }> = [
  {
    key: "female",
    value: legacyLayers("female"),
    expected: JSON.stringify({ officeLookId: "office-nari", bodyType: "female" }),
  },
  {
    key: "male",
    value: legacyLayers("male"),
    expected: JSON.stringify({ officeLookId: "office-jun", bodyType: "male" }),
  },
  {
    key: "nobody",
    value: legacyLayers(),
    expected: JSON.stringify({ officeLookId: "office-jun", bodyType: "male" }),
  },
  {
    key: "unknown-look",
    value: JSON.stringify({ officeLookId: "office-does-not-exist", bodyType: "female" }),
    expected: JSON.stringify({ officeLookId: "office-nari", bodyType: "female" }),
  },
  {
    // Rows that are already canonical are left untouched.
    key: "valid-look",
    value: JSON.stringify({ officeLookId: "office-seo", bodyType: "female" }),
    expected: JSON.stringify({ officeLookId: "office-seo", bodyType: "female" }),
  },
  { key: "null", value: null, expected: null },
  {
    // Valid JSON but not an object (a JSON string). Folded into the default look, same as an old appearance.
    key: "string-json",
    value: JSON.stringify("office-seo"),
    expected: JSON.stringify({ officeLookId: "office-jun", bodyType: "male" }),
  },
];

function seedAppearances(db: Database.Database): void {
  db.prepare(
    "INSERT INTO users (id, login_id, nickname, password_hash, created_at, updated_at) VALUES (?,?,?,?,?,?)",
  ).run("u1", "u1", "테스터", "x", "2026-01-01", "2026-01-01");
  db.prepare("INSERT INTO channels (id, name, owner_id) VALUES (?,?,?)").run("c1", "채널", "u1");
  db.prepare(
    "INSERT INTO gateway_resources (id, owner_user_id, display_name, base_url, token_encrypted, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
  ).run("g1", "u1", "gw", "http://localhost:1", "enc", "2026-01-01", "2026-01-01");

  for (const c of APPEARANCE_CASES) {
    // characters.appearance is NOT NULL, so there's no null scenario for it — just skip that row.
    if (c.value !== null) {
      db.prepare("INSERT INTO characters (id, user_id, name, appearance) VALUES (?,?,?,?)").run(
        `char-${c.key}`,
        "u1",
        c.key,
        c.value,
      );
    }

    db.prepare(
      "INSERT INTO hermes_profiles (id, gateway_id, profile_name, token_encrypted, appearance, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
    ).run(`prof-${c.key}`, "g1", c.key, "enc", c.value, "2026-01-01", "2026-01-01");

    db.prepare(
      "INSERT INTO npcs (id, channel_id, hermes_profile_id, appearance) VALUES (?,?,?,?)",
    ).run(`npc-${c.key}`, "c1", `prof-${c.key}`, c.value);
  }
}

function assertAppearances(db: Database.Database, label: string): void {
  for (const c of APPEARANCE_CASES) {
    if (c.value !== null) {
      assert.equal(
        appearanceOf(db, "characters", `char-${c.key}`),
        c.expected,
        `${label}: characters/${c.key}`,
      );
    }
    assert.equal(
      appearanceOf(db, "hermes_profiles", `prof-${c.key}`),
      c.expected,
      `${label}: hermes_profiles/${c.key}`,
    );
    assert.equal(appearanceOf(db, "npcs", `npc-${c.key}`), c.expected, `${label}: npcs/${c.key}`);
  }
}

test("an empty DB's base schema has no map editor tables", () => {
  const db = new Database(":memory:");
  db.exec(SQLITE_BASE_SCHEMA);
  ensureSqliteCompatibility(db);

  for (const t of MAP_EDITOR_TABLES) assert.equal(tableExists(db, t), false, t);
  // Other tables are fine.
  for (const t of [
    "users",
    "channels",
    "characters",
    "npcs",
    "hermes_profiles",
    "chat_rooms",
    "channel_kanban_boards",
    "cron_job_origins",
    "meeting_minutes",
  ]) {
    assert.ok(tableExists(db, t), t);
  }
  db.close();
});

test("opening an existing DB with map editor tables and old appearances drops the tables and converts the appearances — same result opened twice", () => {
  const db = new Database(":memory:");
  db.exec(SQLITE_BASE_SCHEMA);
  db.exec(MAP_EDITOR_DDL);
  for (const t of MAP_EDITOR_TABLES) assert.ok(tableExists(db, t), `${t} 가 미리 있어야 한다`);
  seedAppearances(db);

  ensureSqliteCompatibility(db);
  for (const t of MAP_EDITOR_TABLES) assert.equal(tableExists(db, t), false, `${t} 는 지워진다`);
  assertAppearances(db, "1회차");

  // Idempotent — running it again gives the same result.
  ensureSqliteCompatibility(db);
  for (const t of MAP_EDITOR_TABLES) assert.equal(tableExists(db, t), false, `${t} 는 지워진다`);
  assertAppearances(db, "2회차");

  // Channels and NPCs are untouched.
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM npcs").get() as { n: number }).n,
    APPEARANCE_CASES.length,
  );
  db.close();
});

test("the shared module is idempotent on its own too, and doesn't error when the tables are missing", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL);`);
  retireMapEditor(db);
  retireMapEditor(db);
  for (const t of MAP_EDITOR_TABLES) assert.equal(tableExists(db, t), false, t);
  assert.ok(tableExists(db, "users"));
  db.close();
});

test("a NULL appearance and a valid look are not converted", () => {
  assert.equal(normalizeAppearanceJson(null), null);
  assert.equal(
    normalizeAppearanceJson(JSON.stringify({ officeLookId: "office-yun", bodyType: "female" })),
    null,
  );
  // Broken JSON is folded into the default look, same as an old appearance.
  assert.equal(
    normalizeAppearanceJson("{not json"),
    JSON.stringify({ officeLookId: "office-jun", bodyType: "male" }),
  );
});

/**
 * The SQLite module and `drizzle/0013_drop_map_editor_tables.sql` both hardcode the OFFICE_LOOKS
 * list as a literal (a CJS module can't require TS, and the SQL doesn't import anything). If a
 * look is added or removed, this test goes red first — otherwise a stale list would fold an
 * already-canonical row back into the default look.
 */
test("the hardcoded look ID list matches OFFICE_LOOKS (both the JS module and the SQL)", async () => {
  const expected = OFFICE_LOOKS.map((look) => look.id);
  assert.deepEqual(OFFICE_LOOK_IDS, expected, "sqlite-map-editor-drop.js 의 목록이 낡았습니다");

  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const path = await import("node:path");
  const sqlPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../drizzle/0013_drop_map_editor_tables.sql",
  );
  const sql = readFileSync(sqlPath, "utf8");
  const declared = [...sql.matchAll(/'(office-[a-z]+)'/g)].map((m) => m[1]);
  // office-nari / office-jun also appear in the conversion rules, so dedupe and compare as sets.
  assert.deepEqual(
    [...new Set(declared)].sort(),
    [...expected].sort(),
    "0013 마이그레이션의 룩 ID 목록이 낡았습니다",
  );
});
