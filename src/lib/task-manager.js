// src/lib/task-manager.js
// 태스크 DB CRUD. server.js에서 공유 db + schema를 받아 사용.
/* eslint-disable @typescript-eslint/no-require-imports */

"use strict";

const { eq, and, or, desc, sql, getTableColumns, isNull, isNotNull, lte } = require("drizzle-orm");

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
   * @param {{ isPostgres?: boolean }} [options]
   */
  constructor(db, schema, options = {}) {
    this.db = db;
    this.schema = schema;
    // PostgreSQL timestamp columns (drizzle pg-core 'date' mode) require a Date object;
    // SQLite text columns require an ISO string. Mirror the gateway-resources nowForDb pattern.
    this.isPostgres = options.isPostgres ?? false;
  }

  _nowForDb() {
    return this.isPostgres ? new Date() : new Date().toISOString();
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
        return this._upsertTask(
          channelId,
          npcId,
          assignerId,
          npcTaskId,
          title,
          summary,
          status || "in_progress",
          {
            autoNudgeMax,
            markReported: true,
          },
        );
      case "update":
        return this._updateOrCreate(
          channelId,
          npcId,
          assignerId,
          npcTaskId,
          title,
          summary,
          status || "in_progress",
          {
            autoNudgeMax,
            markReported: true,
          },
        );
      case "complete":
        return this._updateOrCreate(
          channelId,
          npcId,
          assignerId,
          npcTaskId,
          title,
          summary,
          "complete",
          {
            autoNudgeMax,
            markReported: true,
          },
        );
      case "cancel":
        return this._updateOrCreate(
          channelId,
          npcId,
          assignerId,
          npcTaskId,
          title,
          summary,
          "cancelled",
          {
            autoNudgeMax,
            markReported: true,
          },
        );
      default:
        console.warn(`[TaskManager] Unknown action: ${action}`);
        return null;
    }
  }

  async _upsertTask(channelId, npcId, assignerId, npcTaskId, title, summary, status, options = {}) {
    const { db, schema } = this;
    const autoNudgeMax = options.autoNudgeMax ?? 5;
    const completedAt = status === "complete" || status === "cancelled" ? this._nowForDb() : null;
    const updatedAt = this._nowForDb();
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

  async _updateOrCreate(
    channelId,
    npcId,
    assignerId,
    npcTaskId,
    title,
    summary,
    status,
    options = {},
  ) {
    const { db, schema } = this;
    const autoNudgeMax = options.autoNudgeMax ?? 5;
    const completedAt = status === "complete" || status === "cancelled" ? this._nowForDb() : null;
    const updatedAt = this._nowForDb();
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
      .where(and(eq(schema.tasks.npcId, npcId), eq(schema.tasks.npcTaskId, npcTaskId)))
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
      .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.channelId, channelId)))
      .returning();

    return normalizeTask(row);
  }

  async getTaskById(taskId, channelId) {
    const { db, schema } = this;

    const rows = await db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.channelId, channelId)))
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
    // PG date-mode timestamp columns require a Date for comparison; SQLite text columns take the ISO string.
    const cutoff = this.isPostgres ? new Date(olderThanIso) : olderThanIso;

    const rows = await db
      .select()
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.channelId, channelId),
          eq(schema.tasks.status, "in_progress"),
          or(
            and(isNotNull(schema.tasks.lastReportedAt), lte(schema.tasks.lastReportedAt, cutoff)),
            and(isNull(schema.tasks.lastReportedAt), lte(schema.tasks.updatedAt, cutoff)),
          ),
        ),
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
        lastNudgedAt: this._nowForDb(),
        updatedAt: this._nowForDb(),
      })
      .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.channelId, channelId)))
      .returning();

    return normalizeTask(row);
  }

  async markTaskStalled(taskId, channelId, reason = "max_nudges_reached") {
    const { db, schema } = this;
    const [row] = await db
      .update(schema.tasks)
      .set({
        status: "stalled",
        stalledAt: this._nowForDb(),
        stalledReason: reason,
        updatedAt: this._nowForDb(),
      })
      .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.channelId, channelId)))
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
        updatedAt: this._nowForDb(),
      })
      .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.channelId, channelId)))
      .returning();

    return normalizeTask(row);
  }

  /**
   * Move a task to a new status. Handles npcId assignment/clearing.
   * Returns task object with _fromStatus for the caller to trigger actions.
   * @throws {Error} if npcId is required but not provided
   */
  async moveTask(taskId, channelId, toStatus, npcId, { expectedFromStatus } = {}) {
    const { db, schema } = this;

    const current = await this.getTaskById(taskId, channelId);
    if (!current) return null;

    const fromStatus = current.status;

    // Guard: if caller expects a specific source status, reject if it changed (race protection)
    if (expectedFromStatus && current.status !== expectedFromStatus) return null;

    let finalNpcId;
    if (toStatus === "backlog") {
      finalNpcId = null;
    } else if (toStatus === "cancelled") {
      finalNpcId = npcId || current.npcId || null;
    } else if (npcId) {
      finalNpcId = npcId;
    } else if (current.npcId) {
      finalNpcId = current.npcId;
    } else {
      throw new Error("npcId required for status: " + toStatus);
    }

    const now = this._nowForDb();
    const completedAt = toStatus === "complete" || toStatus === "cancelled" ? now : null;

    const updates = {
      status: toStatus,
      npcId: finalNpcId,
      updatedAt: now,
      completedAt,
    };

    if (toStatus === "in_progress" || toStatus === "backlog") {
      updates.autoNudgeCount = 0;
      updates.lastNudgedAt = null;
      updates.stalledAt = null;
      updates.stalledReason = null;
    }

    // Atomic update: include current status in WHERE to prevent race conditions
    const rows = await db
      .update(schema.tasks)
      .set(updates)
      .where(
        and(
          eq(schema.tasks.id, taskId),
          eq(schema.tasks.channelId, channelId),
          eq(schema.tasks.status, fromStatus),
        ),
      )
      .returning();

    if (!rows.length) return null; // Another concurrent move already changed the status

    const task = normalizeTask(rows[0]);
    return { ...task, _fromStatus: fromStatus };
  }

  /**
   * Check if the NPC currently has any in_progress task in the given channel.
   */
  async hasInProgressTask(npcId, channelId) {
    const { db, schema } = this;
    const rows = await db
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.npcId, npcId),
          eq(schema.tasks.channelId, channelId),
          eq(schema.tasks.status, "in_progress"),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /**
   * Get the oldest pending task for the given NPC in the channel (FIFO).
   */
  async getNextPendingTask(npcId, channelId) {
    const { db, schema } = this;
    const rows = await db
      .select()
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.npcId, npcId),
          eq(schema.tasks.channelId, channelId),
          eq(schema.tasks.status, "pending"),
        ),
      )
      .orderBy(schema.tasks.createdAt)
      .limit(1);
    return rows[0] ? normalizeTask(rows[0]) : null;
  }

  async getTaskByNpcTaskId(npcId, npcTaskId) {
    const { db, schema } = this;

    const rows = await db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.npcId, npcId), eq(schema.tasks.npcTaskId, npcTaskId)))
      .limit(1);

    return rows[0] ? normalizeTask(rows[0]) : null;
  }

  async completeTask(taskId, channelId) {
    const { db, schema } = this;
    const completedAt = this._nowForDb();
    const [row] = await db
      .update(schema.tasks)
      .set({
        status: "complete",
        completedAt,
        lastReportedAt: completedAt,
        updatedAt: completedAt,
      })
      .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.channelId, channelId)))
      .returning();

    return normalizeTask(row);
  }

  async createBacklogTask(channelId, assignerId, title, summary) {
    const { db, schema } = this;
    const npcTaskId = `backlog-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    const [row] = await db
      .insert(schema.tasks)
      .values({
        channelId,
        npcId: null,
        assignerId,
        npcTaskId,
        title,
        summary: summary || null,
        status: "backlog",
        autoNudgeCount: 0,
        autoNudgeMax: 5,
        lastNudgedAt: null,
        lastReportedAt: null,
        stalledAt: null,
        stalledReason: null,
        completedAt: null,
      })
      .returning();

    return normalizeTask(row);
  }
}

module.exports = { TaskManager };
