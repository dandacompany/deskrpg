/**
 * Project listing table (designed 2026-09-21 project-registry).
 *
 * **A board = a project, a tenant = a subproject.** Boards, cards, and tenant values are all
 * Hermes' source of truth; what's left here is only the human-side info Hermes has no place
 * for — status, the lead employee, target date, color, icon, pause reason, and the origin
 * meeting that answers "why are we doing this."
 *
 * So **name, description, and progress are not stored** (hard gate 1).
 * - Name/description: the Hermes board meta is the source of truth. Changing it calls
 *   `PATCH /kanban/boards/{slug}`.
 * - Progress: `GET /kanban/boards` already gives `total` and per-status `counts` for each board.
 * When building a listing, both are read and joined with the meta table — keeping a copy would
 * eventually drift.
 *
 * **Meta rows are created lazily.** Channels that predate the migration have a board but no meta
 * row. That channel shouldn't get blocked with "no project" errors, so when the listing is read
 * or a subproject is created, a default row is created on the spot (`ensureProjectRow`). Lazy
 * creation doesn't call Hermes — the board already exists; all we're creating is our own meta row.
 */

import { withChannelAutomationLock } from "./channel-automation-lock";
import {
  EventCarrierError,
  recoverEventCarrierHandoff,
  handoffEventCarrier,
} from "./event-carrier-handoff";
import { schedulePollNow } from "./automation-poll-trigger";
import { and, eq } from "drizzle-orm";

import { channelKanbanBoards, channelProjects, channelSubprojects, db, npcs, nowForDb } from "@/db";
import type { BoardMeta } from "@/lib/hermes/deskrpg-plugin-types";
import type { OwnerPluginClient } from "@/lib/hermes/plugin-client-types";
import type { PluginInfo } from "@/lib/hermes/deskrpg-plugin-types";
import { supportsBoardArchive } from "@/lib/hermes/plugin-capability";
import {
  ensureChannelBoard,
  ensureChannelCarrier,
  resolveChannelBoard,
  listChannelBoards,
  newChannelBoardSlug,
  type ChannelBoardRow,
} from "@/lib/kanban-boards";
import { isTenantSlug, tenantSlugFromName } from "@/lib/tenant-slug";

export type ProjectRow = typeof channelProjects.$inferSelect;
export type SubprojectRow = typeof channelSubprojects.$inferSelect;

/** Same wording as Paperclip's projects. `paused` isn't a status — it's `in_progress` with `pauseReason` set. */
export const PROJECT_STATUSES = [
  "backlog",
  "planned",
  "in_progress",
  "completed",
  "cancelled",
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** Statuses collapsed by default in the listing — done work. Polling keeps going regardless (§5-3). */
export const ARCHIVED_STATUSES: ReadonlySet<string> = new Set(["completed", "cancelled"]);

/**
 * A target date is a calendar day, `YYYY-MM-DD`, that exists. The timeline reads it as the end of
 * that day in the viewer's time zone, so no time or offset is stored. Without this check a bad
 * value reaches PG's `date` column as a 500, or SQLite's text column as a date nobody can draw.
 */
export function isTargetDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const day = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === value;
}

function assertTargetDate(value: string | null | undefined) {
  if (typeof value === "string" && !isTargetDate(value))
    throw new ProjectRegistryError(400, "invalid_target_date");
}

export function isProjectStatus(value: unknown): value is ProjectStatus {
  return typeof value === "string" && (PROJECT_STATUSES as readonly string[]).includes(value);
}

export class ProjectRegistryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    /** Extra response fields the screen reads, e.g. `running` for `board_has_running_cards`. */
    readonly details: Record<string, unknown> = {},
  ) {
    super(message ?? code);
  }
}

// ---------------------------------------------------------------------------
// Meta row — lazy creation
// ---------------------------------------------------------------------------

async function readProjectByBoardLink(boardLinkId: string): Promise<ProjectRow | null> {
  const [row] = await db
    .select()
    .from(channelProjects)
    .where(eq(channelProjects.boardLinkId, boardLinkId))
    .limit(1);
  return row ?? null;
}

