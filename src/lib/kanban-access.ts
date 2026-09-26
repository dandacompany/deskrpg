/**
 * The gatekeeper for the Kanban REST surface (`/api/channels/:id/kanban/**`, `/automation/status`).
 *
 * Order is the rule: login → channel member → channel's gateway (409) → plugin contract
 * (428/404/401/503/504) → board acquisition (503). If an earlier stage is blocked, later
 * stages (especially Hermes calls) never happen. The gate uses exactly what
 * `resolveChannelBoard` resolves once, and carries that result's owner client in the context —
 * so a single request never builds the gate/client twice. Member and error responses are
 * **reused as-is** from `cron-access.ts` — keeping two copies of the gate means one of them
 * eventually drifts unfixed.
 *
 * Three things differ from cron.
 * - The scope is the **owner key**. Profile keys are not used here.
 * - The unit of permission is the board. Viewing/card operations require channel membership,
 *   the board's working folder requires the channel owner, and host orchestration settings
 *   require the channel owner to read, the gateway resource owner to modify.
 * - The assignee is received as `npcId` and translated to the `profile_name` of the NPC
 *   currently working in this channel before being sent on (R7).
 *
 * The browser never calls Hermes directly. The owner token is decrypted here, kept confined
 * to the client, and never included in the response.
 */

import { and, eq } from "drizzle-orm";
import type { NextResponse } from "next/server";

import { db, hermesProfiles, npcs, users } from "@/db";
import {
  cronError,
  gateError,
  pluginGateResponse,
  requireChannelMember,
  type CronChannelContext,
} from "@/lib/cron-access";
import type { OwnerPluginClient } from "@/lib/hermes/plugin-client-types";
import type { KanbanReviewPolicy } from "@/lib/hermes/deskrpg-plugin-types";
import {
  ensureChannelBoard,
  getChannelBoard,
  getChannelBoardBySlug,
  resolveChannelBoard,
  type ChannelBoardRow,
  type ResolvedChannelBoard,
} from "@/lib/kanban-boards";

/** The minimum plugin version for automation — the single source of truth is `plugin-capability.ts`. */
export { AUTOMATION_MIN_VERSION as AUTOMATION_MIN_PLUGIN_VERSION } from "@/lib/hermes/plugin-capability";

// ---------------------------------------------------------------------------
// Channel context — member + gateway + plugin gate + board
// ---------------------------------------------------------------------------

export type KanbanChannelContext = CronChannelContext & {
  channel: { id: string; ownerId: string };
  /** Whether the requester is the channel owner — the basis for reading the board's working folder/orchestration settings. */
  isChannelOwner: boolean;
  /** Whether the requester is the gateway resource owner — the basis for modifying orchestration settings. */
  isGatewayOwner: boolean;
  boardSlug: string;
  boardRow: ChannelBoardRow;
  client: OwnerPluginClient;
};

export type KanbanContextResult =
  { ok: true; ctx: KanbanChannelContext } | { ok: false; response: NextResponse };

/**
 * R5. If the board row is missing (acquisition failed at binding time), a `last_error` is
 * left on it, or the gateway changed, re-acquire it once. If that still fails, 503 — no
 * Kanban request means anything without a board.
 */
async function requireBoardRow(
  channelId: string,
  resolved: Extract<ResolvedChannelBoard, { ok: true }>,
  requestedSlug?: string,
): Promise<{ ok: true; row: ChannelBoardRow } | { ok: false; response: NextResponse }> {
  const gatewayId = resolved.binding.resource.id;

  // If a board was specified, first check **whether it's attached to this channel**. This is
  // the only gate that stops pulling in another channel's board by slug, and it comes before
  // acquisition (503) — we must never acquire someone else's board for the caller.
  if (requestedSlug !== undefined) {
    const row = await getChannelBoardBySlug(channelId, requestedSlug);
    if (!row) {
      return {
        ok: false,
        response: cronError(404, "board_not_bound", "board is not bound to this channel"),
      };
    }
    if (row.gatewayId === gatewayId && !row.lastError) return { ok: true, row };
    // The gateway changed, or the last acquisition failed — re-acquire just that board.
    const ensured = await ensureChannelBoard(channelId, resolved, requestedSlug);
    if (ensured.ok) return { ok: true, row: ensured.row };
    return { ok: false, response: cronError(503, ensured.code, ensured.reason || ensured.code) };
  }

  const existing = await getChannelBoard(channelId);
  if (existing && existing.gatewayId === gatewayId && !existing.lastError) {
    return { ok: true, row: existing };
  }
  const ensured = await ensureChannelBoard(channelId, resolved);
  if (ensured.ok) return { ok: true, row: ensured.row };
  return {
    ok: false,
    response: cronError(503, ensured.code, ensured.reason || ensured.code),
  };
}

