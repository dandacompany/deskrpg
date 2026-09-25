import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { channelGatewayBindings, channelKanbanBoards, channelProjects, db, nowForDb } from "@/db";
import type { OwnerPluginClient } from "./hermes/plugin-client-types";
import { withChannelAutomationLock } from "./channel-automation-lock";

/**
 * Event tokens only the carrier board polls. They share the plugin's `artifact_events` table and one cursor, so they
 * are always requested together — asking for fewer would advance the cursor past the others silently.
 */
export const CARRIER_INCLUDE = "artifacts,card_proposals,approvals";

export class EventCarrierError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

type Journal = {
  version: 1;
  operationId: string;
  channelId: string;
  gatewayId: string;
  sourceId: string;
  targetId: string;
  sourceCursor: string;
  targetCursorBefore: string | null;
  mergedCursor: string;
  projectId: string;
  requestedStatus: "completed" | "cancelled";
};
const conflict = () => new EventCarrierError(409, "event_carrier_handoff_conflict");
const archived = (status: string) => status === "completed" || status === "cancelled";
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

function parseJournal(raw: string): Journal {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw conflict();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw conflict();
  const j = value as Record<string, unknown>;
  const keys = [
    "operationId",
    "channelId",
    "gatewayId",
    "sourceId",
    "targetId",
    "sourceCursor",
    "mergedCursor",
    "projectId",
  ];
  if (
    j.version !== 1 ||
    keys.some((key) => !nonempty(j[key])) ||
    !(j.targetCursorBefore === null || nonempty(j.targetCursorBefore)) ||
    !(j.requestedStatus === "completed" || j.requestedStatus === "cancelled")
  )
    throw conflict();
  return j as Journal;
}

export async function recordEventCarrierError(channelId: string, code: string): Promise<void> {
  await db
    .update(channelKanbanBoards)
    .set({ lastError: code, updatedAt: nowForDb() })
    .where(eq(channelKanbanBoards.channelId, channelId));
}

/** Resumes using only the stored opaque cursor. No network calls or event consumption happen during recovery. */
export async function recoverEventCarrierHandoff(channelId: string): Promise<void> {
  return withChannelAutomationLock(channelId, async () => {
    try {
      await recover(channelId);
    } catch (err) {
      const failure =
        err instanceof EventCarrierError
          ? err
          : new EventCarrierError(503, "event_carrier_handoff_pending");
      await recordEventCarrierError(channelId, failure.code).catch(() => {});
      throw failure;
    }
  });
}

async function recover(channelId: string): Promise<void> {
  const rows = await db
    .select()
    .from(channelKanbanBoards)
    .where(eq(channelKanbanBoards.channelId, channelId));
  const pending = rows.filter((r) => r.eventCarrierHandoffJson !== null);
  if (pending.length === 0) return;
  if (pending.length !== 1) throw conflict();
  const j = parseJournal(pending[0].eventCarrierHandoffJson!);
  const source = rows.find((r) => r.id === j.sourceId);
  const target = rows.find((r) => r.id === j.targetId);
  const [binding] = await db
    .select()
    .from(channelGatewayBindings)
    .where(eq(channelGatewayBindings.channelId, channelId));
  const projects = await db
    .select()
    .from(channelProjects)
    .where(eq(channelProjects.channelId, channelId));
  const project = projects.find((p) => p.id === j.projectId);
  const targetProject = projects.find((p) => p.boardLinkId === j.targetId);
  if (
    j.channelId !== channelId ||
    j.sourceId !== pending[0].id ||
    j.sourceId === j.targetId ||
    !source ||
    !target ||
    !project ||
    project.boardLinkId !== source.id ||
    source.gatewayId !== j.gatewayId ||
    target.gatewayId !== j.gatewayId ||
    binding?.gatewayId !== j.gatewayId ||
    source.eventCursor !== j.sourceCursor ||
    rows.some((r) => r.isEventCarrier && r.id !== source.id && r.id !== target.id) ||
    (source.isEventCarrier && target.isEventCarrier) ||
    (targetProject && archived(targetProject.status)) ||
    (archived(project.status) &&
      (project.status !== j.requestedStatus || !target.isEventCarrier)) ||
    target.eventCursor !== (target.isEventCarrier ? j.mergedCursor : j.targetCursorBefore)
  )
    throw conflict();

  // Polling doesn't start until the journal is cleared, so re-running these writes never rewinds the cursor.
  await db
    .update(channelKanbanBoards)
    .set({ isEventCarrier: false, updatedAt: nowForDb() })
    .where(eq(channelKanbanBoards.id, source.id));
  await db
    .update(channelKanbanBoards)
    .set({
      isEventCarrier: true,
      eventCursor: j.mergedCursor,
      lastError: null,
      updatedAt: nowForDb(),
    })
    .where(eq(channelKanbanBoards.id, target.id));
  await db
    .update(channelProjects)
    .set({ status: j.requestedStatus, updatedAt: nowForDb() })
    .where(eq(channelProjects.id, project.id));
  await db
    .update(channelKanbanBoards)
    .set({ lastError: null })
    .where(
      and(
        eq(channelKanbanBoards.channelId, channelId),
        inArray(channelKanbanBoards.lastError, [
          "event_carrier_handoff_pending",
          "event_carrier_handoff_conflict",
          "event_carrier_origin_unknown",
        ]),
      ),
    );
  await db
    .update(channelKanbanBoards)
    .set({ eventCarrierHandoffJson: null, lastError: null, updatedAt: nowForDb() })
    .where(eq(channelKanbanBoards.id, source.id));
}

