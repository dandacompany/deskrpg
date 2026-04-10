// src/lib/scheduled-task-manager.ts
// CRUD for scheduled (recurring) tasks. Follows TaskManager pattern.

import { eq, and, lte, desc } from "drizzle-orm";
import { getNextCronRun } from "./cron-parser";

export interface ScheduledTaskInput {
  channelId: string;
  npcId: string;
  assignerId: string;
  title: string;
  summary?: string | null;
  cronExpr: string;
  timezone?: string;
  maxHistory?: number;
}

export interface ScheduledTask {
  id: string;
  channelId: string;
  npcId: string;
  assignerId: string;
  title: string;
  summary: string | null;
  cronExpr: string;
  timezone: string;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  maxHistory: number;
  createdAt: string | null;
  updatedAt: string | null;
}

function normalizeTimestamp(value: unknown): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function normalizeRow(row: Record<string, unknown>): ScheduledTask {
  return {
    id: row.id as string,
    channelId: row.channelId as string,
    npcId: row.npcId as string,
    assignerId: row.assignerId as string,
    title: row.title as string,
    summary: (row.summary as string) || null,
    cronExpr: row.cronExpr as string,
    timezone: (row.timezone as string) || "Asia/Seoul",
    enabled: Boolean(row.enabled),
    lastRunAt: normalizeTimestamp(row.lastRunAt),
    nextRunAt: normalizeTimestamp(row.nextRunAt),
    maxHistory: (row.maxHistory as number) ?? 30,
    createdAt: normalizeTimestamp(row.createdAt),
    updatedAt: normalizeTimestamp(row.updatedAt),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbInstance = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SchemaType = { scheduledTasks: any; tasks: any };

export class ScheduledTaskManager {
  private db: DbInstance;
  private schema: SchemaType;

  constructor(db: DbInstance, schema: SchemaType) {
    this.db = db;
    this.schema = schema;
  }

  async create(input: ScheduledTaskInput): Promise<ScheduledTask> {
    const now = new Date().toISOString();
    const nextRunAt = getNextCronRun(input.cronExpr, input.timezone || "Asia/Seoul").toISOString();

    const [row] = await this.db
      .insert(this.schema.scheduledTasks)
      .values({
        channelId: input.channelId,
        npcId: input.npcId,
        assignerId: input.assignerId,
        title: input.title,
        summary: input.summary || null,
        cronExpr: input.cronExpr,
        timezone: input.timezone || "Asia/Seoul",
        enabled: true,
        nextRunAt,
        maxHistory: input.maxHistory ?? 30,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return normalizeRow(row);
  }

  async update(id: string, channelId: string, patch: Partial<ScheduledTaskInput>): Promise<ScheduledTask | null> {
    const now = new Date().toISOString();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updates: Record<string, any> = { updatedAt: now };

    if (patch.title !== undefined) updates.title = patch.title;
    if (patch.summary !== undefined) updates.summary = patch.summary || null;
    if (patch.cronExpr !== undefined) updates.cronExpr = patch.cronExpr;
    if (patch.timezone !== undefined) updates.timezone = patch.timezone;
    if (patch.maxHistory !== undefined) updates.maxHistory = patch.maxHistory;

    // Recompute nextRunAt if cron or timezone changed
    if (patch.cronExpr || patch.timezone) {
      const current = await this.getById(id);
      const cronExpr = patch.cronExpr || current?.cronExpr || "0 * * * *";
      const timezone = patch.timezone || current?.timezone || "Asia/Seoul";
      updates.nextRunAt = getNextCronRun(cronExpr, timezone).toISOString();
    }

    const [row] = await this.db
      .update(this.schema.scheduledTasks)
      .set(updates)
      .where(and(eq(this.schema.scheduledTasks.id, id), eq(this.schema.scheduledTasks.channelId, channelId)))
      .returning();

    return row ? normalizeRow(row) : null;
  }

  async delete(id: string, channelId: string): Promise<boolean> {
    const rows = await this.db
      .delete(this.schema.scheduledTasks)
      .where(and(eq(this.schema.scheduledTasks.id, id), eq(this.schema.scheduledTasks.channelId, channelId)))
      .returning();
    return rows.length > 0;
  }

  async getByChannel(channelId: string): Promise<ScheduledTask[]> {
    const rows = await this.db
      .select()
      .from(this.schema.scheduledTasks)
      .where(eq(this.schema.scheduledTasks.channelId, channelId))
      .orderBy(desc(this.schema.scheduledTasks.createdAt));
    return rows.map(normalizeRow);
  }

  async getById(id: string): Promise<ScheduledTask | null> {
    const rows = await this.db
      .select()
      .from(this.schema.scheduledTasks)
      .where(eq(this.schema.scheduledTasks.id, id))
      .limit(1);
    return rows[0] ? normalizeRow(rows[0]) : null;
  }

  async setEnabled(id: string, channelId: string, enabled: boolean): Promise<ScheduledTask | null> {
    const now = new Date().toISOString();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updates: Record<string, any> = { enabled, updatedAt: now };

    // Recompute nextRunAt when re-enabling
    if (enabled) {
      const current = await this.getById(id);
      if (current) {
        updates.nextRunAt = getNextCronRun(current.cronExpr, current.timezone).toISOString();
      }
    }

    const [row] = await this.db
      .update(this.schema.scheduledTasks)
      .set(updates)
      .where(and(eq(this.schema.scheduledTasks.id, id), eq(this.schema.scheduledTasks.channelId, channelId)))
      .returning();
    return row ? normalizeRow(row) : null;
  }

  async getDueSchedules(now: Date): Promise<ScheduledTask[]> {
    const nowIso = now.toISOString();
    const rows = await this.db
      .select()
      .from(this.schema.scheduledTasks)
      .where(and(
        eq(this.schema.scheduledTasks.enabled, true),
        lte(this.schema.scheduledTasks.nextRunAt, nowIso),
      ));
    return rows.map(normalizeRow);
  }

  async markExecuted(id: string, now: Date, nextRunAt: Date): Promise<void> {
    await this.db
      .update(this.schema.scheduledTasks)
      .set({
        lastRunAt: now.toISOString(),
        nextRunAt: nextRunAt.toISOString(),
        updatedAt: now.toISOString(),
      })
      .where(eq(this.schema.scheduledTasks.id, id));
  }

  async getExecutionHistory(scheduledTaskId: string, limit = 20): Promise<unknown[]> {
    const rows = await this.db
      .select()
      .from(this.schema.tasks)
      .where(eq(this.schema.tasks.scheduledTaskId, scheduledTaskId))
      .orderBy(desc(this.schema.tasks.createdAt))
      .limit(limit);
    return rows;
  }

  async cleanupOldHistory(scheduledTaskId: string, maxHistory: number): Promise<void> {
    const allRows = await this.db
      .select({ id: this.schema.tasks.id, status: this.schema.tasks.status })
      .from(this.schema.tasks)
      .where(eq(this.schema.tasks.scheduledTaskId, scheduledTaskId))
      .orderBy(desc(this.schema.tasks.createdAt));

    // Keep maxHistory most recent, delete only completed/cancelled beyond that
    const toDelete = allRows
      .slice(maxHistory)
      .filter((r: { status: string }) => r.status === "complete" || r.status === "cancelled");

    for (const row of toDelete) {
      await this.db
        .delete(this.schema.tasks)
        .where(eq(this.schema.tasks.id, (row as { id: string }).id));
    }
  }
}
