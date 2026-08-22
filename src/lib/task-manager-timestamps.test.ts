// src/lib/task-manager-timestamps.test.ts
//
// TASKMANAGER TIMESTAMP BRANCH GUARD
// ----------------------------------
// TaskManager runs against two storage engines through one code path:
//   - PostgreSQL: drizzle pg-core `timestamp(..., { withTimezone: true })` columns are
//     created in `date` mode, so the driver expects a JS `Date` object (it calls
//     .toISOString() itself). Passing an ISO *string* would be mis-bound.
//   - SQLite: `text` columns expect a primitive string; a Date object would be coerced
//     unpredictably.
//
// `_nowForDb()` and the `getStaleInProgressTasks` cutoff therefore branch on the
// `isPostgres` option (mirrors gateway-resources.ts nowForDb()). This test locks in
// that branch by capturing the exact payloads TaskManager hands to drizzle and
// asserting the value TYPE (Date vs ISO string) for each timestamp it writes/compares.
//
// It uses a minimal hand-rolled chainable fake db (no real DB) so the assertion is on
// the values flowing INTO drizzle, independent of any dialect-specific driver behavior.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { Param } from "drizzle-orm";

// Import the real SQLite column references so fakeSchema.tasks.* are faithful
// drizzle column objects (lte() etc. accept them).
import { tasks as sqliteTasks, npcs as sqliteNpcs } from "../db/schema.sqlite.cjs";

const require = createRequire(import.meta.url);
const { TaskManager } = require("./task-manager.js") as {
  TaskManager: new (
    db: unknown,
    schema: unknown,
    opts?: { isPostgres?: boolean },
  ) => {
    _nowForDb(): Date | string;
    completeTask(taskId: string, channelId: string): Promise<Record<string, unknown> | null>;
    markTaskNudged(taskId: string, channelId: string): Promise<Record<string, unknown> | null>;
    markTaskStalled(
      taskId: string,
      channelId: string,
      reason?: string,
    ): Promise<Record<string, unknown> | null>;
    resumeTask(taskId: string, channelId: string): Promise<Record<string, unknown> | null>;
    moveTask(
      taskId: string,
      channelId: string,
      toStatus: string,
      npcId: string | null,
      options?: { expectedFromStatus?: string },
    ): Promise<Record<string, unknown> | null>;
    getStaleInProgressTasks(
      channelId: string,
      olderThanIso: string,
    ): Promise<Record<string, unknown>[]>;
  };
};

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

// ── Minimal chainable fake drizzle db ────────────────────────────────────────
// Records the payload passed to .set(...) / .values(...) and the SQL expression
// passed to .where(...). Returns `this` for intermediate ops and a stub row from
// .returning() / .limit(). drizzle chains are thenable-free here (TaskManager
// awaits the final builder), so we make the builder a thenable resolving to rows.

interface Capture {
  setPayloads: Record<string, unknown>[];
  valuesPayloads: Record<string, unknown>[];
  whereArgs: unknown[];
}

function makeFakeDb(capture: Capture, returnRow: Record<string, unknown> | null) {
  const rows = returnRow ? [returnRow] : [];

  // A builder that is chainable AND awaitable (thenable) resolving to `rows`.
  const builder: Record<string, (...a: unknown[]) => unknown> & PromiseLike<unknown[]> = {
    set(payload: Record<string, unknown>) {
      capture.setPayloads.push(payload);
      return builder;
    },
    values(payload: Record<string, unknown>) {
      capture.valuesPayloads.push(payload);
      return builder;
    },
    onConflictDoUpdate(arg: { set?: Record<string, unknown> }) {
      if (arg?.set) capture.setPayloads.push(arg.set);
      return builder;
    },
    where(arg: unknown) {
      capture.whereArgs.push(arg);
      return builder;
    },
    from() {
      return builder;
    },
    leftJoin() {
      return builder;
    },
    orderBy() {
      return builder;
    },
    limit() {
      // Used by getTaskById's select chain; resolve to a row synchronously.
      return Promise.resolve(rows);
    },
    returning() {
      return Promise.resolve(rows);
    },
    // Make the builder itself awaitable (e.g. getStaleInProgressTasks awaits the
    // builder after .orderBy()).
    then(onfulfilled?: ((value: unknown[]) => unknown) | null) {
      return Promise.resolve(rows).then(onfulfilled ?? undefined);
    },
  } as never;

  return {
    insert() {
      return builder;
    },
    update() {
      return builder;
    },
    delete() {
      return builder;
    },
    select() {
      return builder;
    },
  };
}

