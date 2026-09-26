/**
 * Channel ↔ Hermes kanban board binding (T4).
 *
 * For boards, **Hermes is the source of truth**. Not a single card is stored here — all we
 * keep is the (channel, gateway, slug) binding record in `channel_kanban_boards` and the
 * last failure reason.
 *
 * As of 2026-09-21, **a channel can have multiple boards** (board = project). The binding
 * row's PK is a surrogate key, and `(channel, slug)` is unique. Exactly one of them is the
 * **event carrier board** (`isEventCarrier`), and gateway-wide events (cron, artifacts) are
 * only received on that row — because the plugin's `/deskrpg/events` doesn't filter cron
 * events by board. `getChannelBoard`/`ensureChannelBoard` with no board argument point to
 * the **event carrier board** (it was the only board before the migration) — so existing
 * callers keep their meaning.
 *
 * - The slug is derived deterministically from the channel UUID (`channelBoardSlug`). So we
 *   never need to ask the DB "does the board already exist" — the plugin's
 *   `POST /deskrpg/kanban/boards` returns the existing board with 200 for the same slug, so
 *   ensuring it is always the same single call (E1).
 * - A failed ensure doesn't block the binding (R5). The row is created anyway with the
 *   reason left in `last_error`, and since `ensureChannelBoard` is idempotent, the next
 *   screen visit or poll simply calls it again.
 * - If the plugin contract (0.6.0 + kanban·cron·events) isn't met, the kanban path is
 *   **left untouched** (R31). The judgment is made by the single gate in
 *   `automation-gate.ts` — the cron REST API uses the same function.
 * - ensureChannelBoard/syncBoardName return failure as a result. An unrecoverable handoff
 *   is an explicit error.
 */

import { withChannelAutomationLock } from "./channel-automation-lock";
import {
  EventCarrierError,
  recoverEventCarrierHandoff,
  recordEventCarrierError,
} from "./event-carrier-handoff";
import { randomBytes } from "node:crypto";

import { and, eq, ne } from "drizzle-orm";

import { gateAutomationPlugin, type PluginGate } from "@/lib/automation-gate";
import { channelKanbanBoards, channelProjects, channels, db, nowForDb } from "@/db";

/**
 * Statuses for a finished project. Same values as `project-registry`'s — kept as a small
 * copy here because importing that module would create a cycle (it imports this file).
 */
const ARCHIVED_PROJECT_STATUSES: ReadonlySet<string> = new Set(["completed", "cancelled"]);
import { decryptGatewayToken, getChannelGatewayBinding } from "@/lib/gateway-resources";
import type { BoardMeta } from "@/lib/hermes/deskrpg-plugin-types";
import { createOwnerPluginClient, type OwnerPluginClient } from "@/lib/hermes/plugin-client";
import { transportFetch } from "@/lib/hermes/setup/transport";
import { supportsReviewHooks } from "@/lib/hermes/plugin-capability";

export type { PluginGate } from "@/lib/automation-gate";

export type ChannelBoardRow = typeof channelKanbanBoards.$inferSelect;

/** The reason ensure/sync failed. Stored as-is in `channel_kanban_boards.last_error`. */
export type ChannelBoardFailureCode =
  | "unbound"
  | "channel_not_found"
  | "no_board"
  | "plugin_absent"
  | "plugin_unauthorized"
  | "plugin_unknown"
  | "plugin_upgrade_required"
  | "internal_error"
  // A failure code returned by the plugin client (unreachable · timeout · malformed_response · the plugin's own error value)
  | (string & {});

export type ChannelBoardResult =
  | { ok: true; board: BoardMeta; row: ChannelBoardRow }
  | { ok: false; code: ChannelBoardFailureCode; reason: string; row: ChannelBoardRow | null };

export type ResolvedChannelBoard =
  | {
      ok: true;
      binding: NonNullable<Awaited<ReturnType<typeof getChannelGatewayBinding>>>;
      ownerClient: OwnerPluginClient;
      boardSlug: string;
      pluginGate: PluginGate;
    }
  | { ok: false; code: "unbound"; reason: string };

