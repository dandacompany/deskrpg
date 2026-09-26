// src/db/schema-drift.test.ts
//
// SCHEMA DRIFT GUARD
// ------------------
// The drizzle schema lives in two parallel copies per dialect:
//   - PostgreSQL: schema.ts (TS, drizzle-kit + Next.js app) | schema.pg.cjs (CJS, server.js runtime)
//   - SQLite:     schema-sqlite.ts (TS)                      | schema.sqlite.cjs (CJS, server.js runtime)
//
// drizzle-kit reads the .ts file to generate migrations; server.js requires the
// .cjs file at runtime. If a column / constraint is added in one place but not the
// other, the runtime ORM silently emits mis-shaped SQL (this exact failure mode
// broke the legacy task creation path in 2026-04). This test introspects the *compiled* drizzle
// table structure of each pair and asserts deep structural equality so the two
// definitions can never silently drift.
//
// We compare introspected structure (getTableConfig / getTableColumns) rather than
// source text, so cosmetic differences (export const vs const, randomUUID import,
// shared isoNow helper) are ignored while real schema changes are caught.

import { test } from "node:test";
import assert from "node:assert/strict";

import { getTableConfig as pgGetTableConfig } from "drizzle-orm/pg-core";
import { getTableConfig as sqliteGetTableConfig } from "drizzle-orm/sqlite-core";
import { getTableColumns } from "drizzle-orm";

import * as pgTs from "./schema";
import * as sqliteTs from "./schema-sqlite";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pgCjs = require("./schema.pg.cjs") as Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sqliteCjs = require("./schema.sqlite.cjs") as Record<string, unknown>;

const EXPECTED_TABLE_COUNT = 31;

type AnyTable = Record<string, unknown>;
type GetTableConfig = (table: unknown) => {
  name: string;
  schema?: string;
  columns: ColumnLike[];
  indexes: IndexLike[];
  foreignKeys: ForeignKeyLike[];
  uniqueConstraints?: UniqueConstraintLike[];
};

interface ColumnLike {
  name: string;
  dataType: string;
  columnType: string;
  notNull: boolean;
  primary: boolean;
  hasDefault: boolean;
  isUnique: boolean;
  uniqueName?: string | null;
  // PgVarchar / SQLiteText length etc. live on `config`.
  config?: Record<string, unknown>;
  length?: number;
  precision?: number;
  withTimezone?: boolean;
  enumValues?: unknown;
}

interface IndexLike {
  config: { name: string; unique: boolean; columns: Array<{ name?: string }> };
}

interface ForeignKeyLike {
  onDelete?: string;
  onUpdate?: string;
  reference: () => {
    columns: Array<{ name: string }>;
    foreignColumns: Array<{ name: string }>;
    foreignTable: unknown;
  };
}

interface UniqueConstraintLike {
  name?: string;
  columns: Array<{ name: string }>;
}

/** Stable, comparable snapshot of one column's structural attributes. */
function snapshotColumn(col: ColumnLike) {
  return {
    name: col.name,
    dataType: col.dataType,
    columnType: col.columnType,
    notNull: col.notNull,
    primary: col.primary,
    hasDefault: col.hasDefault,
    isUnique: col.isUnique,
    uniqueName: col.uniqueName ?? null,
    // varchar length matters for PG drift; undefined on dialects/types without it.
    length: col.length ?? (col.config?.length as number | undefined) ?? null,
    precision: col.precision ?? null,
    withTimezone: col.withTimezone ?? null,
  };
}

/** Stable snapshot of every index on a table, keyed by index name for legible diffs. */
function snapshotIndexes(indexes: IndexLike[]) {
  const out: Record<string, { unique: boolean; columns: string[] }> = {};
  for (const idx of indexes) {
    const c = idx.config;
    out[c.name] = {
      unique: Boolean(c.unique),
      columns: c.columns.map((col) => col?.name ?? "<expr>"),
    };
  }
  return out;
}

/** Stable snapshot of unique constraints (table-level `unique(...)`). */
function snapshotUniqueConstraints(
  getTableConfig: GetTableConfig,
  uniqueConstraints: UniqueConstraintLike[] | undefined,
) {
  const out: Record<string, string[]> = {};
  for (const u of uniqueConstraints ?? []) {
    if (!u.name) continue;
    out[u.name] = u.columns.map((c) => c.name);
  }
  return out;
}

/** Stable snapshot of foreign keys, keyed by local column set. */
function snapshotForeignKeys(getTableConfig: GetTableConfig, foreignKeys: ForeignKeyLike[]) {
  const out: Record<
    string,
    { foreignTable: string; foreignColumns: string[]; onDelete: string; onUpdate: string }
  > = {};
  for (const fk of foreignKeys) {
    const ref = fk.reference();
    const key = ref.columns
      .map((c) => c.name)
      .sort()
      .join(",");
    out[key] = {
      foreignTable: getTableConfig(ref.foreignTable).name,
      foreignColumns: ref.foreignColumns.map((c) => c.name),
      onDelete: fk.onDelete ?? "default",
      onUpdate: fk.onUpdate ?? "default",
    };
  }
  return out;
}