export async function handoffEventCarrier(input: {
  channelId: string;
  sourceId: string;
  targetId: string;
  projectId: string;
  status: "completed" | "cancelled";
  client: OwnerPluginClient;
}): Promise<void> {
  return withChannelAutomationLock(input.channelId, async () => {
    try {
      await recoverEventCarrierHandoff(input.channelId);
      const rows = await db
        .select()
        .from(channelKanbanBoards)
        .where(eq(channelKanbanBoards.channelId, input.channelId));
      const source = rows.find((r) => r.id === input.sourceId);
      const target = rows.find((r) => r.id === input.targetId);
      const [binding] = await db
        .select()
        .from(channelGatewayBindings)
        .where(eq(channelGatewayBindings.channelId, input.channelId));
      const projects = await db
        .select()
        .from(channelProjects)
        .where(eq(channelProjects.channelId, input.channelId));
      const project = projects.find((p) => p.id === input.projectId);
      const targetProject = projects.find((p) => p.boardLinkId === target?.id);
      if (
        !source ||
        !target ||
        source.id === target.id ||
        !source.isEventCarrier ||
        target.isEventCarrier ||
        source.gatewayId !== target.gatewayId ||
        source.gatewayId !== binding?.gatewayId ||
        !project ||
        project.boardLinkId !== source.id ||
        (targetProject && archived(targetProject.status))
      )
        throw conflict();

      let sourceCursor = source.eventCursor;
      if (sourceCursor === null) {
        const first = await input.client.events.poll({
          board: source.boardSlug,
          include: CARRIER_INCLUDE,
        });
        if (!first.ok) throw new EventCarrierError(first.status || 503, first.failure.code);
        if (!nonempty(first.data.cursor)) throw new EventCarrierError(502, "malformed_response");
        sourceCursor = first.data.cursor;
        await db
          .update(channelKanbanBoards)
          .set({ eventCursor: sourceCursor, updatedAt: nowForDb() })
          .where(eq(channelKanbanBoards.id, source.id));
      }
      const merged = await input.client.events.handoff({
        board: target.boardSlug,
        board_cursor: target.eventCursor,
        carrier_cursor: sourceCursor,
      });
      if (!merged.ok) {
        const missing =
          merged.status === 404 &&
          [
            "not_found",
            "upstream_error",
            "http_error",
            "route_not_found",
            "malformed_response",
          ].includes(merged.failure.code);
        throw new EventCarrierError(
          missing ? 428 : merged.status || 503,
          missing ? "event_cursor_handoff_required" : merged.failure.code,
        );
      }
      if (!nonempty(merged.data.cursor)) throw new EventCarrierError(502, "malformed_response");
      const journal: Journal = {
        version: 1,
        operationId: randomUUID(),
        channelId: input.channelId,
        gatewayId: source.gatewayId,
        sourceId: source.id,
        targetId: target.id,
        sourceCursor,
        targetCursorBefore: target.eventCursor,
        mergedCursor: merged.data.cursor,
        projectId: input.projectId,
        requestedStatus: input.status,
      };
      await db
        .update(channelKanbanBoards)
        .set({ eventCarrierHandoffJson: JSON.stringify(journal), updatedAt: nowForDb() })
        .where(eq(channelKanbanBoards.id, source.id));
      await recoverEventCarrierHandoff(input.channelId);
    } catch (err) {
      // A Drizzle error can carry SQL arguments (including the opaque cursor), so the raw error isn't propagated outward.
      if (err instanceof EventCarrierError) throw err;
      throw new EventCarrierError(503, "event_carrier_handoff_pending");
    }
  });
}