/**
 * Channel UUID → board slug. `deskrpg-` + 32 lowercase chars with hyphens stripped.
 * Fits the plugin's slug rule (`[a-z0-9-]{1,64}`), is unique per channel, and is stable
 * across recomputation.
 */
export function channelBoardSlug(channelId: string): string {
  return `deskrpg-${channelId.replace(/-/g, "").toLowerCase()}`;
}

/**
 * The slug used from the second board onward. The first board (= the event carrier board)
 * keeps `channelBoardSlug` as-is — Hermes's card DB lives under `board_dir(slug)` and there
 * is no route to rename a slug, so an existing board's slug can never be touched. Even with
 * the 8-char suffix, `deskrpg-`(8) + 32 + `-`(1) + 8 = 49 chars, still within the plugin's
 * 64-char limit.
 */
export function newChannelBoardSlug(channelId: string): string {
  return `${channelBoardSlug(channelId)}-${randomBytes(4).toString("hex")}`;
}

/**
 * The channel's **event carrier board** row. This is what an old single-argument caller
 * expected as "the channel's board". Since an old row may not yet have a carrier assigned,
 * it falls back to the earliest-created row if none is set.
 */
export async function getChannelBoard(channelId: string): Promise<ChannelBoardRow | null> {
  const rows = await listChannelBoards(channelId);
  return rows.find((row) => row.isEventCarrier) ?? rows[0] ?? null;
}

/** All boards attached to the channel, in creation order — the first row is usually the event carrier board. */
export async function listChannelBoards(channelId: string): Promise<ChannelBoardRow[]> {
  return db
    .select()
    .from(channelKanbanBoards)
    .where(eq(channelKanbanBoards.channelId, channelId))
    .orderBy(channelKanbanBoards.createdAt);
}

/**
 * Finishes an existing handoff record first, if there is one. Without a record, if there's
 * no carrier, it only recovers an uninitialized channel. Guessing the old receive position
 * for an existing channel that already has a saved cursor could skip unconsumed events.
 */
export async function ensureChannelCarrier(channelId: string): Promise<ChannelBoardRow | null> {
  return withChannelAutomationLock(channelId, async () => {
    await recoverEventCarrierHandoff(channelId);
    return ensureChannelCarrierUnlocked(channelId);
  });
}

async function ensureChannelCarrierUnlocked(channelId: string): Promise<ChannelBoardRow | null> {
  const rows = await listChannelBoards(channelId);
  if (rows.length === 0) return null;
  const current = rows.find((row) => row.isEventCarrier);
  if (current) return current;
  if (rows.some((row) => row.eventCursor !== null)) {
    await recordEventCarrierError(channelId, "event_carrier_origin_unknown");
    throw new EventCarrierError(409, "event_carrier_origin_unknown");
  }

  const archivedLinkIds = new Set(
    (
      await db
        .select({ boardLinkId: channelProjects.boardLinkId, status: channelProjects.status })
        .from(channelProjects)
        .where(eq(channelProjects.channelId, channelId))
    )
      .filter((row) => ARCHIVED_PROJECT_STATUSES.has(row.status))
      .map((row) => row.boardLinkId),
  );

  const candidate = rows.find((row) => !archivedLinkIds.has(row.id)) ?? rows[0];
  const [restored] = await db
    .update(channelKanbanBoards)
    .set({ isEventCarrier: true, updatedAt: nowForDb() })
    .where(eq(channelKanbanBoards.id, candidate.id))
    .returning();
  console.warn(
    `[kanban-boards] channel ${channelId} had no event carrier; restored ${candidate.boardSlug}`,
  );
  return restored ?? candidate;
}

/**
 * The board row attached to this channel **under that slug**. null if none — the caller
 * should respond 404. This is the only guard that stops fetching another channel's board
 * by slug, so the channel condition can never be dropped.
 */