function snapshotTable(getTableConfig: GetTableConfig, table: unknown) {
  const cfg = getTableConfig(table);

  // Use getTableColumns for the authoritative column set; sort by SQL name.
  const columns = (Object.values(getTableColumns(table as never)) as unknown as ColumnLike[])
    .map(snapshotColumn)
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    name: cfg.name,
    schema: cfg.schema ?? null,
    columns,
    indexes: snapshotIndexes(cfg.indexes),
    uniqueConstraints: snapshotUniqueConstraints(getTableConfig, cfg.uniqueConstraints),
    foreignKeys: snapshotForeignKeys(getTableConfig, cfg.foreignKeys),
  };
}

function compareDialect(
  dialect: string,
  getTableConfig: GetTableConfig,
  tsModule: Record<string, unknown>,
  cjsModule: Record<string, unknown>,
) {
  const tsTables = Object.keys(tsModule).sort();
  const cjsTables = Object.keys(cjsModule).sort();

  assert.deepEqual(
    tsTables,
    cjsTables,
    `[${dialect}] Exported tables diverged.\n  .ts:  ${JSON.stringify(tsTables)}\n  .cjs: ${JSON.stringify(cjsTables)}`,
  );

  assert.equal(
    tsTables.length,
    EXPECTED_TABLE_COUNT,
    `[${dialect}] Expected ${EXPECTED_TABLE_COUNT} tables but found ${tsTables.length}. Update EXPECTED_TABLE_COUNT only when intentionally adding/removing a table.`,
  );

  for (const tableName of tsTables) {
    const tsTable = tsModule[tableName] as AnyTable;
    const cjsTable = cjsModule[tableName] as AnyTable;

    const tsSnap = snapshotTable(getTableConfig, tsTable);
    const cjsSnap = snapshotTable(getTableConfig, cjsTable);

    // Compare column-by-column first for the most legible failure messages.
    const tsColNames = tsSnap.columns.map((c) => c.name);
    const cjsColNames = cjsSnap.columns.map((c) => c.name);
    assert.deepEqual(
      tsColNames,
      cjsColNames,
      `[${dialect}] "${tableName}" column SET diverged.\n  .ts:  ${JSON.stringify(tsColNames)}\n  .cjs: ${JSON.stringify(cjsColNames)}`,
    );

    for (let i = 0; i < tsSnap.columns.length; i++) {
      assert.deepEqual(
        tsSnap.columns[i],
        cjsSnap.columns[i],
        `[${dialect}] "${tableName}".${tsSnap.columns[i].name} column structure diverged.\n  .ts:  ${JSON.stringify(tsSnap.columns[i])}\n  .cjs: ${JSON.stringify(cjsSnap.columns[i])}`,
      );
    }

    // SQL table name must match.
    assert.equal(
      tsSnap.name,
      cjsSnap.name,
      `[${dialect}] "${tableName}" SQL table name diverged: .ts=${tsSnap.name} .cjs=${cjsSnap.name}`,
    );

    // Indexes.
    assert.deepEqual(
      tsSnap.indexes,
      cjsSnap.indexes,
      `[${dialect}] "${tableName}" indexes diverged.\n  .ts:  ${JSON.stringify(tsSnap.indexes)}\n  .cjs: ${JSON.stringify(cjsSnap.indexes)}`,
    );

    // Unique constraints.
    assert.deepEqual(
      tsSnap.uniqueConstraints,
      cjsSnap.uniqueConstraints,
      `[${dialect}] "${tableName}" unique constraints diverged.\n  .ts:  ${JSON.stringify(tsSnap.uniqueConstraints)}\n  .cjs: ${JSON.stringify(cjsSnap.uniqueConstraints)}`,
    );

    // Foreign keys.
    assert.deepEqual(
      tsSnap.foreignKeys,
      cjsSnap.foreignKeys,
      `[${dialect}] "${tableName}" foreign keys diverged.\n  .ts:  ${JSON.stringify(tsSnap.foreignKeys)}\n  .cjs: ${JSON.stringify(cjsSnap.foreignKeys)}`,
    );

    // Full structural deep-equality as the catch-all.
    assert.deepEqual(
      tsSnap,
      cjsSnap,
      `[${dialect}] "${tableName}" structure diverged (full snapshot).`,
    );
  }
}

test("schema.ts and schema.pg.cjs are structurally identical (PostgreSQL)", () => {
  compareDialect(
    "postgresql",
    pgGetTableConfig as unknown as GetTableConfig,
    pgTs as unknown as Record<string, unknown>,
    pgCjs,
  );
});

