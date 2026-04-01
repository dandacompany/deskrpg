import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import {
  buildCompletionReportRow,
  buildAutoExecutionPrompt,
  buildProgressNudgePrompt,
  buildResumeTaskExecutionPrompt,
  buildTaskActionStartMessage,
  buildGatewayConfig,
  enqueueCompletionReport,
  getPendingReportsForUserAndChannel,
  getProgressNudgeCutoff,
  getTaskAutomationConfig,
  markReportConsumed,
  markReportDelivered,
  mergeGatewayConfig,
  shouldDeliverCompletionReport,
} from "./task-reporting";

const require = createRequire(import.meta.url);
const { TaskManager } = require("./task-manager.js");

type Row = Record<string, unknown>;

function createColumn(name: string) {
  return { name };
}

function normalizeComparableValue(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  return value;
}

function getChunkText(chunk: unknown) {
  if (typeof chunk === "string") return chunk;
  if (chunk && typeof chunk === "object" && "value" in chunk) {
    return String((chunk as { value: string[] }).value[0] ?? "");
  }
  return "";
}

function evaluateSql(sqlNode: { queryChunks: unknown[] }, row: Row): unknown {
  const chunks = sqlNode.queryChunks;

  if (
    chunks.length === 5
    && typeof chunks[1] === "object"
    && chunks[1] !== null
    && "name" in (chunks[1] as Record<string, unknown>)
  ) {
    const fieldName = String((chunks[1] as { name: string }).name);
    const operator = getChunkText(chunks[2]).trim();
    const fieldValue = normalizeComparableValue(row[fieldName]);
    const compareValue = normalizeComparableValue(chunks[3]);

    if (operator === "=") return fieldValue === compareValue;
    if (operator === "<=") return String(fieldValue) <= String(compareValue);
  }

  if (
    chunks.length === 3
    && typeof chunks[1] === "object"
    && chunks[1] !== null
    && "name" in (chunks[1] as Record<string, unknown>)
  ) {
    const fieldName = String((chunks[1] as { name: string }).name);
    const operator = getChunkText(chunks[2]).trim();
    if (operator === "is null") return row[fieldName] == null;
    if (operator === "is not null") return row[fieldName] != null;
    if (operator === "asc") return { direction: "asc", fieldName };
    if (operator === "desc") return { direction: "desc", fieldName };
  }

  if (chunks.length === 3 && getChunkText(chunks[0]) === "(" && getChunkText(chunks[2]) === ")") {
    return evaluateSql(chunks[1] as { queryChunks: unknown[] }, row);
  }

  let result: boolean | null = null;
  let pendingOperator: "and" | "or" = "and";

  for (const chunk of chunks) {
    const text = getChunkText(chunk).trim().toLowerCase();
    if (text === "and") {
      pendingOperator = "and";
      continue;
    }
    if (text === "or") {
      pendingOperator = "or";
      continue;
    }
    if (chunk && typeof chunk === "object" && "queryChunks" in (chunk as Record<string, unknown>)) {
      const chunkResult = Boolean(evaluateSql(chunk as { queryChunks: unknown[] }, row));
      result = result == null
        ? chunkResult
        : pendingOperator === "and"
          ? result && chunkResult
          : result || chunkResult;
    }
  }

  return result ?? false;
}

function createReportSchema() {
  return {
    npcReports: {
      id: createColumn("id"),
      channelId: createColumn("channelId"),
      npcId: createColumn("npcId"),
      taskId: createColumn("taskId"),
      targetUserId: createColumn("targetUserId"),
      kind: createColumn("kind"),
      message: createColumn("message"),
      status: createColumn("status"),
      createdAt: createColumn("createdAt"),
      deliveredAt: createColumn("deliveredAt"),
      consumedAt: createColumn("consumedAt"),
    },
  };
}