export async function getChannelBoardBySlug(
  channelId: string,
  boardSlug: string,
): Promise<ChannelBoardRow | null> {
  const [row] = await db
    .select()
    .from(channelKanbanBoards)
    .where(
      and(
        eq(channelKanbanBoards.channelId, channelId),
        eq(channelKanbanBoards.boardSlug, boardSlug),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * The entry point reused by downstream consumers (kanban routes, poller) — resolves the
 * binding, owner client, slug, and plugin gate all at once. `unbound` if there's no
 * binding. A gate failure is returned as `pluginGate.ok=false` and nothing is recorded
 * here (recording is `ensureChannelBoard`'s job).
 */
export async function resolveChannelBoard(channelId: string): Promise<ResolvedChannelBoard> {
  const binding = await getChannelGatewayBinding(channelId);
  if (!binding) {
    return { ok: false, code: "unbound", reason: "channel has no gateway binding" };
  }
  const ownerToken = decryptGatewayToken(binding.resource.tokenEncrypted);
  const ownerClient = createOwnerPluginClient({
    baseUrl: binding.resource.baseUrl,
    ownerToken,
    fetchImpl: transportFetch,
  });
  const pluginGate = await gateAutomationPlugin(binding.resource, ownerToken);
  return { ok: true, binding, ownerClient, boardSlug: channelBoardSlug(channelId), pluginGate };
}

/**
 * If the gateway changed, **moves the channel's board rows to the new gateway** (R4).
 *
 * The old approach was to delete the row and create a new one. That's no longer possible —
 * `channel_projects.board_link_id` holds the binding row via cascade, so deleting the row
 * would also wipe project metadata (status, target date, origin meeting). Decision D-1 is
 * "keep the metadata, just re-attach the binding", so the row id is kept and only the
 * gateway is swapped in — **the cursor and sync timestamp belonging to the old gateway are
 * discarded.**
 *
 * The card may not exist on the new gateway. That's a fact for the screen to surface, not
 * something to hide here.
 */
async function migrateChannelBoardsToGateway(channelId: string, gatewayId: string): Promise<void> {
  await db
    .update(channelKanbanBoards)
    .set({
      gatewayId,
      eventCursor: null,
      boardNameSyncedAt: null,
      lastError: null,
      updatedAt: nowForDb(),
    })
    .where(
      and(
        eq(channelKanbanBoards.channelId, channelId),
        ne(channelKanbanBoards.gatewayId, gatewayId),
      ),
    );
}

/**
 * Writes the binding row — keyed by `(channel, slug)`. If the channel has no board yet, the
 * row created here becomes the **event carrier board** (a channel has exactly one place
 * that receives cron and artifacts).
 */
async function upsertBoardRow(input: {
  channelId: string;
  gatewayId: string;
  boardSlug: string;
  lastError: string | null;
  boardNameSyncedAt?: Date | null;
}): Promise<ChannelBoardRow> {
  await migrateChannelBoardsToGateway(input.channelId, input.gatewayId);
  await ensureChannelCarrier(input.channelId);
  const now = nowForDb();
  const existing = await getChannelBoardBySlug(input.channelId, input.boardSlug);

  if (existing) {
    const [updated] = await db
      .update(channelKanbanBoards)
      .set({
        lastError: input.lastError,
        ...(input.boardNameSyncedAt === undefined
          ? {}
          : { boardNameSyncedAt: input.boardNameSyncedAt }),
        updatedAt: now,
      })
      .where(eq(channelKanbanBoards.id, existing.id))
      .returning();
    return updated;
  }

  // The first board is the event carrier board. A partial unique index blocks a second carrier.
  const carrierExists = (await listChannelBoards(input.channelId)).some((r) => r.isEventCarrier);
  const [created] = await db
    .insert(channelKanbanBoards)
    .values({
      channelId: input.channelId,
      gatewayId: input.gatewayId,
      boardSlug: input.boardSlug,
      isEventCarrier: !carrierExists,
      boardNameSyncedAt: input.boardNameSyncedAt ?? null,
      lastError: input.lastError,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return created;
}

async function readChannelName(channelId: string): Promise<string | null> {
  const [channel] = await db
    .select({ name: channels.name })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);
  return channel?.name ?? null;
}

/**
 * Ensures the channel has a board — reuses it if the slug exists, creates it otherwise
 * (R1). Idempotent and never throws. Even on failure, the binding row stays and the reason
 * is recorded in `last_error` (R5).
 *
 * If the caller has already resolved via `resolveChannelBoard`, pass it as `resolved` — to
 * avoid building the gate and client twice within one request (kanban access control, the
 * poller).
 */
export async function ensureChannelBoard(
  ...args: Parameters<typeof ensureChannelBoardUnlocked>
): Promise<ChannelBoardResult> {
  return withChannelAutomationLock(args[0], async () => {
    try {
      await recoverEventCarrierHandoff(args[0]);
      return await ensureChannelBoardUnlocked(...args);
    } catch (err) {
      const code = err instanceof EventCarrierError ? err.code : "internal_error";
      return { ok: false, code, reason: code, row: null };
    }
  });
}

/** Boards whose default policy this process has already seen set — the poller ensures boards often. */
const defaultPolicyChecked: Set<string> = ((
  globalThis as { __deskrpgBoardDefaultChecked?: Set<string> }
).__deskrpgBoardDefaultChecked ??= new Set());

/**
 * New cards need a person's approval. On upstream Hermes that product default lives in the board's
 * default policy, which also covers cards made outside DeskRPG. A board without one gets human
 * approval; one already set (by a person or an earlier run) is left alone. Best effort: the board
 * works without it, and a failed attempt is retried on a later ensure.
 */
async function ensureBoardDefaultPolicy(
  client: OwnerPluginClient,
  gatewayId: string,
  boardSlug: string,
): Promise<void> {
  const key = `${gatewayId}|${boardSlug}`;
  if (defaultPolicyChecked.has(key)) return;
  const current = await client.kanban.getBoardDefaultPolicy(boardSlug);
  if (!current.ok) {
    console.warn(
      `[kanban-boards] could not read board ${boardSlug} default policy: ${current.failure.code}`,
    );
    return;
  }
  if (current.data.default === null) {
    const set = await client.kanban.setBoardDefaultPolicy(boardSlug, {
      mode: "human",
      reviewer_profile: null,
    });
    if (!set.ok) {
      console.warn(
        `[kanban-boards] could not default board ${boardSlug} to human approval: ${set.failure.code}`,
      );
      return;
    }
  }
  defaultPolicyChecked.add(key);
}

async function ensureChannelBoardUnlocked(
  channelId: string,
  resolved?: ResolvedChannelBoard,
  /**
   * The board to ensure. If omitted, this is the channel's default board slug (= the event
   * carrier board). When re-ensuring an already-attached board, its name is not overwritten
   * with the channel name, since Hermes already holds that board's name — the plugin's
   * `POST /kanban/boards` returns the existing board, name included, for the same slug.
   */
  requestedSlug?: string,
): Promise<ChannelBoardResult> {
  try {
    if (resolved?.ok) {
      const binding = await getChannelGatewayBinding(channelId);
      if (binding?.resource.id !== resolved.binding.resource.id) resolved = undefined;
    }
    resolved ??= await resolveChannelBoard(channelId);
    if (!resolved.ok) return { ok: false, code: resolved.code, reason: resolved.reason, row: null };

    const name = await readChannelName(channelId);
    if (name === null) {
      return { ok: false, code: "channel_not_found", reason: "channel not found", row: null };
    }

    const gatewayId = resolved.binding.resource.id;
    const boardSlug = requestedSlug ?? resolved.boardSlug;

    if (!resolved.pluginGate.ok) {
      const row = await upsertBoardRow({
        channelId,
        gatewayId,
        boardSlug,
        lastError: resolved.pluginGate.code,
      });
      return { ok: false, code: resolved.pluginGate.code, reason: resolved.pluginGate.reason, row };
    }

    const created = await resolved.ownerClient.kanban.createBoard({ slug: boardSlug, name });
    if (!created.ok) {
      const row = await upsertBoardRow({
        channelId,
        gatewayId,
        boardSlug,
        lastError: created.failure.code,
      });
      return {
        ok: false,
        code: created.failure.code,
        reason: created.failure.message || created.failure.code,
        row,
      };
    }

    if (supportsReviewHooks(resolved.pluginGate.info))
      await ensureBoardDefaultPolicy(resolved.ownerClient, gatewayId, boardSlug);

    const row = await upsertBoardRow({
      channelId,
      gatewayId,
      boardSlug,
      lastError: null,
      boardNameSyncedAt: nowForDb(),
    });
    return { ok: true, board: created.data.board, row };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[kanban-boards] ensureChannelBoard(${channelId}) failed: ${reason}`);
    return {
      ok: false,
      code: err instanceof EventCarrierError ? err.code : "internal_error",
      reason,
      row: null,
    };
  }
}

/**
 * Reflects a channel name change into the board's display name (R2). Never throws on
 * failure and leaves `board_name_synced_at` untouched — the poller compares that timestamp
 * against the channel's `updated_at`, and calls this again once per cycle if it's behind
 * (only on cycles that pass the gate).
 */
export async function syncBoardName(
  ...args: Parameters<typeof syncBoardNameUnlocked>
): Promise<ChannelBoardResult> {
  return withChannelAutomationLock(args[0], async () => {
    try {
      await recoverEventCarrierHandoff(args[0]);
      return await syncBoardNameUnlocked(...args);
    } catch (err) {
      const code = err instanceof EventCarrierError ? err.code : "internal_error";
      return { ok: false, code, reason: code, row: null };
    }
  });
}

async function syncBoardNameUnlocked(
  channelId: string,
  name: string,
  resolved?: ResolvedChannelBoard,
): Promise<ChannelBoardResult> {
  try {
    const existing = await getChannelBoard(channelId);
    if (!existing) {
      return { ok: false, code: "no_board", reason: "channel has no board row", row: null };
    }

    if (resolved?.ok) {
      const binding = await getChannelGatewayBinding(channelId);
      if (binding?.resource.id !== resolved.binding.resource.id) resolved = undefined;
    }
    resolved ??= await resolveChannelBoard(channelId);
    if (!resolved.ok)
      return { ok: false, code: resolved.code, reason: resolved.reason, row: existing };

    const gatewayId = resolved.binding.resource.id;
    if (!resolved.pluginGate.ok) {
      const row = await upsertBoardRow({
        channelId,
        gatewayId,
        boardSlug: existing.boardSlug,
        lastError: resolved.pluginGate.code,
      });
      return { ok: false, code: resolved.pluginGate.code, reason: resolved.pluginGate.reason, row };
    }

    const updated = await resolved.ownerClient.kanban.updateBoard(existing.boardSlug, { name });
    if (!updated.ok) {
      const row = await upsertBoardRow({
        channelId,
        gatewayId,
        boardSlug: existing.boardSlug,
        lastError: updated.failure.code,
      });
      return {
        ok: false,
        code: updated.failure.code,
        reason: updated.failure.message || updated.failure.code,
        row,
      };
    }

    const row = await upsertBoardRow({
      channelId,
      gatewayId,
      boardSlug: existing.boardSlug,
      lastError: null,
      boardNameSyncedAt: nowForDb(),
    });
    return { ok: true, board: updated.data.board, row };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[kanban-boards] syncBoardName(${channelId}) failed: ${reason}`);
    return {
      ok: false,
      code: err instanceof EventCarrierError ? err.code : "internal_error",
      reason,
      row: null,
    };
  }
}
