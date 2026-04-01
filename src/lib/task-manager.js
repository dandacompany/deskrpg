// src/lib/task-manager.js
// 태스크 DB CRUD. server.js에서 공유 db + schema를 받아 사용.
/* eslint-disable @typescript-eslint/no-require-imports */

"use strict";

const { eq, and, or, desc, sql, getTableColumns, isNull, isNotNull, lte } = require("drizzle-orm");

function nowIso() {
  return new Date().toISOString();
}

function normalizeTimestamp(value) {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

/** Drizzle camelCase 행을 정규화 (JOIN 결과의 npcName 포함 처리) */
function normalizeTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    channelId: row.channelId,
    npcId: row.npcId,
    assignerId: row.assignerId,
    npcTaskId: row.npcTaskId,
    title: row.title,
    summary: row.summary,
    status: row.status,
    autoNudgeCount: row.autoNudgeCount ?? 0,
    autoNudgeMax: row.autoNudgeMax ?? 5,
    lastNudgedAt: normalizeTimestamp(row.lastNudgedAt),
    lastReportedAt: normalizeTimestamp(row.lastReportedAt),
    stalledAt: normalizeTimestamp(row.stalledAt),
    stalledReason: row.stalledReason ?? null,
    npcName: row.npcName || undefined,
    createdAt: normalizeTimestamp(row.createdAt),
    updatedAt: normalizeTimestamp(row.updatedAt),
    completedAt: normalizeTimestamp(row.completedAt),
  };
}

class TaskManager {
  /**
   * @param {import('drizzle-orm').LibSQLDatabase | import('drizzle-orm/node-postgres').NodePgDatabase} db
   * @param {{ tasks: any, npcs: any }} schema
   */
  constructor(db, schema) {
    this.db = db;
    this.schema = schema;
  }

  /**
   * 태스크 액션 처리 (create/update/complete/cancel)
   * 멱등성: create 중복 시 upsert, update/complete 대상 없으면 auto-create.
   */
  async handleTaskAction(taskAction, channelId, npcId, assignerId, options = {}) {
    const { action, id: npcTaskId, title, summary, status } = taskAction;
    const autoNudgeMax = options.autoNudgeMax ?? 5;

    switch (action) {
      case "create":
        return this._upsertTask(channelId, npcId, assignerId, npcTaskId, title, summary, status || "in_progress", {
          autoNudgeMax,
          markReported: true,
        });
      case "update":
        return this._updateOrCreate(channelId, npcId, assignerId, npcTaskId, title, summary, status || "in_progress", {
          autoNudgeMax,
          markReported: true,
        });
      case "complete":
        return this._updateOrCreate(channelId, npcId, assignerId, npcTaskId, title, summary, "complete", {
          autoNudgeMax,
          markReported: true,
        });
      case "cancel":
        return this._updateOrCreate(channelId, npcId, assignerId, npcTaskId, title, summary, "cancelled", {
          autoNudgeMax,
          markReported: true,
        });
      default:
        console.warn(`[TaskManager] Unknown action: ${action}`);
        return null;
    }
  }

  async _upsertTask(channelId, npcId, assignerId, npcTaskId, title, summary, status, options = {}) {
    const { db, schema } = this;
    const autoNudgeMax = options.autoNudgeMax ?? 5;
    const completedAt = (status === "complete" || status === "cancelled") ? nowIso() : null;
    const updatedAt = nowIso();
    const lastReportedAt = options.markReported ? updatedAt : null;

    const [row] = await db
      .insert(schema.tasks)
      .values({
        channelId,
        npcId,
        assignerId,
        npcTaskId,
        title,
        summary,
        status,
        autoNudgeCount: 0,
        autoNudgeMax,
        lastNudgedAt: null,
        lastReportedAt,
        stalledAt: null,
        stalledReason: null,
        completedAt,
      })
      .onConflictDoUpdate({
        target: [schema.tasks.npcId, schema.tasks.npcTaskId],
        set: {
          title: sql`COALESCE(excluded.title, ${schema.tasks.title})`,
          summary: sql`COALESCE(excluded.summary, ${schema.tasks.summary})`,
          status: sql`excluded.status`,
          updatedAt,
          lastReportedAt: sql`COALESCE(excluded.last_reported_at, ${schema.tasks.lastReportedAt})`,
          completedAt: sql`excluded.completed_at`,
        },
      })
      .returning();

    return normalizeTask(row);
  }