/**
 * The read-only branch — uses only a connection row that **already exists**. If it's missing,
 * has a leftover `last_error`, or the gateway changed, this is a 503, and it neither creates
 * nor re-acquires a board.
 *
 * A periodic read the user didn't request, like badge polling, must not repeatedly attempt
 * to create a Hermes board.
 */
async function existingBoardRow(
  channelId: string,
  resolved: Extract<ResolvedChannelBoard, { ok: true }>,
): Promise<{ ok: true; row: ChannelBoardRow } | { ok: false; response: NextResponse }> {
  const gatewayId = resolved.binding.resource.id;
  const existing = await getChannelBoard(channelId);
  if (existing && existing.gatewayId === gatewayId && !existing.lastError) {
    return { ok: true, row: existing };
  }
  return {
    ok: false,
    response: cronError(503, "board_unavailable", "Channel board is not ready"),
  };
}

export async function resolveKanbanChannelContext(input: {
  userId: string | null;
  channelId: string;
  /**
   * The board named by `?board=`. If omitted, uses the channel's **event-receiving board**
   * (the only board before multi-board migration) — so old clients unaware of boards keep
   * the same meaning.
   */
  boardSlug?: string;
}): Promise<KanbanContextResult> {
  return resolveContext(input, requireBoardRow);
}

/**
 * A branch that runs through the gate (login, member, gateway, plugin) **identically** to the
 * main path, but never acquires a board. Used by side-read paths like badges — it removes
 * only the remote write side effect without weakening the permission check.
 */
export async function resolveKanbanChannelContextForRead(input: {
  userId: string | null;
  channelId: string;
}): Promise<KanbanContextResult> {
  return resolveContext(input, existingBoardRow);
}

async function resolveContext(
  input: { userId: string | null; channelId: string; boardSlug?: string },
  acquireBoard: (
    channelId: string,
    resolved: Extract<ResolvedChannelBoard, { ok: true }>,
    requestedSlug?: string,
  ) => Promise<{ ok: true; row: ChannelBoardRow } | { ok: false; response: NextResponse }>,
): Promise<KanbanContextResult> {
  if (!input.userId) {
    return { ok: false, response: cronError(401, "unauthorized", "unauthorized") };
  }
  const access = await requireChannelMember(input.channelId, input.userId);
  if (!access.ok) return access;

  const resolved = await resolveChannelBoard(input.channelId);
  if (!resolved.ok) {
    return {
      ok: false,
      response: gateError("gateway_not_bound", "Channel has no gateway bound"),
    };
  }
  if (!resolved.pluginGate.ok) {
    return { ok: false, response: pluginGateResponse(resolved.pluginGate) };
  }
  const info = resolved.pluginGate.info;

  const board = await acquireBoard(input.channelId, resolved, input.boardSlug);
  if (!board.ok) return board;

  const gateway = resolved.binding.resource;
  return {
    ok: true,
    ctx: {
      userId: input.userId,
      channelId: input.channelId,
      channel: access.channel,
      gateway,
      info,
      timezone: info.timezone ?? null,
      isChannelOwner: access.channel.ownerId === input.userId,
      isGatewayOwner: gateway.ownerUserId === input.userId,
      // The context's boardSlug belongs to the **acquired row** — resolved's is the default
      // board's slug, which differs for a request that came with `?board=`. If these diverge
      // here, the route ends up touching the wrong board.
      boardSlug: board.row.boardSlug,
      boardRow: board.row,
      client: resolved.ownerClient,
    },
  };
}

// ---------------------------------------------------------------------------
// Roster — assignee(profile_name) ↔ NPC mapping
// ---------------------------------------------------------------------------