function createReportDb(initialRows: Row[] = []) {
  const rows = [...initialRows];
  const state: {
    inserted: Row[];
    lastSet: Row | null;
    lastWhere: unknown;
    updates: Row[];
  } = {
    inserted: [],
    lastSet: null,
    lastWhere: null,
    updates: [],
  };

  return {
    rows,
    state,
    db: {
      insert() {
        return {
          values(value: Row) {
            state.inserted.push(value);
            const createdRow = { id: `report-${rows.length + 1}`, ...value };
            rows.push(createdRow);
            return {
              async returning() {
                return [createdRow];
              },
            };
          },
        };
      },
      update() {
        return {
          set(value: Row) {
            state.lastSet = value;
            return {
              async where(condition: unknown) {
                state.lastWhere = condition;
                state.updates.push(value);
                for (const row of rows) {
                  if (evaluateSql(condition as { queryChunks: unknown[] }, row)) {
                    Object.assign(row, value);
                  }
                }
              },
            };
          },
        };
      },
      select() {
        return {
          from() {
            return {
              where(condition: unknown) {
                const filteredRows = rows.filter((row) => Boolean(
                  evaluateSql(condition as { queryChunks: unknown[] }, row),
                ));

                return {
                  async orderBy(order: unknown) {
                    const orderSpec = evaluateSql(order as { queryChunks: unknown[] }, {});
                    if (orderSpec && typeof orderSpec === "object" && "fieldName" in orderSpec) {
                      const { fieldName, direction } = orderSpec as {
                        fieldName: string;
                        direction: "asc" | "desc";
                      };

                      return [...filteredRows].sort((left, right) => {
                        const leftValue = String(normalizeComparableValue(left[fieldName]) ?? "");
                        const rightValue = String(normalizeComparableValue(right[fieldName]) ?? "");
                        return direction === "asc"
                          ? leftValue.localeCompare(rightValue)
                          : rightValue.localeCompare(leftValue);
                      });
                    }

                    return filteredRows;
                  },
                };
              },
            };
          },
        };
      },
    },
  };
}

function createTaskSchema() {
  return {
    tasks: {
      channelId: createColumn("channelId"),
      status: createColumn("status"),
      lastReportedAt: createColumn("lastReportedAt"),
      updatedAt: createColumn("updatedAt"),
      createdAt: createColumn("createdAt"),
    },
    npcs: {
      name: createColumn("npcName"),
      id: createColumn("npcId"),
    },
  };
}

function createTaskSelectDb(rows: Row[]) {
  return {
    select() {
      return {
        from() {
          return {
            where(condition: unknown) {
              const filteredRows = rows.filter((row) => Boolean(
                evaluateSql(condition as { queryChunks: unknown[] }, row),
              ));

              return {
                async orderBy(order: unknown) {
                  const orderSpec = evaluateSql(order as { queryChunks: unknown[] }, {});
                  const { fieldName, direction } = orderSpec as {
                    fieldName: string;
                    direction: "asc" | "desc";
                  };

                  return [...filteredRows].sort((left, right) => {
                    const leftValue = String(normalizeComparableValue(left[fieldName]) ?? "");
                    const rightValue = String(normalizeComparableValue(right[fieldName]) ?? "");
                    return direction === "asc"
                      ? leftValue.localeCompare(rightValue)
                      : rightValue.localeCompare(leftValue);
                  });
                },
              };
            },
          };
        },
      };
    },
  };
}

test("getTaskAutomationConfig returns defaults when taskAutomation is missing", () => {
  assert.deepEqual(getTaskAutomationConfig(null), {
    autoProgressNudgeEnabled: false,
    autoProgressNudgeMinutes: 5,
    autoProgressNudgeMax: 5,
    reportWaitSeconds: 20,
  });
});

test("getTaskAutomationConfig reads provided taskAutomation values", () => {
  assert.deepEqual(
    getTaskAutomationConfig({
      taskAutomation: {
        autoProgressNudgeEnabled: true,
        autoProgressNudgeMinutes: 12,
        autoProgressNudgeMax: 8,
        reportWaitSeconds: 45,
      },
    }),
    {
      autoProgressNudgeEnabled: true,
      autoProgressNudgeMinutes: 12,
      autoProgressNudgeMax: 8,
      reportWaitSeconds: 45,
    },
  );
});

test("shouldDeliverCompletionReport only returns true for complete actions", () => {
  assert.equal(shouldDeliverCompletionReport({ action: "update" }), false);
  assert.equal(shouldDeliverCompletionReport({ action: "complete" }), true);
});

test("buildProgressNudgePrompt includes task identity and protocol reminder", () => {
  const prompt = buildProgressNudgePrompt({
    title: "오늘 최신 뉴스 파악",
    summary: "국제/경제 중심으로 정리",
    npcTaskId: "task-42",
  });

  assert.match(prompt, /오늘 최신 뉴스 파악/);
  assert.match(prompt, /task-42/);
  assert.match(prompt, /json:task/);
});