// A representative existing row (used where TaskManager reads-before-write, e.g.
// markTaskNudged calls getTaskById first). Timestamp fields are returned as ISO
// strings; normalizeTask() handles both Date and string, so this is dialect-neutral.
function fakeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "task-1",
    channelId: "channel-1",
    npcId: "npc-1",
    assignerId: "character-1",
    npcTaskId: "eunyu-1",
    title: "작업",
    summary: null,
    status: "in_progress",
    autoNudgeCount: 2,
    autoNudgeMax: 5,
    lastNudgedAt: null,
    lastReportedAt: null,
    stalledAt: null,
    stalledReason: null,
    createdAt: "2026-03-31T00:00:00.000Z",
    updatedAt: "2026-03-31T00:00:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

const fakeSchema = { tasks: sqliteTasks, npcs: sqliteNpcs };

/** Walk a drizzle SQL expression and collect every bound Param value. */
function collectParamValues(
  node: unknown,
  acc: unknown[],
  seen = new Set<unknown>(),
  depth = 0,
): unknown[] {
  // The cutoff is bound inside and(eq, eq, or(and(lte..), and(lte..))), so the
  // lte() Params sit deep in the SQL chunk tree (~depth 14). Allow generous depth.
  if (depth > 40 || node == null || typeof node !== "object") return acc;
  if (seen.has(node)) return acc;
  seen.add(node);
  if (node instanceof Param) {
    acc.push((node as { value: unknown }).value);
    return acc;
  }
  const children = Array.isArray(node) ? node : Object.values(node as Record<string, unknown>);
  for (const child of children) collectParamValues(child, acc, seen, depth + 1);
  return acc;
}

// ── _nowForDb() direct branch ─────────────────────────────────────────────────

test("_nowForDb returns a Date in PG mode and an ISO string in SQLite mode", () => {
  const pgMgr = new TaskManager({}, fakeSchema, { isPostgres: true });
  const sqliteMgr = new TaskManager({}, fakeSchema, { isPostgres: false });

  const pgNow = pgMgr._nowForDb();
  const sqliteNow = sqliteMgr._nowForDb();

  assert.ok(pgNow instanceof Date, `PG mode expected Date, got ${typeof pgNow}`);
  assert.equal(typeof sqliteNow, "string", "SQLite mode expected string");
  assert.match(sqliteNow as string, ISO_RE);
});

test("default (no options) behaves as SQLite — ISO string", () => {
  const mgr = new TaskManager({}, fakeSchema);
  const now = mgr._nowForDb();
  assert.equal(typeof now, "string");
  assert.match(now as string, ISO_RE);
});

// ── completeTask: writes completedAt / lastReportedAt / updatedAt ─────────────

test("completeTask writes Date timestamps in PG mode", async () => {
  const capture: Capture = { setPayloads: [], valuesPayloads: [], whereArgs: [] };
  const db = makeFakeDb(capture, fakeRow({ status: "complete" }));
  const mgr = new TaskManager(db, fakeSchema, { isPostgres: true });

  await mgr.completeTask("task-1", "channel-1");

  assert.equal(capture.setPayloads.length, 1, "expected exactly one .set() call");
  const payload = capture.setPayloads[0];
  for (const field of ["completedAt", "lastReportedAt", "updatedAt"] as const) {
    assert.ok(
      payload[field] instanceof Date,
      `PG completeTask: ${field} should be a Date, got ${typeof payload[field]}`,
    );
  }
});

test("completeTask writes ISO-string timestamps in SQLite mode", async () => {
  const capture: Capture = { setPayloads: [], valuesPayloads: [], whereArgs: [] };
  const db = makeFakeDb(capture, fakeRow({ status: "complete" }));
  const mgr = new TaskManager(db, fakeSchema, { isPostgres: false });

  await mgr.completeTask("task-1", "channel-1");

  const payload = capture.setPayloads[0];
  for (const field of ["completedAt", "lastReportedAt", "updatedAt"] as const) {
    assert.equal(
      typeof payload[field],
      "string",
      `SQLite completeTask: ${field} should be a string`,
    );
    assert.match(
      payload[field] as string,
      ISO_RE,
      `SQLite completeTask: ${field} should be ISO-8601`,
    );
  }
});

// ── markTaskNudged: reads (getTaskById) then writes lastNudgedAt / updatedAt ──