export type RosterEntry = {
  npcId: string;
  /** `hermes_profiles.display_name ?? profile_name` — `npcs.name` is never read. */
  npcName: string;
  profileName: string;
  active: boolean;
};

/**
 * Every NPC in this channel (profiles of the current gateway only). Sleeping NPCs are also
 * included, with `active:false` — cards created externally or belonging to a sleeping NPC
 * still need a name attached to them (the back half of R7).
 */
export async function loadChannelRoster(
  ctx: Pick<KanbanChannelContext, "channelId" | "gateway">,
): Promise<RosterEntry[]> {
  const rows = await db
    .select({
      npcId: npcs.id,
      active: npcs.active,
      profileName: hermesProfiles.profileName,
      displayName: hermesProfiles.displayName,
      createdAt: npcs.createdAt,
    })
    .from(npcs)
    .innerJoin(hermesProfiles, eq(hermesProfiles.id, npcs.hermesProfileId))
    .where(and(eq(npcs.channelId, ctx.channelId), eq(hermesProfiles.gatewayId, ctx.gateway.id)))
    .orderBy(npcs.createdAt, npcs.id);
  return rows.map((row) => ({
    npcId: row.npcId,
    npcName: row.displayName?.trim() || row.profileName,
    profileName: row.profileName,
    active: Boolean(row.active),
  }));
}

// ---------------------------------------------------------------------------
// Assignee validation (R7)
// ---------------------------------------------------------------------------

export type AssigneeResult =
  { ok: true; profileName: string; npcId: string } | { ok: false; response: NextResponse };

/**
 * `npcId` → an NPC currently **working (active)** in this channel → the current gateway's
 * profile name. A sleeping NPC, an NPC from another channel, an NPC from an old gateway, or
 * a nonexistent id all become 400 `assignee_not_in_channel`.
 */
export async function resolveAssignee(
  ctx: Pick<KanbanChannelContext, "channelId" | "gateway">,
  npcId: string,
): Promise<AssigneeResult> {
  const [row] = await db
    .select({ npcId: npcs.id, profileName: hermesProfiles.profileName })
    .from(npcs)
    .innerJoin(hermesProfiles, eq(hermesProfiles.id, npcs.hermesProfileId))
    .where(
      and(
        eq(npcs.id, npcId),
        eq(npcs.channelId, ctx.channelId),
        eq(npcs.active, true),
        eq(hermesProfiles.gatewayId, ctx.gateway.id),
      ),
    )
    .limit(1);
  if (!row) {
    return {
      ok: false,
      response: cronError(
        400,
        "assignee_not_in_channel",
        "Assignee must be an NPC currently working in this channel",
      ),
    };
  }
  return { ok: true, profileName: row.profileName, npcId: row.npcId };
}

// ---------------------------------------------------------------------------
// Comment author (R11)
// ---------------------------------------------------------------------------

/** The author recorded on Hermes — `deskrpg:<nickname>`. Falls back to the user id if no nickname is found. */
export async function commentAuthorFor(userId: string): Promise<string> {
  const [row] = await db
    .select({ nickname: users.nickname })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return `deskrpg:${row?.nickname?.trim() || userId}`;
}

// ---------------------------------------------------------------------------
// Attachment support (R12)
// ---------------------------------------------------------------------------

export function attachmentsUnsupportedResponse(): NextResponse {
  return cronError(404, "attachments_unsupported", "This plugin does not support attachments");
}

export function supportsAttachments(ctx: Pick<KanbanChannelContext, "info">): boolean {
  return ctx.info.kanban.attachments !== false;
}

/**
 * The completion policy new work gets when nobody chose one: human approval — but only on a gateway
 * that enforces policies. Upstream Hermes has no such contract, so there the card is created without
 * one (Hermes' own behaviour) and the board says it completes without approval (decision 0017).
 */
export function defaultReviewPolicy(
  ctx: Pick<KanbanChannelContext, "info">,
): KanbanReviewPolicy | undefined {
  return ctx.info?.capabilities.includes("kanban_review_policy_v1")
    ? { version: 1, mode: "human", reviewer_profile: null }
    : undefined;
}
