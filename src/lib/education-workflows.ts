import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { db, educationWorkflowEvents, educationWorkflows, isPostgres, nowForDb } from "@/db";

export const EDUCATION_STAGES = [
  "topic_recommendation", "topic_selected", "brief_confirmed", "team_selected", "researching",
  "evidence_review", "outline_review", "cards_and_diagrams", "document_draft", "final_review",
] as const;
export type EducationStage = (typeof EDUCATION_STAGES)[number];
export type EducationWorkflowSource = "deskrpg" | "slack";

export class EducationWorkflowError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly current?: unknown,
  ) {
    super(code);
  }
}

type JsonObject = Record<string, unknown>;
type WorkflowRow = typeof educationWorkflows.$inferSelect;
type SqliteSchema = typeof import("@/db/schema-sqlite");
const MAX_JSON_CHARS = 40_000;
const TEAM = new Set(["atlas", "forge", "vector", "nova", "metric", "guard", "scout", "market", "slides"]);

function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(value: unknown): JsonObject {
  if (object(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return object(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function serializeRow(row: WorkflowRow) {
  return { ...row, state: readJson(row.stateJson), stateJson: undefined };
}

function normalizedText(value: unknown, max: number, field: string, required = true): string | null {
  if (value === null || value === undefined || value === "") {
    if (!required) return null;
    throw new EducationWorkflowError(400, `${field}_required`);
  }
  if (typeof value !== "string" || value.trim().length > max) {
    throw new EducationWorkflowError(400, `invalid_${field}`);
  }
  const result = value.trim();
  if (required && !result) throw new EducationWorkflowError(400, `${field}_required`);
  return result || null;
}

function validateAction(stage: string, status: string, action: string, payload: JsonObject, state: JsonObject) {
  if (status === "approved" || status === "failed") throw new EducationWorkflowError(409, "workflow_closed");
  if (action === "pause") return { stage, status: "paused", state };
  if (action === "resume") {
    if (status !== "paused") throw new EducationWorkflowError(409, "workflow_not_paused");
    return { stage, status: "active", state };
  }
  if (action === "request_revision") {
    const note = normalizedText(payload.note, 1000, "note");
    return { stage, status: "needs_revision", state: { ...state, revisionNote: note } };
  }
  if (status === "paused") throw new EducationWorkflowError(409, "workflow_paused");

  const sameStage = () => ({ stage, status: "active", state });
  const move = (expected: EducationStage, next: EducationStage, nextState = state) => {
    if (stage !== expected) throw new EducationWorkflowError(409, "invalid_stage_transition");
    return { stage: next, status: "active", state: nextState };
  };
  const arr = (key: string, max: number, itemMax: number) => {
    const value = payload[key];
    if (!Array.isArray(value) || value.length > max || value.some((v) => typeof v !== "string" || v.trim().length > itemMax)) {
      throw new EducationWorkflowError(400, `invalid_${key}`);
    }
    return value.map((v) => (v as string).trim()).filter(Boolean);
  };

  switch (action) {
    case "save_candidates": {
      if (stage !== "topic_recommendation") throw new EducationWorkflowError(409, "invalid_stage_transition");
      const candidates = payload.candidates;
      if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > 4) {
        throw new EducationWorkflowError(400, "invalid_candidates");
      }
      const clean = candidates.map((candidate) => {
        if (!object(candidate)) throw new EducationWorkflowError(400, "invalid_candidate");
        return {
          id: normalizedText(candidate.id, 40, "candidate_id")!,
          title: normalizedText(candidate.title, 200, "candidate_title")!,
          rationale: normalizedText(candidate.rationale, 500, "candidate_rationale")!,
          audience: normalizedText(candidate.audience, 160, "candidate_audience", false),
          deliverable: normalizedText(candidate.deliverable, 160, "candidate_deliverable", false),
        };
      });
      return { ...sameStage(), state: { ...state, candidates: clean } };
    }
    case "choose_topic": {
      if (stage !== "topic_recommendation") throw new EducationWorkflowError(409, "invalid_stage_transition");
      const id = normalizedText(payload.candidateId, 40, "candidate_id")!;
      const candidates = Array.isArray(state.candidates) ? state.candidates : [];
      const candidate = candidates.find((row) => object(row) && row.id === id);
      if (!object(candidate)) throw new EducationWorkflowError(409, "candidate_not_found");
      return move("topic_recommendation", "topic_selected", { ...state, selectedTopic: candidate });
    }
    case "save_brief": {
      const audience = normalizedText(payload.audience, 300, "audience")!;
      const objective = normalizedText(payload.objective, 1000, "objective")!;
      const durationMinutes = payload.durationMinutes;
      if (!Number.isInteger(durationMinutes) || (durationMinutes as number) < 5 || (durationMinutes as number) > 480) {
        throw new EducationWorkflowError(400, "invalid_duration_minutes");
      }
      const deliverable = normalizedText(payload.deliverable, 300, "deliverable")!;
      return move("topic_selected", "brief_confirmed", { ...state, brief: { audience, objective, durationMinutes, deliverable } });
    }
    case "select_team": {
      const team = arr("team", 9, 32);
      if (!team.length || team.some((name) => !TEAM.has(name))) throw new EducationWorkflowError(400, "invalid_team");
      return move("brief_confirmed", "team_selected", { ...state, team: [...new Set(team)] });
    }
    case "start_research":
      return move("team_selected", "researching");
    case "save_research": {
      if (stage !== "researching") throw new EducationWorkflowError(409, "invalid_stage_transition");
      const summary = normalizedText(payload.summary, 8000, "summary")!;
      const sources = payload.sources;
      if (!Array.isArray(sources) || sources.length > 40 || sources.some((v) => !object(v))) {
        throw new EducationWorkflowError(400, "invalid_sources");
      }
      const cleanSources = sources.map((source) => {
        const url = normalizedText(source.url, 2000, "source_url")!;
        try { if (!["https:", "http:"].includes(new URL(url).protocol)) throw new Error(); }
        catch { throw new EducationWorkflowError(400, "invalid_source_url"); }
        return {
          title: normalizedText(source.title, 300, "source_title")!, url,
          publishedAt: normalizedText(source.publishedAt, 80, "source_date", false),
          checkedAt: normalizedText(source.checkedAt, 80, "source_checked_at", false),
          note: normalizedText(source.note, 1000, "source_note", false),
          limitation: normalizedText(source.limitation, 1000, "source_limitation", false),
        };
      });
      return move("researching", "evidence_review", { ...state, research: { summary, sources: cleanSources } });
    }
    case "approve_research":
      return move("evidence_review", "outline_review");
    case "save_outline": {
      if (stage !== "outline_review") throw new EducationWorkflowError(409, "invalid_stage_transition");
      const outline = arr("outline", 40, 500);
      if (!outline.length) throw new EducationWorkflowError(400, "outline_required");
      return { ...sameStage(), state: { ...state, outline } };
    }
    case "approve_outline":
      return move("outline_review", "cards_and_diagrams");
    case "save_cards": {
      const cards = arr("cards", 40, 1200);
      if (!cards.length) throw new EducationWorkflowError(400, "cards_required");
      return move("cards_and_diagrams", "document_draft", { ...state, cards });
    }
    case "save_document": {
      const documentDraft = normalizedText(payload.documentDraft, 30_000, "document_draft")!;
      return move("document_draft", "final_review", { ...state, documentDraft });
    }
    case "approve_final":
      return { ...move("final_review", "final_review"), status: "approved" };
    default:
      throw new EducationWorkflowError(400, "unknown_action");
  }
}

export async function createEducationWorkflow(input: {
  title: unknown;
  requestText: unknown;
  source: EducationWorkflowSource;
  externalSessionId?: string | null;
  idempotencyKey: string;
  createdByUserId?: string | null;
  actor: string;
}) {
  const title = normalizedText(input.title, 200, "title")!;
  const requestText = normalizedText(input.requestText, 8000, "request_text")!;
  const idempotencyKey = normalizedText(input.idempotencyKey, 128, "idempotency_key")!;
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) throw new EducationWorkflowError(400, "invalid_idempotency_key");
  const id = randomUUID();
  const now = nowForDb();
  const values = {
      id, title, requestText, stage: "topic_recommendation", status: "active", version: 0,
      stateJson: "{}", source: input.source, externalSessionId: input.externalSessionId?.slice(0, 255) ?? null,
      idempotencyKey, createdByUserId: input.createdByUserId ?? null, createdAt: now, updatedAt: now,
  };
  const firstEvent = {
      id: randomUUID(), workflowId: id, version: 0, action: "created", actor: input.actor.slice(0, 120),
      source: input.source, payloadJson: JSON.stringify({ title, requestText }), createdAt: now,
  };
  const duplicateOrConflict = (row: WorkflowRow) => {
    if (row.title !== title || row.requestText !== requestText) throw new EducationWorkflowError(409, "idempotency_key_reused");
    return { row, duplicate: true };
  };
  let txResult: { row: WorkflowRow; duplicate: boolean };
  if (isPostgres) {
    txResult = await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(educationWorkflows).where(eq(educationWorkflows.idempotencyKey, idempotencyKey)).limit(1);
      if (existing) return duplicateOrConflict(existing);
      const [row] = await tx.insert(educationWorkflows).values(values).onConflictDoNothing().returning();
      if (!row) {
        const [raced] = await tx.select().from(educationWorkflows).where(eq(educationWorkflows.idempotencyKey, idempotencyKey)).limit(1);
        if (!raced) throw new EducationWorkflowError(409, "idempotency_conflict");
        return duplicateOrConflict(raced);
      }
      await tx.insert(educationWorkflowEvents).values(firstEvent);
      return { row, duplicate: false };
    });
  } else {
    const sqliteDb = db as unknown as BetterSQLite3Database<SqliteSchema>;
    txResult = sqliteDb.transaction((tx) => {
      const existing = tx.select().from(educationWorkflows).where(eq(educationWorkflows.idempotencyKey, idempotencyKey)).limit(1).get();
      if (existing) return duplicateOrConflict(existing as WorkflowRow);
      const row = tx.insert(educationWorkflows).values(values).onConflictDoNothing().returning().get();
      if (!row) {
        const raced = tx.select().from(educationWorkflows).where(eq(educationWorkflows.idempotencyKey, idempotencyKey)).limit(1).get();
        if (!raced) throw new EducationWorkflowError(409, "idempotency_conflict");
        return duplicateOrConflict(raced as WorkflowRow);
      }
      tx.insert(educationWorkflowEvents).values(firstEvent).run();
      return { row: row as WorkflowRow, duplicate: false };
    });
  }
  return { workflow: serializeRow(txResult.row), duplicate: txResult.duplicate };
}