  async _updateOrCreate(channelId, npcId, assignerId, npcTaskId, title, summary, status, options = {}) {
    const { db, schema } = this;
    const autoNudgeMax = options.autoNudgeMax ?? 5;
    const completedAt = (status === "complete" || status === "cancelled") ? nowIso() : null;
    const updatedAt = nowIso();
    const lastReportedAt = options.markReported ? updatedAt : null;

    const rows = await db
      .update(schema.tasks)
      .set({
        title: title != null ? title : sql`${schema.tasks.title}`,
        summary: summary != null ? summary : sql`${schema.tasks.summary}`,
        status,
        updatedAt,
        lastReportedAt: lastReportedAt ?? sql`${schema.tasks.lastReportedAt}`,
        completedAt,
      })
      .where(
        and(
          eq(schema.tasks.npcId, npcId),
          eq(schema.tasks.npcTaskId, npcTaskId)
        )
      )
      .returning();

    if (rows.length > 0) return normalizeTask(rows[0]);
    return this._upsertTask(channelId, npcId, assignerId, npcTaskId, title, summary, status, {
      autoNudgeMax,
      markReported: options.markReported,
    });
  }

  async getTasksByChannel(channelId) {
    const { db, schema } = this;

    const rows = await db
      .select({
        ...getTableColumns(schema.tasks),
        npcName: schema.npcs.name,
      })
      .from(schema.tasks)
      .leftJoin(schema.npcs, eq(schema.tasks.npcId, schema.npcs.id))
      .where(eq(schema.tasks.channelId, channelId))
      .orderBy(desc(schema.tasks.createdAt));

    return rows.map(normalizeTask);
  }

  async deleteTask(taskId, channelId) {
    const { db, schema } = this;

    const [row] = await db
      .delete(schema.tasks)
      .where(
        and(
          eq(schema.tasks.id, taskId),
          eq(schema.tasks.channelId, channelId)
        )
      )
      .returning();

    return normalizeTask(row);
  }

  async getTaskById(taskId, channelId) {
    const { db, schema } = this;

    const rows = await db
      .select()
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.id, taskId),
          eq(schema.tasks.channelId, channelId),
        ),
      )
      .limit(1);

    return normalizeTask(rows[0]);
  }

  async getTasksByNpc(npcId) {
    const { db, schema } = this;

    const rows = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.npcId, npcId))
      .orderBy(desc(schema.tasks.createdAt));

    return rows.map(normalizeTask);
  }

  async getStaleInProgressTasks(channelId, olderThanIso) {
    const { db, schema } = this;

    const rows = await db
      .select()
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.channelId, channelId),
          eq(schema.tasks.status, "in_progress"),
          or(
            and(
              isNotNull(schema.tasks.lastReportedAt),
              lte(schema.tasks.lastReportedAt, olderThanIso),
            ),
            and(
              isNull(schema.tasks.lastReportedAt),
              lte(schema.tasks.updatedAt, olderThanIso),
            ),
          ),
        )
      )
      .orderBy(desc(schema.tasks.updatedAt));

    return rows.map(normalizeTask);
  }

  async markTaskNudged(taskId, channelId) {
    const { db, schema } = this;
    const current = await this.getTaskById(taskId, channelId);
    if (!current) return null;

    const [row] = await db
      .update(schema.tasks)
      .set({
        autoNudgeCount: (current.autoNudgeCount ?? 0) + 1,
        lastNudgedAt: nowIso(),
        updatedAt: nowIso(),
      })
      .where(
        and(
          eq(schema.tasks.id, taskId),
          eq(schema.tasks.channelId, channelId),
        ),
      )
      .returning();

    return normalizeTask(row);
  }

  async markTaskStalled(taskId, channelId, reason = "max_nudges_reached") {
    const { db, schema } = this;
    const [row] = await db
      .update(schema.tasks)
      .set({
        status: "stalled",
        stalledAt: nowIso(),
        stalledReason: reason,
        updatedAt: nowIso(),
      })
      .where(
        and(
          eq(schema.tasks.id, taskId),
          eq(schema.tasks.channelId, channelId),
        ),
      )
      .returning();

    return normalizeTask(row);
  }

  async resumeTask(taskId, channelId) {
    const { db, schema } = this;
    const [row] = await db
      .update(schema.tasks)
      .set({
        status: "in_progress",
        autoNudgeCount: 0,
        lastNudgedAt: null,
        stalledAt: null,
        stalledReason: null,
        updatedAt: nowIso(),
      })
      .where(
        and(
          eq(schema.tasks.id, taskId),
          eq(schema.tasks.channelId, channelId),
        ),
      )
      .returning();

    return normalizeTask(row);
  }

  async completeTask(taskId, channelId) {
    const { db, schema } = this;
    const completedAt = nowIso();
    const [row] = await db
      .update(schema.tasks)
      .set({
        status: "complete",
        completedAt,
        lastReportedAt: completedAt,
        updatedAt: completedAt,
      })
      .where(
        and(
          eq(schema.tasks.id, taskId),
          eq(schema.tasks.channelId, channelId),
        ),
      )
      .returning();

    return normalizeTask(row);
  }
}

module.exports = { TaskManager };