test("markTaskNudged writes Date timestamps in PG mode", async () => {
  const capture: Capture = { setPayloads: [], valuesPayloads: [], whereArgs: [] };
  // getTaskById (select.limit) and the update.returning both resolve to this row.
  const db = makeFakeDb(capture, fakeRow());
  const mgr = new TaskManager(db, fakeSchema, { isPostgres: true });

  await mgr.markTaskNudged("task-1", "channel-1");

  // The .set() payload is from the update branch.
  const payload = capture.setPayloads.at(-1)!;
  assert.ok(
    payload.lastNudgedAt instanceof Date,
    "PG markTaskNudged: lastNudgedAt should be a Date",
  );
  assert.ok(payload.updatedAt instanceof Date, "PG markTaskNudged: updatedAt should be a Date");
  // autoNudgeCount is a number, not a timestamp.
  assert.equal(
    payload.autoNudgeCount,
    3,
    "autoNudgeCount should increment from the read row (2 -> 3)",
  );
});

test("markTaskNudged writes ISO-string timestamps in SQLite mode", async () => {
  const capture: Capture = { setPayloads: [], valuesPayloads: [], whereArgs: [] };
  const db = makeFakeDb(capture, fakeRow());
  const mgr = new TaskManager(db, fakeSchema, { isPostgres: false });

  await mgr.markTaskNudged("task-1", "channel-1");

  const payload = capture.setPayloads.at(-1)!;
  assert.equal(
    typeof payload.lastNudgedAt,
    "string",
    "SQLite markTaskNudged: lastNudgedAt should be a string",
  );
  assert.match(payload.lastNudgedAt as string, ISO_RE);
  assert.equal(typeof payload.updatedAt, "string");
  assert.match(payload.updatedAt as string, ISO_RE);
});

// ── markTaskStalled: writes stalledAt / updatedAt ─────────────────────────────

test("markTaskStalled writes Date timestamps in PG mode", async () => {
  const capture: Capture = { setPayloads: [], valuesPayloads: [], whereArgs: [] };
  const db = makeFakeDb(capture, fakeRow({ status: "stalled" }));
  const mgr = new TaskManager(db, fakeSchema, { isPostgres: true });

  await mgr.markTaskStalled("task-1", "channel-1", "max_nudges_reached");

  const payload = capture.setPayloads[0];
  assert.ok(payload.stalledAt instanceof Date, "PG markTaskStalled: stalledAt should be a Date");
  assert.ok(payload.updatedAt instanceof Date, "PG markTaskStalled: updatedAt should be a Date");
  assert.equal(payload.stalledReason, "max_nudges_reached");
  assert.equal(payload.status, "stalled");
});

test("markTaskStalled writes ISO-string timestamps in SQLite mode", async () => {
  const capture: Capture = { setPayloads: [], valuesPayloads: [], whereArgs: [] };
  const db = makeFakeDb(capture, fakeRow({ status: "stalled" }));
  const mgr = new TaskManager(db, fakeSchema, { isPostgres: false });

  await mgr.markTaskStalled("task-1", "channel-1", "max_nudges_reached");

  const payload = capture.setPayloads[0];
  assert.equal(
    typeof payload.stalledAt,
    "string",
    "SQLite markTaskStalled: stalledAt should be a string",
  );
  assert.match(payload.stalledAt as string, ISO_RE);
  assert.equal(typeof payload.updatedAt, "string");
  assert.match(payload.updatedAt as string, ISO_RE);
});

// ── resumeTask: writes updatedAt (and nulls the nudge fields) ──────────────────

test("resumeTask writes a Date updatedAt in PG mode and nulls nudge fields", async () => {
  const capture: Capture = { setPayloads: [], valuesPayloads: [], whereArgs: [] };
  const db = makeFakeDb(capture, fakeRow({ status: "in_progress" }));
  const mgr = new TaskManager(db, fakeSchema, { isPostgres: true });

  await mgr.resumeTask("task-1", "channel-1");

  const payload = capture.setPayloads[0];
  assert.ok(payload.updatedAt instanceof Date, "PG resumeTask: updatedAt should be a Date");
  assert.equal(payload.lastNudgedAt, null);
  assert.equal(payload.stalledAt, null);
  assert.equal(payload.autoNudgeCount, 0);
});

test("resumeTask writes an ISO-string updatedAt in SQLite mode", async () => {
  const capture: Capture = { setPayloads: [], valuesPayloads: [], whereArgs: [] };
  const db = makeFakeDb(capture, fakeRow({ status: "in_progress" }));
  const mgr = new TaskManager(db, fakeSchema, { isPostgres: false });

  await mgr.resumeTask("task-1", "channel-1");

  const payload = capture.setPayloads[0];
  assert.equal(typeof payload.updatedAt, "string");
  assert.match(payload.updatedAt as string, ISO_RE);
});