test("buildAutoExecutionPrompt asks NPC to continue execution and report with task block", () => {
  const prompt = buildAutoExecutionPrompt({
    title: "OpenClaw 최신 뉴스 조사",
    summary: "공식 문서와 커뮤니티 동향 확인",
    npcTaskId: "task-99",
  });

  assert.match(prompt, /실제로 수행/);
  assert.match(prompt, /task-99/);
  assert.match(prompt, /json:task/);
});

test("buildResumeTaskExecutionPrompt asks NPC to resume execution and report with task block", () => {
  const prompt = buildResumeTaskExecutionPrompt({
    title: "OpenClaw 최신 뉴스 조사",
    summary: "공식 문서와 커뮤니티 동향 확인",
    npcTaskId: "task-100",
  });

  assert.match(prompt, /다시 이어서 실제로 수행/);
  assert.match(prompt, /task-100/);
  assert.match(prompt, /json:task/);
});

test("buildTaskActionStartMessage returns distinct NPC acknowledgements", () => {
  assert.equal(
    buildTaskActionStartMessage({ title: "날씨 조사" }, "request-report"),
    "날씨 조사 업무를 처리하겠습니다.",
  );
  assert.equal(
    buildTaskActionStartMessage({ title: "날씨 조사" }, "resume"),
    "날씨 조사 업무를 재개합니다.",
  );
});