test("schema-sqlite.ts and schema.sqlite.cjs are structurally identical (SQLite)", () => {
  compareDialect(
    "sqlite",
    sqliteGetTableConfig as unknown as GetTableConfig,
    sqliteTs as unknown as Record<string, unknown>,
    sqliteCjs,
  );
});

test("each dialect exports exactly the expected 31 tables", () => {
  assert.equal(Object.keys(pgCjs).length, EXPECTED_TABLE_COUNT, "schema.pg.cjs table count");
  assert.equal(
    Object.keys(sqliteCjs).length,
    EXPECTED_TABLE_COUNT,
    "schema.sqlite.cjs table count",
  );
  assert.equal(Object.keys(pgTs).length, EXPECTED_TABLE_COUNT, "schema.ts table count");
  assert.equal(Object.keys(sqliteTs).length, EXPECTED_TABLE_COUNT, "schema-sqlite.ts table count");
});

/**
 * PG ↔ SQLite cross-dialect parity. The two dialects have different types, so this doesn't
 * compare the whole structure, but the table and column *sets* must match — adding a table or
 * column to only one dialect produces "no such column" only on deployments using that dialect.
 * The kanban/cron ledger (0011) is the first thing this rule applies to.
 */
function columnNames(table: unknown): string[] {
  return Object.keys(getTableColumns(table as never)).sort();
}

test("the kanban/cron ledger tables have the same column set on both PG and SQLite", () => {
  for (const tableName of ["channelKanbanBoards", "cronJobOrigins"] as const) {
    for (const [dialect, mod] of [
      ["schema.ts", pgTs],
      ["schema.pg.cjs", pgCjs],
      ["schema-sqlite.ts", sqliteTs],
      ["schema.sqlite.cjs", sqliteCjs],
    ] as const) {
      assert.ok(tableName in mod, `${dialect} 에 ${tableName} 이 없습니다`);
    }
    assert.deepEqual(
      columnNames((sqliteTs as Record<string, unknown>)[tableName]),
      columnNames((pgTs as Record<string, unknown>)[tableName]),
      `${tableName} 의 컬럼 집합이 PG 와 SQLite 사이에서 갈렸습니다`,
    );
  }

  const boardCols = new Set(columnNames(pgTs.channelKanbanBoards));
  for (const required of [
    "channelId",
    "gatewayId",
    "boardSlug",
    "boardNameSyncedAt",
    "eventCursor",
    "eventCarrierHandoffJson",
    "lastPolledAt",
    "lastError",
    "createdAt",
    "updatedAt",
  ]) {
    assert.ok(boardCols.has(required), `channel_kanban_boards.${required} 가 없습니다`);
  }
  const originCols = new Set(columnNames(pgTs.cronJobOrigins));
  for (const required of [
    "id",
    "gatewayId",
    "profileName",
    "jobId",
    "channelId",
    "createdByUserId",
    "createdAt",
  ]) {
    assert.ok(originCols.has(required), `cron_job_origins.${required} 가 없습니다`);
  }
});

test("cron_job_origins is unique on (gateway_id, profile_name, job_id) in both dialects", () => {
  const pgCfg = pgGetTableConfig(pgTs.cronJobOrigins);
  const sqliteCfg = sqliteGetTableConfig(sqliteTs.cronJobOrigins);
  for (const [dialect, indexes] of [
    ["postgresql", pgCfg.indexes],
    ["sqlite", sqliteCfg.indexes],
  ] as const) {
    const unique = (indexes as unknown as IndexLike[]).find(
      (i) => i.config.unique && i.config.name === "cron_job_origins_gateway_profile_job_idx",
    );
    assert.ok(unique, `[${dialect}] cron_job_origins 의 유니크 인덱스가 없습니다`);
    assert.deepEqual(
      unique.config.columns.map((c) => c.name),
      ["gateway_id", "profile_name", "job_id"],
      `[${dialect}] 유니크 인덱스 컬럼이 다릅니다`,
    );
  }
});

test("notice_json/plugin_info_json columns exist in all four schema files", () => {
  for (const [dialect, mod] of [
    ["schema.ts", pgTs],
    ["schema.pg.cjs", pgCjs],
    ["schema-sqlite.ts", sqliteTs],
    ["schema.sqlite.cjs", sqliteCjs],
  ] as const) {
    const m = mod as Record<string, unknown>;
    assert.ok(
      "noticeJson" in getTableColumns(m.chatRoomMessages as never),
      `${dialect}: chat_room_messages.notice_json 이 없습니다`,
    );
    assert.ok(
      "pluginInfoJson" in getTableColumns(m.gatewayResources as never),
      `${dialect}: gateway_resources.plugin_info_json 이 없습니다`,
    );
  }
});