// ── moveTask: completedAt / updatedAt branch (read-before-write) ───────────────

test("moveTask -> complete writes Date timestamps in PG mode", async () => {
  const capture: Capture = { setPayloads: [], valuesPayloads: [], whereArgs: [] };
  // getTaskById returns a pending row; update.returning returns the completed row.
  const db = makeFakeDb(capture, fakeRow({ status: "complete" }));
  const mgr = new TaskManager(db, fakeSchema, { isPostgres: true });

  await mgr.moveTask("task-1", "channel-1", "complete", "npc-1");

  const payload = capture.setPayloads.at(-1)!;
  assert.ok(payload.updatedAt instanceof Date, "PG moveTask: updatedAt should be a Date");
  assert.ok(payload.completedAt instanceof Date, "PG moveTask: completedAt should be a Date");
});

test("moveTask -> complete writes ISO-string timestamps in SQLite mode", async () => {
  const capture: Capture = { setPayloads: [], valuesPayloads: [], whereArgs: [] };
  const db = makeFakeDb(capture, fakeRow({ status: "complete" }));
  const mgr = new TaskManager(db, fakeSchema, { isPostgres: false });

  await mgr.moveTask("task-1", "channel-1", "complete", "npc-1");

  const payload = capture.setPayloads.at(-1)!;
  assert.equal(typeof payload.updatedAt, "string");
  assert.match(payload.updatedAt as string, ISO_RE);
  assert.equal(typeof payload.completedAt, "string");
  assert.match(payload.completedAt as string, ISO_RE);
});

// ── getStaleInProgressTasks: cutoff bound into lte() must be Date(PG)/string(SQLite)

test("getStaleInProgressTasks binds a Date cutoff in PG mode", async () => {
  const capture: Capture = { setPayloads: [], valuesPayloads: [], whereArgs: [] };
  const db = makeFakeDb(capture, null); // no rows needed; we inspect the WHERE clause
  const mgr = new TaskManager(db, fakeSchema, { isPostgres: true });

  const olderThanIso = "2026-03-31T00:05:00.000Z";
  await mgr.getStaleInProgressTasks("channel-1", olderThanIso);

  assert.equal(capture.whereArgs.length, 1, "expected one .where() clause");
  const params = collectParamValues(capture.whereArgs[0], []);
  // The cutoff appears in the lte() comparisons. Find params equal to the cutoff instant.
  const cutoffParams = params.filter(
    (p) => p instanceof Date && (p as Date).toISOString() === olderThanIso,
  );
  assert.ok(
    cutoffParams.length >= 1,
    `PG getStaleInProgressTasks: cutoff should be bound as a Date. Found param types: ${params
      .map((p) => (p instanceof Date ? "Date" : typeof p))
      .join(", ")}`,
  );
  // And there must be NO string cutoff bound (the channel-id string is fine, but the
  // cutoff itself must not be a string).
  const stringCutoff = params.filter((p) => typeof p === "string" && p === olderThanIso);
  assert.equal(stringCutoff.length, 0, "PG mode must not bind the cutoff as a raw ISO string");
});

test("getStaleInProgressTasks binds a raw ISO-string cutoff in SQLite mode", async () => {
  const capture: Capture = { setPayloads: [], valuesPayloads: [], whereArgs: [] };
  const db = makeFakeDb(capture, null);
  const mgr = new TaskManager(db, fakeSchema, { isPostgres: false });

  const olderThanIso = "2026-03-31T00:05:00.000Z";
  await mgr.getStaleInProgressTasks("channel-1", olderThanIso);

  const params = collectParamValues(capture.whereArgs[0], []);
  const stringCutoff = params.filter((p) => typeof p === "string" && p === olderThanIso);
  assert.ok(
    stringCutoff.length >= 1,
    `SQLite getStaleInProgressTasks: cutoff should be bound as the raw ISO string. Found param types: ${params
      .map((p) => (p instanceof Date ? "Date" : typeof p))
      .join(", ")}`,
  );
  // No Date cutoff should be bound in SQLite mode.
  const dateCutoff = params.filter((p) => p instanceof Date);
  assert.equal(dateCutoff.length, 0, "SQLite mode must not bind the cutoff as a Date object");
});
