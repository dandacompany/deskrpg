import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, test } from "node:test";

import { DmHub } from "./dm-hub";

const require = createRequire(import.meta.url);

describe("DmHub.processResponseMarkers", () => {
  test("extracts NEED_TASK_DETAIL markers with taskId", () => {
    const hub = new DmHub();
    const result = hub.processResponseMarkers("상세 확인이 필요합니다. [NEED_TASK_DETAIL:T-12]");

    assert.deepEqual(result.markers, [{ type: "need_detail", taskId: "T-12" }]);
    assert.equal(result.finalResponse, "상세 확인이 필요합니다.");
  });

  test("extracts CONTINUE_TASK markers with taskId", () => {
    const hub = new DmHub();
    const result = hub.processResponseMarkers("이어서 진행하겠습니다. [CONTINUE_TASK:T-7]");

    assert.deepEqual(result.markers, [{ type: "continue_task", taskId: "T-7" }]);
    assert.equal(result.finalResponse, "이어서 진행하겠습니다.");
  });

  test("removes markers from finalResponse", () => {
    const hub = new DmHub();
    const result = hub.processResponseMarkers(
      "응답 [NEED_TASK_DETAIL:T-1] 본문 [CONTINUE_TASK:T-2]",
    );

    assert.equal(result.finalResponse, "응답  본문");
  });

  test("handles response with no markers", () => {
    const hub = new DmHub();
    const result = hub.processResponseMarkers("일반 응답입니다.");

    assert.equal(result.finalResponse, "일반 응답입니다.");
    assert.deepEqual(result.markers, []);
  });

  test("handles multiple markers", () => {
    const hub = new DmHub();
    const result = hub.processResponseMarkers(
      "[NEED_TASK_DETAIL:T-1] 먼저 확인하고 [CONTINUE_TASK:T-2] 이어서 [NEED_TASK_DETAIL:T-3]",
    );

    assert.deepEqual(result.markers, [
      { type: "need_detail", taskId: "T-1" },
      { type: "continue_task", taskId: "T-2" },
      { type: "need_detail", taskId: "T-3" },
    ]);
    assert.equal(result.finalResponse, "먼저 확인하고  이어서");
  });

  test("handles empty response", () => {
    const hub = new DmHub();
    const result = hub.processResponseMarkers("");

    assert.equal(result.finalResponse, "");
    assert.deepEqual(result.markers, []);
  });
});

describe("DmHub.buildTaskDashboard", () => {
  test("returns empty string when no active tasks", async () => {
    const hub = new DmHub();
    const taskManagerModule = require("../task-manager.js") as { TaskManager: unknown };
    const originalTaskManager = taskManagerModule.TaskManager;

    taskManagerModule.TaskManager = class {
      async getTasksByNpc() {
        return [];
      }
    };

    try {
      const result = await hub.buildTaskDashboard("npc-1", "channel-1");
      assert.equal(result, "");
    } finally {
      taskManagerModule.TaskManager = originalTaskManager;
    }
  });

  test("returns formatted dashboard when tasks exist", async () => {
    const hub = new DmHub();
    const taskManagerModule = require("../task-manager.js") as { TaskManager: unknown };
    const originalTaskManager = taskManagerModule.TaskManager;

    taskManagerModule.TaskManager = class {
      async getTasksByNpc() {
        return [
          {
            npcTaskId: "T-1",
            title: "문서 정리",
            status: "in_progress",
            summary: "요구사항을 정리 중입니다.",
            updatedAt: "2026-04-09T00:00:00.000Z",
          },
          {
            npcTaskId: "T-2",
            title: "완료된 태스크",
            status: "complete",
            summary: "이미 끝났습니다.",
            updatedAt: "2026-04-09T00:00:00.000Z",
          },
          {
            npcTaskId: "T-3",
            title: "대기 중 태스크",
            status: "pending",
            summary: null,
            updatedAt: "2026-04-09T00:00:00.000Z",
          },
        ];
      }
    };

    try {
      const result = await hub.buildTaskDashboard("npc-1", "channel-1");
      assert.match(result, /\[ACTIVE TASKS DASHBOARD\]/);
      assert.match(result, /- \[in_progress\] #T-1 "문서 정리"/);
      assert.match(result, /요약: 요구사항을 정리 중입니다\./);
      assert.match(result, /- \[pending\] #T-3 "대기 중 태스크"/);
      assert.match(result, /요약: 없음/);
      assert.doesNotMatch(result, /완료된 태스크/);
    } finally {
      taskManagerModule.TaskManager = originalTaskManager;
    }
  });

  test("includes task status, title, summary in output", async () => {
    const hub = new DmHub();
    const taskManagerModule = require("../task-manager.js") as { TaskManager: unknown };
    const originalTaskManager = taskManagerModule.TaskManager;

    taskManagerModule.TaskManager = class {
      async getTasksByNpc() {
        return [
          {
            npcTaskId: "TASK-99",
            title: "허브 동기화",
            status: "blocked",
            summary: "외부 응답 대기",
            updatedAt: "2026-04-09T00:00:00.000Z",
          },
        ];
      }
    };

    try {
      const result = await hub.buildTaskDashboard("npc-1", "channel-1");
      assert.match(result, /\[blocked\]/);
      assert.match(result, /#TASK-99 "허브 동기화"/);
      assert.match(result, /요약: 외부 응답 대기/);
    } finally {
      taskManagerModule.TaskManager = originalTaskManager;
    }
  });
});
