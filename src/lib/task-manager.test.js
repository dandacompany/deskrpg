/* eslint-disable @typescript-eslint/no-require-imports */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const Database = require("better-sqlite3");
const { drizzle } = require("drizzle-orm/better-sqlite3");
const { sqliteTable, text, integer, uniqueIndex } = require("drizzle-orm/sqlite-core");

const { TaskManager } = require("./task-manager.js");

const users = sqliteTable("users", {
  id: text("id").primaryKey(),
});

const channels = sqliteTable("channels", {
  id: text("id").primaryKey(),
});

const characters = sqliteTable("characters", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
});

const npcs = sqliteTable("npcs", {
  id: text("id").primaryKey(),
  channelId: text("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  positionX: integer("position_x").notNull(),
  positionY: integer("position_y").notNull(),
  direction: text("direction").default("down"),
  appearance: text("appearance").notNull(),
  openclawConfig: text("openclaw_config").notNull(),
  createdAt: text("created_at"),
  updatedAt: text("updated_at"),
});

const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  channelId: text("channel_id").notNull().references(() => channels.id),
  npcId: text("npc_id").notNull().references(() => npcs.id, { onDelete: "cascade" }),
  assignerId: text("assigner_id").notNull().references(() => characters.id),
  npcTaskId: text("npc_task_id").notNull(),
  title: text("title").notNull(),
  summary: text("summary"),
  status: text("status").notNull().default("pending"),
  autoNudgeCount: integer("auto_nudge_count").notNull().default(0),
  autoNudgeMax: integer("auto_nudge_max").notNull().default(5),
  lastNudgedAt: text("last_nudged_at"),
  lastReportedAt: text("last_reported_at"),
  stalledAt: text("stalled_at"),
  stalledReason: text("stalled_reason"),
  createdAt: text("created_at"),
  updatedAt: text("updated_at"),
  completedAt: text("completed_at"),
}, (table) => [
  uniqueIndex("idx_tasks_npc_task_id").on(table.npcId, table.npcTaskId),
]);

function createTaskTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY NOT NULL
    );
    CREATE TABLE channels (
      id TEXT PRIMARY KEY NOT NULL
    );
    CREATE TABLE characters (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE npcs (
      id TEXT PRIMARY KEY NOT NULL,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      position_x INTEGER NOT NULL,
      position_y INTEGER NOT NULL,
      direction TEXT DEFAULT 'down',
      appearance TEXT NOT NULL,
      openclaw_config TEXT NOT NULL,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY NOT NULL,
      channel_id TEXT NOT NULL REFERENCES channels(id),
      npc_id TEXT NOT NULL REFERENCES npcs(id) ON DELETE CASCADE,
      assigner_id TEXT NOT NULL REFERENCES characters(id),
      npc_task_id TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      auto_nudge_count INTEGER NOT NULL DEFAULT 0,
      auto_nudge_max INTEGER NOT NULL DEFAULT 5,
      last_nudged_at TEXT,
      last_reported_at TEXT,
      stalled_at TEXT,
      stalled_reason TEXT,
      created_at TEXT,
      updated_at TEXT,
      completed_at TEXT
    );
    CREATE UNIQUE INDEX idx_tasks_npc_task_id ON tasks(npc_id, npc_task_id);
  `);

  const db = drizzle(sqlite, { schema: { tasks, npcs } });

  sqlite.prepare("INSERT INTO users (id) VALUES (?)").run("user-1");
  sqlite.prepare("INSERT INTO channels (id) VALUES (?)").run("channel-1");
  sqlite.prepare("INSERT INTO characters (id, user_id) VALUES (?, ?)").run("character-1", "user-1");
  sqlite.prepare(
    "INSERT INTO npcs (id, channel_id, name, position_x, position_y, appearance, openclaw_config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "npc-1",
    "channel-1",
    "으뉴",
    10,
    10,
    "{}",
    "{}",
    "2026-03-31T00:00:00.000Z",
    "2026-03-31T00:00:00.000Z",
  );

  return { sqlite, db, manager: new TaskManager(db, { tasks, npcs }) };
}

test("handleTaskAction(create) initializes auto-nudge metadata", async () => {
  const { sqlite, manager } = createTaskTestDb();

  const created = await manager.handleTaskAction(
    { action: "create", id: "eunyu-1", title: "뉴스 조사", summary: "착수", status: "in_progress" },
    "channel-1",
    "npc-1",
    "character-1",
    { autoNudgeMax: 7 },
  );

  assert.equal(created?.status, "in_progress");
  assert.equal(created?.autoNudgeCount, 0);
  assert.equal(created?.autoNudgeMax, 7);
  assert.equal(typeof created?.lastReportedAt, "string");
  assert.equal(created?.stalledAt, null);

  const row = sqlite.prepare("SELECT auto_nudge_count, auto_nudge_max, last_reported_at FROM tasks WHERE npc_task_id = ?").get("eunyu-1");
  assert.equal(row.auto_nudge_count, 0);
  assert.equal(row.auto_nudge_max, 7);
  assert.equal(typeof row.last_reported_at, "string");
});

test("handleTaskAction(update) keeps lastReportedAt populated", async () => {
  const { sqlite, manager } = createTaskTestDb();

  await manager.handleTaskAction(
    { action: "create", id: "eunyu-1", title: "뉴스 조사", summary: "착수", status: "in_progress" },
    "channel-1",
    "npc-1",
    "character-1",
  );

  sqlite.prepare("UPDATE tasks SET last_reported_at = ? WHERE npc_task_id = ?").run("2026-03-31T00:01:00.000Z", "eunyu-1");

  const updated = await manager.handleTaskAction(
    { action: "update", id: "eunyu-1", title: "뉴스 조사", summary: "2차 조사", status: "in_progress" },
    "channel-1",
    "npc-1",
    "character-1",
  );

  assert.equal(updated?.status, "in_progress");
  assert.equal(updated?.summary, "2차 조사");
  assert.equal(typeof updated?.lastReportedAt, "string");
  assert.notEqual(updated?.lastReportedAt, "2026-03-31T00:01:00.000Z");
});

test("handleTaskAction(complete) and cancel keep report timestamps populated", async () => {
  const { manager } = createTaskTestDb();

  const created = await manager.handleTaskAction(
    { action: "create", id: "eunyu-1", title: "뉴스 조사", summary: "착수", status: "in_progress" },
    "channel-1",
    "npc-1",
    "character-1",
  );

  const complete = await manager.handleTaskAction(
    { action: "complete", id: "eunyu-1", title: "뉴스 조사", summary: "완료", status: "complete" },
    "channel-1",
    "npc-1",
    "character-1",
  );
  assert.equal(complete?.status, "complete");
  assert.equal(typeof complete?.lastReportedAt, "string");
  assert.equal(typeof complete?.completedAt, "string");

  const cancelled = await manager.handleTaskAction(
    { action: "cancel", id: "eunyu-2", title: "중단 작업", summary: "취소", status: "cancelled" },
    "channel-1",
    "npc-1",
    "character-1",
  );
  assert.equal(cancelled?.status, "cancelled");
  assert.equal(typeof cancelled?.lastReportedAt, "string");
  assert.equal(typeof cancelled?.completedAt, "string");

  assert.equal(typeof created?.lastReportedAt, "string");
});

test("markTaskNudged increments counter and sets lastNudgedAt", async () => {
  const { manager } = createTaskTestDb();
  const created = await manager.handleTaskAction(
    { action: "create", id: "eunyu-1", title: "뉴스 조사", summary: "착수", status: "in_progress" },
    "channel-1",
    "npc-1",
    "character-1",
  );

  const nudged = await manager.markTaskNudged(String(created?.id), "channel-1");

  assert.equal(nudged?.autoNudgeCount, 1);
  assert.equal(typeof nudged?.lastNudgedAt, "string");
});

test("markTaskStalled sets stalled status and metadata", async () => {
  const { manager } = createTaskTestDb();
  const created = await manager.handleTaskAction(
    { action: "create", id: "eunyu-1", title: "뉴스 조사", summary: "착수", status: "in_progress" },
    "channel-1",
    "npc-1",
    "character-1",
  );

  const stalled = await manager.markTaskStalled(String(created?.id), "channel-1", "max_nudges_reached");

  assert.equal(stalled?.status, "stalled");
  assert.equal(stalled?.stalledReason, "max_nudges_reached");
  assert.equal(typeof stalled?.stalledAt, "string");
});

test("resumeTask resets counters and returns in_progress", async () => {
  const { manager } = createTaskTestDb();
  const created = await manager.handleTaskAction(
    { action: "create", id: "eunyu-1", title: "뉴스 조사", summary: "착수", status: "in_progress" },
    "channel-1",
    "npc-1",
    "character-1",
  );

  await manager.markTaskNudged(String(created?.id), "channel-1");
  await manager.markTaskStalled(String(created?.id), "channel-1", "max_nudges_reached");
  const resumed = await manager.resumeTask(String(created?.id), "channel-1");

  assert.equal(resumed?.status, "in_progress");
  assert.equal(resumed?.autoNudgeCount, 0);
  assert.equal(resumed?.lastNudgedAt, null);
  assert.equal(resumed?.stalledAt, null);
  assert.equal(resumed?.stalledReason, null);
});

test("completeTask marks task complete and stamps completion time", async () => {
  const { manager } = createTaskTestDb();
  const created = await manager.handleTaskAction(
    { action: "create", id: "eunyu-3", title: "날씨 조사", summary: "진행중", status: "in_progress" },
    "channel-1",
    "npc-1",
    "character-1",
  );

  const completed = await manager.completeTask(String(created?.id), "channel-1");

  assert.equal(completed?.status, "complete");
  assert.equal(typeof completed?.completedAt, "string");
  assert.equal(typeof completed?.lastReportedAt, "string");
});

test("getStaleInProgressTasks prefers lastReportedAt when present", async () => {
  const { sqlite, manager } = createTaskTestDb();

  await manager.handleTaskAction(
    { action: "create", id: "eunyu-1", title: "오래된 작업", summary: "진행중", status: "in_progress" },
    "channel-1",
    "npc-1",
    "character-1",
  );
  sqlite.prepare(
    "UPDATE tasks SET updated_at = ?, last_reported_at = ? WHERE npc_task_id = ?",
  ).run("2026-03-31T00:01:00.000Z", "2026-03-31T00:09:00.000Z", "eunyu-1");

  const stale = await manager.getStaleInProgressTasks("channel-1", "2026-03-31T00:05:00.000Z");

  assert.deepEqual(stale.map((task) => task.npcTaskId), []);
});

test("getStaleInProgressTasks falls back to updatedAt when lastReportedAt is null", async () => {
  const { sqlite, manager } = createTaskTestDb();

  await manager.handleTaskAction(
    { action: "create", id: "eunyu-2", title: "예전 작업", summary: "진행중", status: "in_progress" },
    "channel-1",
    "npc-1",
    "character-1",
  );
  sqlite.prepare(
    "UPDATE tasks SET updated_at = ?, last_reported_at = NULL WHERE npc_task_id = ?",
  ).run("2026-03-31T00:01:00.000Z", "eunyu-2");

  const stale = await manager.getStaleInProgressTasks("channel-1", "2026-03-31T00:05:00.000Z");

  assert.deepEqual(stale.map((task) => task.npcTaskId), ["eunyu-2"]);
});