export async function listEducationWorkflows(limit = 50) {
  const rows = await db.select({
    id: educationWorkflows.id, title: educationWorkflows.title, stage: educationWorkflows.stage,
    status: educationWorkflows.status, version: educationWorkflows.version, source: educationWorkflows.source,
    createdAt: educationWorkflows.createdAt, updatedAt: educationWorkflows.updatedAt,
  }).from(educationWorkflows).orderBy(desc(educationWorkflows.updatedAt)).limit(Math.max(1, Math.min(100, limit)));
  return rows;
}

export async function getEducationWorkflow(id: string) {
  const [row] = await db.select().from(educationWorkflows).where(eq(educationWorkflows.id, id)).limit(1);
  if (!row) return null;
  const events = await db.select().from(educationWorkflowEvents)
    .where(eq(educationWorkflowEvents.workflowId, id)).orderBy(educationWorkflowEvents.version);
  return {
    ...serializeRow(row),
    events: events.map((event) => ({ ...event, payload: readJson(event.payloadJson), payloadJson: undefined })),
  };
}

export async function updateEducationWorkflow(input: {
  id: string;
  expectedVersion: unknown;
  eventId: unknown;
  action: unknown;
  payload: unknown;
  source: EducationWorkflowSource;
  actor: string;
}) {
  if (!Number.isInteger(input.expectedVersion) || (input.expectedVersion as number) < 0) {
    throw new EducationWorkflowError(400, "invalid_expected_version");
  }
  const eventId = normalizedText(input.eventId, 64, "event_id")!;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(eventId)) throw new EducationWorkflowError(400, "invalid_event_id");
  const action = normalizedText(input.action, 40, "action")!;
  const payload = object(input.payload) ? input.payload : {};
  if (JSON.stringify(payload).length > MAX_JSON_CHARS) throw new EducationWorkflowError(413, "payload_too_large");
  const prepare = (current: WorkflowRow) => {
    if (current.version !== input.expectedVersion) throw new EducationWorkflowError(409, "stale_version", serializeRow(current));
    const next = validateAction(current.stage, current.status, action, payload, readJson(current.stateJson));
    return { next, nextVersion: current.version + 1, now: nowForDb() };
  };
  const event = {
    id: eventId, workflowId: input.id, action, actor: input.actor.slice(0, 120), source: input.source,
    payloadJson: JSON.stringify(payload),
  };
  let txResult: { row: WorkflowRow; duplicate: boolean };
  if (isPostgres) {
    txResult = await db.transaction(async (tx) => {
      const [seen] = await tx.select().from(educationWorkflowEvents).where(eq(educationWorkflowEvents.id, eventId)).limit(1);
      if (seen) {
        if (seen.workflowId !== input.id || seen.action !== action || seen.payloadJson !== event.payloadJson) throw new EducationWorkflowError(409, "event_id_reused");
        const [current] = await tx.select().from(educationWorkflows).where(eq(educationWorkflows.id, input.id)).limit(1);
        if (!current) throw new EducationWorkflowError(404, "workflow_not_found");
        return { row: current, duplicate: true };
      }
      const [current] = await tx.select().from(educationWorkflows).where(eq(educationWorkflows.id, input.id)).limit(1);
      if (!current) throw new EducationWorkflowError(404, "workflow_not_found");
      const { next, nextVersion, now } = prepare(current);
      const [updated] = await tx.update(educationWorkflows).set({
        stage: next.stage, status: next.status, version: nextVersion, stateJson: JSON.stringify(next.state), updatedAt: now,
      }).where(and(eq(educationWorkflows.id, input.id), eq(educationWorkflows.version, input.expectedVersion as number))).returning();
      if (!updated) {
        const [latest] = await tx.select().from(educationWorkflows).where(eq(educationWorkflows.id, input.id)).limit(1);
        throw new EducationWorkflowError(409, "stale_version", latest ? serializeRow(latest) : null);
      }
      await tx.insert(educationWorkflowEvents).values({ ...event, version: nextVersion, createdAt: now });
      return { row: updated, duplicate: false };
    });
  } else {
    const sqliteDb = db as unknown as BetterSQLite3Database<SqliteSchema>;
    txResult = sqliteDb.transaction((tx) => {
      const seen = tx.select().from(educationWorkflowEvents).where(eq(educationWorkflowEvents.id, eventId)).limit(1).get();
      if (seen) {
        if (seen.workflowId !== input.id || seen.action !== action || seen.payloadJson !== event.payloadJson) throw new EducationWorkflowError(409, "event_id_reused");
        const current = tx.select().from(educationWorkflows).where(eq(educationWorkflows.id, input.id)).limit(1).get();
        if (!current) throw new EducationWorkflowError(404, "workflow_not_found");
        return { row: current as WorkflowRow, duplicate: true };
      }
      const current = tx.select().from(educationWorkflows).where(eq(educationWorkflows.id, input.id)).limit(1).get();
      if (!current) throw new EducationWorkflowError(404, "workflow_not_found");
      const { next, nextVersion, now } = prepare(current as WorkflowRow);
      const updated = tx.update(educationWorkflows).set({
        stage: next.stage, status: next.status, version: nextVersion, stateJson: JSON.stringify(next.state), updatedAt: now,
      }).where(and(eq(educationWorkflows.id, input.id), eq(educationWorkflows.version, input.expectedVersion as number))).returning().get() as WorkflowRow | undefined;
      if (!updated) {
        const latest = tx.select().from(educationWorkflows).where(eq(educationWorkflows.id, input.id)).limit(1).get();
        throw new EducationWorkflowError(409, "stale_version", latest ? serializeRow(latest as WorkflowRow) : null);
      }
      tx.insert(educationWorkflowEvents).values({ ...event, version: nextVersion, createdAt: now }).run();
      return { row: updated, duplicate: false };
    });
  }
  return { workflow: serializeRow(txResult.row), duplicate: txResult.duplicate };
}