/**
 * The project meta row for that board. Creates one with defaults if it doesn't exist.
 *
 * This exists so pre-migration channels aren't blocked. If two calls race to create one, the
 * `board_link_id` unique constraint rejects one of them — in that case, the winner's row is read
 * back and returned. There's no reason to turn that into a failure.
 */
export async function ensureProjectRow(
  board: ChannelBoardRow,
  seed?: Partial<Pick<ProjectRow, "status" | "originMeetingId" | "createdByUserId">>,
): Promise<ProjectRow> {
  const existing = await readProjectByBoardLink(board.id);
  if (existing) return existing;
  const now = nowForDb();
  try {
    const [created] = await db
      .insert(channelProjects)
      .values({
        boardLinkId: board.id,
        channelId: board.channelId,
        status: seed?.status ?? "planned",
        originMeetingId: seed?.originMeetingId ?? null,
        createdByUserId: seed?.createdByUserId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created;
  } catch (err) {
    const raced = await readProjectByBoardLink(board.id);
    if (raced) return raced;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/** One row as seen by screen/chunk 1. Merges the Hermes values with our meta. */
export type ProjectView = {
  id: string;
  boardSlug: string;
  isEventCarrier: boolean;
  /** Hermes board meta. `null` if the board has disappeared from the gateway — the screen must say so. */
  name: string | null;
  description: string | null;
  status: string;
  leadNpcId: string | null;
  targetDate: string | null;
  color: string | null;
  icon: string | null;
  pauseReason: string | null;
  originMeetingId: string | null;
  /** Not stored — carried through exactly as Hermes returned it. */
  progress: { total: number; counts: Record<string, number> } | null;
  lastError: string | null;
};

function toIsoDate(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function viewOf(
  board: ChannelBoardRow,
  project: ProjectRow,
  meta: (BoardMeta & { counts?: Record<string, number> }) | undefined,
): ProjectView {
  return {
    id: project.id,
    boardSlug: board.boardSlug,
    isEventCarrier: Boolean(board.isEventCarrier),
    name: meta?.name ?? null,
    description: meta?.description ?? null,
    status: project.status,
    leadNpcId: project.leadNpcId,
    targetDate: toIsoDate(project.targetDate),
    color: project.color,
    icon: project.icon,
    pauseReason: project.pauseReason,
    originMeetingId: project.originMeetingId,
    progress: meta ? { total: meta.total ?? 0, counts: meta.counts ?? {} } : null,
    lastError: board.lastError,
  };
}

/**
 * The channel's project listing. The link row is the source of truth, layered with Hermes board meta.
 *
 * Boards missing from the gateway are **not hidden** — swapping the gateway (decision D-1) leaves
 * the meta behind but empties the cards, and silently hiding that would make users think the
 * project disappeared. It's carried with `name: null` so the screen can say "this gateway has no
 * board for this."
 */
export async function listChannelProjects(
  channelId: string,
  client: OwnerPluginClient,
): Promise<ProjectView[]> {
  // The reader fixes it up — this revives a channel whose carrier count dropped to 0 (§the gap between archive's two UPDATEs).
  await ensureChannelCarrier(channelId);
  const boards = await listChannelBoards(channelId);
  if (boards.length === 0) return [];

  const listed = await client.kanban.listBoards();
  const metaBySlug = new Map<string, BoardMeta & { counts?: Record<string, number> }>();
  if (listed.ok) {
    for (const meta of listed.data.boards) metaBySlug.set(meta.slug, meta);
  }

  const views: ProjectView[] = [];
  for (const board of boards) {
    const project = await ensureProjectRow(board);
    views.push(viewOf(board, project, metaBySlug.get(board.boardSlug)));
  }
  return views;
}

export async function readProject(channelId: string, projectId: string): Promise<ProjectRow> {
  const [row] = await db
    .select()
    .from(channelProjects)
    .where(and(eq(channelProjects.id, projectId), eq(channelProjects.channelId, channelId)))
    .limit(1);
  if (!row) throw new ProjectRegistryError(404, "project_not_found");
  return row;
}

export async function readProjectBoard(project: ProjectRow): Promise<ChannelBoardRow> {
  const [row] = await db
    .select()
    .from(channelKanbanBoards)
    .where(eq(channelKanbanBoards.id, project.boardLinkId))
    .limit(1);
  // The link row carries meta via cascade, so meta existing without a link should be impossible.
  if (!row) throw new ProjectRegistryError(404, "project_not_found");
  return row;
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

/**
 * Board cap per channel. The reason is the cron event: the plugin's `/deskrpg/events` re-scans
 * the cron tail for every board, and we drop events that arrive on a board that isn't the event
 * receiver (§2-3). More boards means that wasted work grows linearly. This is a number to tune by
 * measuring polling delay, not a structural limit.
 */
export const MAX_BOARDS_PER_CHANNEL = 20;

export type CreateProjectInput = {
  name: string;
  description?: string;
  status?: string;
  leadNpcId?: string | null;
  targetDate?: string | null;
  color?: string | null;
  icon?: string | null;
  originMeetingId?: string | null;
  createdByUserId: string;
  subprojects?: { tenantSlug?: string; name: string; description?: string }[];
};

/**
 * Creates a project (= a board).
 *
 * **Order is the rule.** The board is created in Hermes first, and only on success are the link
 * row and meta row written. Reversing this order leaves meta with no source of truth, showing a
 * project in the listing that doesn't exist.
 */
export async function createChannelProject(
  channelId: string,
  _client: OwnerPluginClient,
  input: CreateProjectInput,
): Promise<{ project: ProjectView; subprojects: SubprojectRow[] }> {
  return withChannelAutomationLock(channelId, async () => {
    await recoverEventCarrierHandoff(channelId);
    // The caller's client may have been made before a queued gateway replacement.
    const resolved = await resolveChannelBoard(channelId);
    if (!resolved.ok) throw new EventCarrierError(409, resolved.code);
    if (!resolved.pluginGate.ok) throw new EventCarrierError(428, resolved.pluginGate.code);
    return createChannelProjectUnlocked(channelId, resolved.ownerClient, input);
  });
}

async function createChannelProjectUnlocked(
  channelId: string,
  client: OwnerPluginClient,
  input: CreateProjectInput,
): Promise<{ project: ProjectView; subprojects: SubprojectRow[] }> {
  const name = input.name.trim();
  if (!name || name.length > 120) throw new ProjectRegistryError(400, "invalid_project_name");
  assertTargetDate(input.targetDate);
  if (input.status !== undefined && !isProjectStatus(input.status))
    throw new ProjectRegistryError(400, "invalid_project_status");

  const boards = await listChannelBoards(channelId);
  if (boards.length >= MAX_BOARDS_PER_CHANNEL)
    throw new ProjectRegistryError(409, "board_limit_reached");

  // Subproject slugs are validated **before the board is created** — catching it later leaves an empty board behind in Hermes.
  const subprojects = (input.subprojects ?? []).map((sub) => resolveSubprojectSlug(sub));
  assertUniqueSlugs(subprojects.map((s) => s.tenantSlug));

  const slug = newChannelBoardSlug(channelId);
  const ensured = await ensureChannelBoard(channelId, undefined, slug);
  if (!ensured.ok) throw new ProjectRegistryError(503, ensured.code, ensured.reason);

  // Hermes is the source of truth for the board name. `createBoard` doesn't overwrite the name
  // for an existing slug, so giving a newly created board the user's chosen name needs one more PATCH.
  const patched = await client.kanban.updateBoard(slug, {
    name,
    ...(input.description === undefined ? {} : { description: input.description }),
  });
  if (!patched.ok)
    throw new ProjectRegistryError(503, patched.failure.code, patched.failure.message);

  const now = nowForDb();
  const [project] = await db
    .insert(channelProjects)
    .values({
      boardLinkId: ensured.row.id,
      channelId,
      status: isProjectStatus(input.status) ? input.status : "planned",
      leadNpcId: input.leadNpcId ?? null,
      targetDate: input.targetDate ?? null,
      color: input.color ?? null,
      icon: input.icon ?? null,
      originMeetingId: input.originMeetingId ?? null,
      createdByUserId: input.createdByUserId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  const created: SubprojectRow[] = [];
  for (const sub of subprojects) {
    created.push(await insertSubproject(project.id, sub, input.originMeetingId ?? null));
  }

  return {
    project: viewOf(ensured.row, project, patched.data.board),
    subprojects: created,
  };
}

// ---------------------------------------------------------------------------
// Update / archive
// ---------------------------------------------------------------------------

export type UpdateProjectInput = {
  name?: string;
  description?: string;
  status?: string;
  leadNpcId?: string | null;
  targetDate?: string | null;
  color?: string | null;
  icon?: string | null;
  pauseReason?: string | null;
};

export async function updateChannelProject(
  ...args: Parameters<typeof updateChannelProjectUnlocked>
): Promise<ProjectView> {
  const result = await withChannelAutomationLock(args[0], async () => {
    await recoverEventCarrierHandoff(args[0]);
    // The binding may have changed while waiting for the lock. Don't reuse a client created before the request.
    const resolved = await resolveChannelBoard(args[0]);
    if (!resolved.ok) throw new EventCarrierError(409, resolved.code);
    if (!resolved.pluginGate.ok) throw new EventCarrierError(428, resolved.pluginGate.code);
    return updateChannelProjectUnlocked(
      args[0],
      args[1],
      resolved.ownerClient,
      args[3],
      resolved.pluginGate.info,
    );
  });
  schedulePollNow(args[0]);
  return result;
}

async function updateChannelProjectUnlocked(
  channelId: string,
  projectId: string,
  client: OwnerPluginClient,
  input: UpdateProjectInput,
  info: PluginInfo | null = null,
): Promise<ProjectView> {
  const project = await readProject(channelId, projectId);
  let board = await readProjectBoard(project);

  if (input.status !== undefined && !isProjectStatus(input.status))
    throw new ProjectRegistryError(400, "invalid_project_status");
  assertTargetDate(input.targetDate);

  // Name/description are Hermes' source of truth, so they aren't written to our table — they're passed through to Hermes instead.
  let meta: BoardMeta | undefined;
  if (input.name !== undefined || input.description !== undefined) {
    const name = input.name?.trim();
    if (input.name !== undefined && (!name || name.length > 120))
      throw new ProjectRegistryError(400, "invalid_project_name");
    const patched = await client.kanban.updateBoard(board.boardSlug, {
      ...(name === undefined ? {} : { name }),
      ...(input.description === undefined ? {} : { description: input.description }),
    });
    if (!patched.ok)
      throw new ProjectRegistryError(503, patched.failure.code, patched.failure.message);
    meta = patched.data.board;
  }

  if (input.status === "completed" || input.status === "cancelled") {
    await archiveChannelProjectUnlocked(channelId, projectId, input.status);
    board = await readProjectBoard(project);
  } else if (
    input.status !== undefined &&
    ARCHIVED_STATUSES.has(project.status) &&
    supportsBoardArchive(info)
  ) {
    // Reopening: the dispatcher skips an archived Hermes board, so its ready cards would never run.
    await setBoardArchived(client, board.boardSlug, false);
  }
  const patch: Partial<ProjectRow> = { updatedAt: nowForDb() };
  if (input.status !== undefined) patch.status = input.status;
  if (input.leadNpcId !== undefined) patch.leadNpcId = input.leadNpcId;
  if (input.targetDate !== undefined) patch.targetDate = input.targetDate;
  if (input.color !== undefined) patch.color = input.color;
  if (input.icon !== undefined) patch.icon = input.icon;
  if (input.pauseReason !== undefined) patch.pauseReason = input.pauseReason;

  const [updated] = await db
    .update(channelProjects)
    .set(patch)
    .where(eq(channelProjects.id, project.id))
    .returning();

  if (!meta) {
    const listed = await client.kanban.listBoards();
    if (listed.ok) meta = listed.data.boards.find((b) => b.slug === board.boardSlug);
  }
  return viewOf(board, updated, meta);
}

/** On archive, keep the per-board k/d and have the plugin hand off only the existing receiver position c/a. */
export async function archiveChannelProject(
  ...args: Parameters<typeof archiveChannelProjectUnlocked>
) {
  const result = await withChannelAutomationLock(args[0], async () => {
    await recoverEventCarrierHandoff(args[0]);
    return archiveChannelProjectUnlocked(...args);
  });
  schedulePollNow(args[0]);
  return result;
}

async function archiveChannelProjectUnlocked(
  channelId: string,
  projectId: string,
  status: "completed" | "cancelled",
): Promise<{ project: ProjectRow; carrierMovedTo: string | null }> {
  const project = await readProject(channelId, projectId);
  const board = await readProjectBoard(project);

  const boards = await listChannelBoards(channelId);
  const projects = new Map<string, ProjectRow>();
  for (const row of boards) projects.set(row.id, await ensureProjectRow(row));

  const stillActive = boards.filter(
    (row) => row.id !== board.id && !ARCHIVED_STATUSES.has(projects.get(row.id)?.status ?? ""),
  );
  if (stillActive.length === 0) throw new ProjectRegistryError(400, "last_board");

  const resolved = await resolveChannelBoard(channelId);
  if (!resolved.ok) throw new EventCarrierError(409, resolved.code);
  if (!resolved.pluginGate.ok) throw new EventCarrierError(428, resolved.pluginGate.code);
  const client = resolved.ownerClient;

  // Archive the Hermes board first: the plugin refuses a board with running cards, and that refusal
  // must leave the carrier and our status untouched. An older plugin keeps the metadata-only archive.
  const archiveBoard = supportsBoardArchive(resolved.pluginGate.info);
  if (archiveBoard) await setBoardArchived(client, board.boardSlug, true);

  try {
    let carrierMovedTo: string | null = null;
    if (board.isEventCarrier) {
      const next = stillActive[0];
      await handoffEventCarrier({
        channelId,
        sourceId: board.id,
        targetId: next.id,
        projectId: project.id,
        status,
        client,
      });
      carrierMovedTo = next.boardSlug;
    }

    const [updated] = await db
      .update(channelProjects)
      .set({ status, updatedAt: nowForDb() })
      .where(eq(channelProjects.id, project.id))
      .returning();
    return { project: updated, carrierMovedTo };
  } catch (err) {
    if (archiveBoard) {
      // Put the board back so its cards keep dispatching; the project stays active on our side.
      await setBoardArchived(client, board.boardSlug, false).catch((undo) => {
        console.warn(
          `[project-registry] could not unarchive ${board.boardSlug}: ${undo instanceof Error ? undo.message : String(undo)}`,
        );
      });
    }
    throw err;
  }
}

async function setBoardArchived(client: OwnerPluginClient, slug: string, archived: boolean) {
  const res = await client.kanban.updateBoard(slug, { archived });
  if (res.ok) return;
  const status = res.status === 409 || res.status === 400 ? res.status : 503;
  // Only the count the screen shows is passed on — other plugin fields stay on the server.
  const running = res.failure.details.running;
  throw new ProjectRegistryError(
    status,
    res.failure.code,
    res.failure.message,
    typeof running === "number" ? { running } : {},
  );
}

// ---------------------------------------------------------------------------
// Subprojects
// ---------------------------------------------------------------------------

function resolveSubprojectSlug(input: { tenantSlug?: string; name: string; description?: string }) {
  const name = input.name.trim();
  if (!name || name.length > 120) throw new ProjectRegistryError(400, "invalid_subproject_name");
  const slug = input.tenantSlug?.trim() ? input.tenantSlug.trim() : tenantSlugFromName(name);
  if (!slug) {
    // The name had no letters or digits at all. Kept distinct from a format violation so the screen can guide the user precisely.
    throw new ProjectRegistryError(400, "tenant_slug_underivable");
  }
  if (!isTenantSlug(slug)) throw new ProjectRegistryError(400, "invalid_tenant_slug");
  return { tenantSlug: slug, name, description: input.description };
}

function assertUniqueSlugs(slugs: string[]) {
  if (new Set(slugs).size !== slugs.length)
    throw new ProjectRegistryError(409, "subproject_exists");
}

async function insertSubproject(
  projectId: string,
  sub: { tenantSlug: string; name: string; description?: string },
  originMeetingId: string | null,
): Promise<SubprojectRow> {
  const now = nowForDb();
  try {
    const [row] = await db
      .insert(channelSubprojects)
      .values({
        projectId,
        tenantSlug: sub.tenantSlug,
        name: sub.name,
        description: sub.description ?? null,
        originMeetingId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return row;
  } catch {
    // The `(project_id, tenant_slug)` unique constraint fired — the same slug was registered twice.
    throw new ProjectRegistryError(409, "subproject_exists");
  }
}

export type SubprojectView = SubprojectRow & {
  /** Whether a card using this slug actually exists on the board. Meta can exist with no card. */
  observed: boolean;
};

/**
 * The subproject listing. Left-joins registered meta with **tenants observed on the board**.
 *
 * A card created outside DeskRPG (Hermes CLI, another tool) can carry a `tenant` value we don't
 * know about. Silently hiding such a value would leave the user unable to tell where the card
 * went — it's carried with the slug as its name and `registered: false`.
 */
export async function listSubprojects(
  project: ProjectRow,
  board: ChannelBoardRow,
  client: OwnerPluginClient,
): Promise<{ registered: SubprojectView[]; unregistered: string[] }> {
  const rows = await db
    .select()
    .from(channelSubprojects)
    .where(eq(channelSubprojects.projectId, project.id))
    .orderBy(channelSubprojects.createdAt);

  const view = await client.kanban.getBoard(board.boardSlug, { includeArchived: true });
  const observed = new Set<string>(view.ok ? (view.data.tenants ?? []) : []);
  const known = new Set(rows.map((r) => r.tenantSlug));

  return {
    registered: rows.map((row) => ({ ...row, observed: observed.has(row.tenantSlug) })),
    unregistered: [...observed].filter((slug) => !known.has(slug)).sort(),
  };
}

export async function createSubproject(
  project: ProjectRow,
  input: {
    tenantSlug?: string;
    name: string;
    description?: string;
    originMeetingId?: string | null;
  },
): Promise<SubprojectRow> {
  const sub = resolveSubprojectSlug(input);
  return insertSubproject(project.id, sub, input.originMeetingId ?? null);
}

export type UpdateSubprojectInput = {
  name?: string;
  description?: string | null;
  status?: string;
  leadNpcId?: string | null;
  targetDate?: string | null;
  color?: string | null;
  icon?: string | null;
  pauseReason?: string | null;
};

/** The slug isn't accepted here — Hermes cards carry that string, and changing it would orphan them. */
export async function updateSubproject(
  projectId: string,
  subprojectId: string,
  input: UpdateSubprojectInput,
): Promise<SubprojectRow> {
  const [row] = await db
    .select()
    .from(channelSubprojects)
    .where(
      and(eq(channelSubprojects.id, subprojectId), eq(channelSubprojects.projectId, projectId)),
    )
    .limit(1);
  if (!row) throw new ProjectRegistryError(404, "subproject_not_found");

  if (input.status !== undefined && !isProjectStatus(input.status))
    throw new ProjectRegistryError(400, "invalid_project_status");
  assertTargetDate(input.targetDate);

  const patch: Partial<SubprojectRow> = { updatedAt: nowForDb() };
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name || name.length > 120) throw new ProjectRegistryError(400, "invalid_subproject_name");
    patch.name = name;
  }
  if (input.description !== undefined) patch.description = input.description;
  if (input.status !== undefined) patch.status = input.status;
  if (input.leadNpcId !== undefined) patch.leadNpcId = input.leadNpcId;
  if (input.targetDate !== undefined) patch.targetDate = input.targetDate;
  if (input.color !== undefined) patch.color = input.color;
  if (input.icon !== undefined) patch.icon = input.icon;
  if (input.pauseReason !== undefined) patch.pauseReason = input.pauseReason;

  const [updated] = await db
    .update(channelSubprojects)
    .set(patch)
    .where(eq(channelSubprojects.id, row.id))
    .returning();
  return updated;
}

/** Confirms this is an NPC of the channel — only an NPC clocked into that channel can be a lead. */
export async function assertChannelNpc(channelId: string, npcId: string | null | undefined) {
  if (!npcId) return;
  const [row] = await db
    .select({ id: npcs.id })
    .from(npcs)
    .where(and(eq(npcs.id, npcId), eq(npcs.channelId, channelId)))
    .limit(1);
  if (!row) throw new ProjectRegistryError(400, "lead_npc_not_in_channel");
}
