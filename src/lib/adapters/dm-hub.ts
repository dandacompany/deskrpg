import { and, eq } from "drizzle-orm";

import { db, isPostgres, npcSessions } from "@/db";

function nowForDb() {
  return (isPostgres ? new Date() : new Date().toISOString()) as unknown as Date;
}

function parseSessionType(contextKey: string) {
  if (contextKey.startsWith("task-")) return "task";
  if (contextKey.startsWith("meeting-")) return "meeting";
  if (contextKey.startsWith("dm-")) return "dm";
  return "context";
}

export class DmHub {
  private readonly fallbackSummaries = new Map<string, string>();

  async buildTaskDashboard(npcId: string, channelId: string): Promise<string> {
    void channelId;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { TaskManager } = require("../task-manager.js") as typeof import("../task-manager.js");
    const { tasks, npcs } = await import("@/db");
    const taskManager = new TaskManager(db, { tasks, npcs });

    const activeTasks = (await taskManager.getTasksByNpc(npcId)) as Array<{
      npcTaskId: string;
      title: string;
      status: string;
      summary: string | null;
      updatedAt: string;
    }>;

    if (!activeTasks || activeTasks.length === 0) return "";

    const taskLines = activeTasks
      .filter((task) => task.status !== "complete" && task.status !== "cancelled")
      .map((task) => {
        const summary = task.summary || "없음";
        return `- [${task.status}] #${task.npcTaskId} "${task.title}"\n   요약: ${summary}`;
      });

    if (taskLines.length === 0) return "";

    return (
      "[ACTIVE TASKS DASHBOARD]\n" +
      `${taskLines.join("\n")}\n\n` +
      "위 태스크들의 진행 상황을 파악하고 있습니다.\n" +
      "사용자가 태스크에 대해 질문하면 요약 기반으로 답변하세요.\n" +
      "상세 내용이 필요하면 응답에 [NEED_TASK_DETAIL:taskId] 마커를 포함하세요.\n" +
      "기존 태스크의 연속 작업이라면 [CONTINUE_TASK:taskId] 마커를 사용하세요."
    );
  }

  async updateSessionSummary(
    npcId: string,
    userId: string,
    contextKey: string,
    summary: string,
  ): Promise<void> {
    const sessionType = parseSessionType(contextKey);
    const sessionRef = contextKey;
    const fallbackKey = `${npcId}:${userId}:${contextKey}`;

    try {
      const existing = await db
        .select()
        .from(npcSessions)
        .where(
          and(
            eq(npcSessions.npcId, npcId),
            eq(npcSessions.userId, userId),
            eq(npcSessions.contextKey, contextKey),
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        await db
          .update(npcSessions)
          .set({
            lastSummary: summary,
            updatedAt: nowForDb(),
          })
          .where(eq(npcSessions.id, existing[0].id));
        return;
      }

      await db.insert(npcSessions).values({
        npcId,
        userId,
        adapterType: "hub",
        sessionType,
        sessionRef,
        contextKey,
        lastSummary: summary,
        createdAt: nowForDb(),
        updatedAt: nowForDb(),
      });
    } catch {
      this.fallbackSummaries.set(fallbackKey, summary);
    }
  }

  processResponseMarkers(response: string): {
    finalResponse: string;
    markers: Array<{ type: "need_detail" | "continue_task"; taskId: string }>;
  } {
    const markers: Array<{ type: "need_detail" | "continue_task"; taskId: string }> = [];

    const markerMatches = response.matchAll(/\[(NEED_TASK_DETAIL|CONTINUE_TASK):([^\]]+)\]/g);
    for (const match of markerMatches) {
      markers.push({
        type: match[1] === "NEED_TASK_DETAIL" ? "need_detail" : "continue_task",
        taskId: match[2],
      });
    }

    const finalResponse = response
      .replace(/\[NEED_TASK_DETAIL:[^\]]+\]/g, "")
      .replace(/\[CONTINUE_TASK:[^\]]+\]/g, "")
      .trim();

    return { finalResponse, markers };
  }
}

export const dmHub = new DmHub();