test("buildCompletionReportRow builds a pending queue row", () => {
  const row = buildCompletionReportRow({
    channelId: "ch",
    npcId: "npc",
    taskId: "task",
    targetUserId: "user",
    message: "보고 본문",
  });

  assert.equal(row.channelId, "ch");
  assert.equal(row.npcId, "npc");
  assert.equal(row.taskId, "task");
  assert.equal(row.targetUserId, "user");
  assert.equal(row.kind, "complete");
  assert.equal(row.status, "pending");
  assert.equal(row.message, "보고 본문");
  assert.equal(typeof row.createdAt, "string");
  assert.match(row.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(row.deliveredAt, null);
  assert.equal(row.consumedAt, null);
});

test("getProgressNudgeCutoff returns milliseconds from minutes", () => {
  assert.equal(getProgressNudgeCutoff(5, 1000), 1000 - 5 * 60 * 1000);
});

test("enqueueCompletionReport creates and returns a pending row", async () => {
  const schema = createReportSchema();
  const fake = createReportDb();
  const row = buildCompletionReportRow({
    channelId: "ch",
    npcId: "npc",
    taskId: "task",
    targetUserId: "user",
    message: "완료 보고",
  });

  const created = await enqueueCompletionReport(fake.db, schema, row);

  assert.equal(fake.state.inserted.length, 1);
  assert.equal(fake.state.inserted[0]?.status, "pending");
  assert.equal(created?.id, "report-1");
  assert.equal(created?.status, "pending");
  assert.equal(created?.message, "완료 보고");
  assert.equal(created?.deliveredAt, null);
  assert.equal(created?.consumedAt, null);
});

test("markReportDelivered and markReportConsumed update status and timestamps", async () => {
  const schema = createReportSchema();
  const fake = createReportDb([
    {
      id: "report-1",
      channelId: "ch",
      npcId: "npc",
      taskId: "task",
      targetUserId: "user",
      kind: "complete",
      message: "완료 보고",
      status: "pending",
      createdAt: "2026-03-31T00:00:00.000Z",
      deliveredAt: null,
      consumedAt: null,
    },
  ]);

  await markReportDelivered(fake.db, schema, "report-1");
  assert.equal(fake.rows[0]?.status, "delivered");
  assert.equal(typeof fake.rows[0]?.deliveredAt, "string");
  assert.match(String(fake.rows[0]?.deliveredAt), /^\d{4}-\d{2}-\d{2}T/);

  await markReportConsumed(fake.db, schema, "report-1");
  assert.equal(fake.rows[0]?.status, "consumed");
  assert.equal(typeof fake.rows[0]?.consumedAt, "string");
  assert.match(String(fake.rows[0]?.consumedAt), /^\d{4}-\d{2}-\d{2}T/);
});

test("getPendingReportsForUserAndChannel returns unconsumed rows and orders by createdAt", async () => {
  const schema = createReportSchema();
  const fake = createReportDb([
    {
      id: "report-3",
      channelId: "ch",
      npcId: "npc",
      taskId: "task-3",
      targetUserId: "user",
      kind: "complete",
      message: "세 번째",
      status: "pending",
      createdAt: new Date("2026-03-31T00:03:00.000Z"),
      deliveredAt: null,
      consumedAt: null,
    },
    {
      id: "report-2",
      channelId: "ch",
      npcId: "npc",
      taskId: "task-2",
      targetUserId: "user",
      kind: "complete",
      message: "두 번째",
      status: "delivered",
      createdAt: "2026-03-31T00:02:00.000Z",
      deliveredAt: "2026-03-31T00:02:30.000Z",
      consumedAt: null,
    },
    {
      id: "report-4",
      channelId: "other-channel",
      npcId: "npc",
      taskId: "task-4",
      targetUserId: "user",
      kind: "complete",
      message: "다른 채널",
      status: "pending",
      createdAt: "2026-03-31T00:04:00.000Z",
      deliveredAt: null,
      consumedAt: null,
    },
    {
      id: "report-1",
      channelId: "ch",
      npcId: "npc",
      taskId: "task-1",
      targetUserId: "user",
      kind: "complete",
      message: "첫 번째",
      status: "pending",
      createdAt: "2026-03-31T00:01:00.000Z",
      deliveredAt: null,
      consumedAt: null,
    },
    {
      id: "report-5",
      channelId: "ch",
      npcId: "npc",
      taskId: "task-5",
      targetUserId: "other-user",
      kind: "complete",
      message: "다른 사용자",
      status: "pending",
      createdAt: "2026-03-31T00:05:00.000Z",
      deliveredAt: null,
      consumedAt: null,
    },
    {
      id: "report-6",
      channelId: "ch",
      npcId: "npc",
      taskId: "task-6",
      targetUserId: "user",
      kind: "complete",
      message: "이미 소비됨",
      status: "pending",
      createdAt: "2026-03-31T00:06:00.000Z",
      deliveredAt: null,
      consumedAt: "2026-03-31T00:06:30.000Z",
    },
  ]);

  const reports = await getPendingReportsForUserAndChannel(fake.db, schema, {
    channelId: "ch",
    userId: "user",
  });

  assert.deepEqual(reports.map((report) => report.id), ["report-1", "report-2", "report-3"]);
  assert.equal(reports[0]?.createdAt, "2026-03-31T00:01:00.000Z");
  assert.equal(reports[1]?.createdAt, "2026-03-31T00:02:00.000Z");
  assert.equal(reports[2]?.createdAt, "2026-03-31T00:03:00.000Z");
});

test("TaskManager.getStaleInProgressTasks filters by channel and cutoff and normalizes timestamps", async () => {
  const taskManager = new TaskManager(
    createTaskSelectDb([
      {
        id: "task-1",
        channelId: "ch",
        npcId: "npc-1",
        assignerId: "user-1",
        npcTaskId: "npc-task-1",
        title: "oldest",
        summary: "stale",
        status: "in_progress",
        createdAt: new Date("2026-03-31T00:00:00.000Z"),
        updatedAt: new Date("2026-03-31T00:01:00.000Z"),
        lastReportedAt: null,
        completedAt: null,
      },
      {
        id: "task-2",
        channelId: "ch",
        npcId: "npc-2",
        assignerId: "user-1",
        npcTaskId: "npc-task-2",
        title: "newer stale",
        summary: "stale",
        status: "in_progress",
        createdAt: "2026-03-31T00:02:00.000Z",
        updatedAt: "2026-03-31T00:03:00.000Z",
        lastReportedAt: null,
        completedAt: null,
      },
      {
        id: "task-3",
        channelId: "ch",
        npcId: "npc-3",
        assignerId: "user-1",
        npcTaskId: "npc-task-3",
        title: "too new",
        summary: "active",
        status: "in_progress",
        createdAt: "2026-03-31T00:04:00.000Z",
        updatedAt: "2026-03-31T00:10:00.000Z",
        lastReportedAt: "2026-03-31T00:10:00.000Z",
        completedAt: null,
      },
      {
        id: "task-4",
        channelId: "other-channel",
        npcId: "npc-4",
        assignerId: "user-1",
        npcTaskId: "npc-task-4",
        title: "other channel",
        summary: "stale",
        status: "in_progress",
        createdAt: "2026-03-31T00:00:00.000Z",
        updatedAt: "2026-03-31T00:02:00.000Z",
        lastReportedAt: null,
        completedAt: null,
      },
      {
        id: "task-5",
        channelId: "ch",
        npcId: "npc-5",
        assignerId: "user-1",
        npcTaskId: "npc-task-5",
        title: "wrong status",
        summary: "done",
        status: "complete",
        createdAt: "2026-03-31T00:00:00.000Z",
        updatedAt: "2026-03-31T00:01:30.000Z",
        lastReportedAt: "2026-03-31T00:01:30.000Z",
        completedAt: new Date("2026-03-31T00:02:00.000Z"),
      },
    ]),
    createTaskSchema(),
  );

  const tasks = await taskManager.getStaleInProgressTasks("ch", "2026-03-31T00:05:00.000Z");

  assert.deepEqual(tasks.map((task: { id: string }) => task.id), ["task-2", "task-1"]);
  assert.equal(tasks[0]?.updatedAt, "2026-03-31T00:03:00.000Z");
  assert.equal(tasks[1]?.updatedAt, "2026-03-31T00:01:00.000Z");
  assert.equal(tasks[1]?.createdAt, "2026-03-31T00:00:00.000Z");
});

test("buildGatewayConfig trims credentials and defaults taskAutomation", () => {
  assert.deepEqual(
    buildGatewayConfig({
      url: "  https://gateway.example.com  ",
      token: "  secret-token  ",
    }),
    {
      url: "https://gateway.example.com",
      token: "secret-token",
      taskAutomation: {
        autoProgressNudgeEnabled: false,
        autoProgressNudgeMinutes: 5,
        autoProgressNudgeMax: 5,
        reportWaitSeconds: 20,
      },
    },
  );
});

test("buildGatewayConfig parses stringified gateway config", () => {
  assert.deepEqual(
    buildGatewayConfig(
      JSON.stringify({
        url: "  https://gateway.example.com  ",
        token: "  secret-token  ",
        taskAutomation: {
          autoProgressNudgeEnabled: true,
          autoProgressNudgeMax: 5,
          reportWaitSeconds: 30,
        },
      }),
    ),
    {
      url: "https://gateway.example.com",
      token: "secret-token",
      taskAutomation: {
        autoProgressNudgeEnabled: true,
        autoProgressNudgeMinutes: 5,
        autoProgressNudgeMax: 5,
        reportWaitSeconds: 30,
      },
    },
  );
});

test("mergeGatewayConfig preserves url and token when only taskAutomation changes", () => {
  assert.deepEqual(
    mergeGatewayConfig(
      {
        url: "https://gateway.example.com",
        token: "secret-token",
        taskAutomation: {
          autoProgressNudgeEnabled: false,
          autoProgressNudgeMinutes: 5,
          autoProgressNudgeMax: 5,
          reportWaitSeconds: 20,
        },
      },
      {
        taskAutomation: {
          autoProgressNudgeEnabled: true,
          autoProgressNudgeMinutes: 9,
          autoProgressNudgeMax: 7,
        },
      },
    ),
    {
      url: "https://gateway.example.com",
      token: "secret-token",
      taskAutomation: {
        autoProgressNudgeEnabled: true,
        autoProgressNudgeMinutes: 9,
        autoProgressNudgeMax: 7,
        reportWaitSeconds: 20,
      },
    },
  );
});

test("mergeGatewayConfig preserves existing nested taskAutomation values on partial patch", () => {
  assert.deepEqual(
    mergeGatewayConfig(
      {
        url: "https://gateway.example.com",
        token: "secret-token",
        taskAutomation: {
          autoProgressNudgeEnabled: true,
          autoProgressNudgeMinutes: 9,
          autoProgressNudgeMax: 11,
          reportWaitSeconds: 45,
        },
      },
      {
        taskAutomation: {
          autoProgressNudgeEnabled: false,
        },
      },
    ),
    {
      url: "https://gateway.example.com",
      token: "secret-token",
      taskAutomation: {
        autoProgressNudgeEnabled: false,
        autoProgressNudgeMinutes: 9,
        autoProgressNudgeMax: 11,
        reportWaitSeconds: 45,
      },
    },
  );
});

test("mergeGatewayConfig parses stringified inputs and clears fields explicitly set to null", () => {
  assert.deepEqual(
    mergeGatewayConfig(
      JSON.stringify({
        url: "https://gateway.example.com",
        token: "secret-token",
        taskAutomation: {
          autoProgressNudgeEnabled: true,
          autoProgressNudgeMinutes: 9,
          autoProgressNudgeMax: 11,
          reportWaitSeconds: 45,
        },
      }),
      JSON.stringify({
        url: null,
        taskAutomation: {
          reportWaitSeconds: 15,
        },
      }),
    ),
    {
      url: null,
      token: "secret-token",
      taskAutomation: {
        autoProgressNudgeEnabled: true,
        autoProgressNudgeMinutes: 9,
        autoProgressNudgeMax: 11,
        reportWaitSeconds: 15,
      },
    },
  );
});
