// Map editor retirement — SQLite runtime migration.
//
// Called by both bootstrap paths (src/db/index.ts, src/db/server-db.js). Adding it to only one
// leaves the dead tables and old appearances behind on the DB that path opens, so the API
// routes and the socket server end up seeing different data. The same work on the PostgreSQL
// side is drizzle/0013_drop_map_editor_tables.sql — both files take the same two steps in the
// same order (convert appearances → drop tables).
//
// This is a deletion the user approved knowing it would lose data in their install. No
// preservation bypass is provided.
"use strict";

/** Map editor tables to drop. Child → parent order (won't hit FK issues even with foreign_keys on). */
const MAP_EDITOR_TABLES = [
  "map_portals",
  "maps",
  "map_templates",
  "project_tilesets",
  "project_stamps",
  "projects",
  "tileset_images",
  "stamps",
];

/**
 * All 50 OFFICE_LOOKS IDs from src/game/three/office-looks.ts.
 * This module is required by server.js without a TS build, so the list is hardcoded here.
 * src/db/map-editor-retirement.test.ts keeps it fresh by diffing against OFFICE_LOOKS.
 */
const OFFICE_LOOK_IDS = [
  "office-jun",
  "office-tae",
  "office-seo",
  "office-min",
  "office-do",
  "office-yun",
  "office-ha",
  "office-jin",
  "office-eun",
  "office-hyeon",
  "office-nari",
  "office-roan",
  "office-soi",
  "office-yul",
  "office-bomi",
  "office-jiho",
  "office-dami",
  "office-seul",
  "office-kyu",
  "office-ara",
  "office-ian",
  "office-rumi",
  "office-gonu",
  "office-haena",
  "office-woojin",
  "office-jua",
  "office-taemin",
  "office-sera",
  "office-hosu",
  "office-yena",
  "office-sungho",
  "office-hyejin",
  "office-jungwon",
  "office-seok",
  "office-mira",
  "office-kyung",
  "office-yeon",
  "office-dohun",
  "office-suhye",
  "office-jaewon",
  "office-daeun",
  "office-jiseok",
  "office-seona",
  "office-haram",
  "office-chan",
  "office-eunsol",
  "office-sejin",
  "office-hyo",
  "office-yumin",
  "office-garam",
];

/** The look an old appearance with bodyType === "female" folds into. */
const FEMALE_LOOK_ID = "office-nari";
/** The default look everything else (male, missing, or unknown values) folds into. */
const DEFAULT_LOOK_ID = "office-jun";

/** Tables and columns that hold an appearance. npcs only has its value fixed — the column stays. */
const APPEARANCE_TABLES = ["characters", "hermes_profiles", "npcs"];

const VALID_LOOK_IDS = new Set(OFFICE_LOOK_IDS);

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
 * Folds one stored appearance into the canonical form. Returns null if it already has a valid
 * look ID, so the caller leaves that row alone (idempotent).
 *
 * @param {string | null} raw SQLite stores the appearance as a JSON string (text).
 * @returns {string | null} the new JSON string to write, or null if it should be left as-is
 */
function normalizeAppearanceJson(raw) {
  if (raw === null || raw === undefined) return null; // Leave NULL as-is.

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null; // A broken value is folded into the default look, same as an old appearance.
  }

  const isObject = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  if (isObject && VALID_LOOK_IDS.has(parsed.officeLookId)) return null; // Already canonical.

  const female = isObject && parsed.bodyType === "female";
  return JSON.stringify({
    officeLookId: female ? FEMALE_LOOK_ID : DEFAULT_LOOK_ID,
    bodyType: female ? "female" : "male",
  });
}

/**
 * Converts old-style layered appearances into office looks. Gives the same result no matter how many times it's called.
 *
 * @param {import('better-sqlite3').Database} sqlite
 * @returns {Record<string, number>} number of conversions per table
 */
function normalizeLegacyAppearances(sqlite) {
  /** @type {Record<string, number>} */
  const converted = {};

  for (const table of APPEARANCE_TABLES) {
    const cols = tableColumns(sqlite, table);
    if (!cols.includes("id") || !cols.includes("appearance")) continue;

    const rows = sqlite
      .prepare(`SELECT id, appearance FROM ${table} WHERE appearance IS NOT NULL`)
      .all();
    const update = sqlite.prepare(`UPDATE ${table} SET appearance = ? WHERE id = ?`);

    let count = 0;
    sqlite.transaction(() => {
      for (const row of rows) {
        const next = normalizeAppearanceJson(row.appearance);
        if (next === null) continue;
        update.run(next, row.id);
        count += 1;
      }
    })();

    if (count > 0) converted[table] = count;
  }

  if (Object.keys(converted).length > 0) {
    console.log(
      "[db] Converted old appearances to office looks:",
      Object.entries(converted)
        .map(([t, n]) => `${t} ${n}`)
        .join(", "),
    );
  }
  return converted;
}

/** Drops the map editor tables. Idempotent — fine to run on every boot. */
function dropMapEditorTables(sqlite) {
  for (const table of MAP_EDITOR_TABLES) {
    sqlite.exec(`DROP TABLE IF EXISTS ${table}`);
  }
}

/**
 * The full map editor retirement bundle. Appearance conversion comes first — the result would
 * be the same if the table drop ran first, but keeping the order aligned with the PG migration
 * lets both dialects be read side by side.
 *
 * @param {import('better-sqlite3').Database} sqlite
 */
function retireMapEditor(sqlite) {
  normalizeLegacyAppearances(sqlite);
  dropMapEditorTables(sqlite);
}

module.exports = {
  MAP_EDITOR_TABLES,
  OFFICE_LOOK_IDS,
  FEMALE_LOOK_ID,
  DEFAULT_LOOK_ID,
  APPEARANCE_TABLES,
  normalizeAppearanceJson,
  normalizeLegacyAppearances,
  dropMapEditorTables,
  retireMapEditor,
};
