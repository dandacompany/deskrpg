/**
 * Gatekeeper for the cron REST API (`/api/channels/:id/cron/**`).
 *
 * The order is itself the rule: login → channel member → channel's gateway → plugin
 * contract (428/404/401/503/504) → the assigned NPC's profile client. If an earlier step
 * blocks, later steps (especially the Hermes call) never happen — if a permission denial
 * came after a remote round trip, even the rejected request would leave a trace in Hermes.
 *
 * The browser never calls Hermes directly. Profile tokens are decrypted here and kept
 * inside the client — never put in the response.
 *
 * This is a **separate file** from the kanban side's access control (`kanban-access.ts`) —
 * the two differ in scope (owner key vs. profile key) and permission unit (board vs.
 * origin channel), and merging them would contaminate each other's rules.
 */

import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import {
  forceReprobePluginInfo,
  gateAutomationPlugin,
  type PluginGate as AutomationGate,
} from "@/lib/automation-gate";
import { channelMembers, channels, db, gatewayResources, hermesProfiles, npcs } from "@/db";
import { GATE_ERROR_STATUS, type GateErrorCode } from "@/lib/gate-error-status";
import { decryptGatewayToken, getChannelGatewayBinding } from "@/lib/gateway-resources";
import type { PluginInfo } from "@/lib/hermes/deskrpg-plugin-types";
import { createProfilePluginClient } from "@/lib/hermes/plugin-client";
import type { PluginResponse, ProfilePluginClient } from "@/lib/hermes/plugin-client-types";

type GatewayResourceRow = typeof gatewayResources.$inferSelect;
type HermesProfileRow = typeof hermesProfiles.$inferSelect;
type NpcRow = typeof npcs.$inferSelect;

export type CronErrorBody = { code: string; message: string } & Record<string, unknown>;

export function cronError(status: number, code: string, message: string, extra?: object) {
  return NextResponse.json({ code, message, ...(extra ?? {}) } satisfies CronErrorBody, {
    status,
  });
}

/** A gate failure — its status comes from `GATE_ERROR_STATUS`, never a literal at the call site. */
export function gateError(code: GateErrorCode, message: string, extra?: object) {
  return cronError(GATE_ERROR_STATUS[code], code, message, extra);
}

// ---------------------------------------------------------------------------
// Channel membership
// ---------------------------------------------------------------------------

export type ChannelAccess =
  { ok: true; channel: { id: string; ownerId: string } } | { ok: false; response: NextResponse };

/** The minimum requirement to view/create — must be the channel owner or in `channel_members`. */
export async function requireChannelMember(
  channelId: string,
  userId: string,
): Promise<ChannelAccess> {
  const [channel] = await db
    .select({ id: channels.id, ownerId: channels.ownerId })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);
  if (!channel) {
    return { ok: false, response: cronError(404, "channel_not_found", "Channel not found") };
  }
  if (channel.ownerId === userId) return { ok: true, channel };

  const [member] = await db
    .select({ id: channelMembers.id })
    .from(channelMembers)
    .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)))
    .limit(1);
  if (!member) {
    return { ok: false, response: cronError(403, "not_a_member", "Not a member") };
  }
  return { ok: true, channel };
}

// ---------------------------------------------------------------------------
// Plugin contract gate (E10)
// ---------------------------------------------------------------------------

export type PluginGate = { ok: true; info: PluginInfo } | { ok: false; response: NextResponse };

/**
 * Turns a gate failure into an HTTP response. Each diagnosis calls for different user
 * action, so the codes are kept distinct rather than lumped together:
 * - 428 `plugin_upgrade_required` `{minVersion, reason, missing?}` — upgrade the plugin
 * - 404 `plugin_absent` — install the plugin on the gateway machine
 * - 401 `plugin_unauthorized` — rotate the key on the gateway record
 * - 503 `unreachable` / 504 `timeout` — check the gateway address/status (a data-call failure via `pluginFailureResponse` uses the same status/code)
 * - 503 `plugin_unknown` — reachable, but the response isn't from our plugin
 */
export function pluginGateResponse(gate: Extract<AutomationGate, { ok: false }>): NextResponse {
  switch (gate.code) {
    case "plugin_upgrade_required": {
      const verdict = gate.verdict;
      return gateError(
        "plugin_upgrade_required",
        `deskrpg-hermes-plugin ${verdict?.minVersion ?? ""}+ required (${verdict?.reason ?? gate.reason})`,
        {
          ...(verdict ? { minVersion: verdict.minVersion, reason: verdict.reason } : {}),
          ...(verdict?.missing ? { missing: verdict.missing } : {}),
        },
      );
    }
    case "plugin_absent":
      return gateError("plugin_absent", "deskrpg-hermes-plugin is not installed on this gateway");
    case "plugin_unauthorized":
      return gateError("plugin_unauthorized", "gateway token was rejected by the plugin");
    case "plugin_unknown":
      if (gate.transport === "timeout") {
        return gateError("timeout", "gateway did not answer the plugin probe in time");
      }
      if (gate.transport === "unreachable") {
        return gateError("unreachable", "gateway could not be reached for the plugin probe");
      }
      return gateError("plugin_unknown", gate.reason);
  }
}

/**
 * Checks whether the automation contract is met (version >= 0.6.0 + three capabilities).
 * The judgment itself is made by the single gate in `automation-gate.ts` (cached for 1
 * hour; `unknown` or a `plugin_ready` with no info triggers a re-probe) — this just
 * translates that result into HTTP via `pluginGateResponse`.
 *
 * `timezone` is read from the `info` returned here (E9 — null if the plugin doesn't provide it).
 */
export async function ensureAutomationPlugin(
  gateway: GatewayResourceRow,
  now = new Date(),
): Promise<PluginGate> {
  const gate = await gateAutomationPlugin(
    gateway,
    decryptGatewayToken(gateway.tokenEncrypted),
    now,
  );
  if (gate.ok) return { ok: true, info: gate.info };
  return { ok: false, response: pluginGateResponse(gate) };
}

// ---------------------------------------------------------------------------
// Channel context — member + gateway + plugin gate, all in one
// ---------------------------------------------------------------------------

export type CronChannelContext = {
  userId: string;
  channelId: string;
  gateway: GatewayResourceRow;
  info: PluginInfo;
  /** E9. null if the plugin doesn't provide a timezone — the label ("unknown") is the client's job. */
  timezone: string | null;
};

export type CronContextResult =
  { ok: true; ctx: CronChannelContext } | { ok: false; response: NextResponse };

export async function resolveCronChannelContext(input: {
  userId: string | null;
  channelId: string;
}): Promise<CronContextResult> {
  if (!input.userId) {
    return { ok: false, response: cronError(401, "unauthorized", "unauthorized") };
  }
  const access = await requireChannelMember(input.channelId, input.userId);
  if (!access.ok) return access;

  const binding = await getChannelGatewayBinding(input.channelId);
  if (!binding) {
    return {
      ok: false,
      response: gateError("gateway_not_bound", "Channel has no gateway bound"),
    };
  }

  const gate = await ensureAutomationPlugin(binding.resource);
  if (!gate.ok) return gate;

  return {
    ok: true,
    ctx: {
      userId: input.userId,
      channelId: input.channelId,
      gateway: binding.resource,
      info: gate.info,
      timezone: gate.info.timezone ?? null,
    },
  };
}

/**
 * Whether the channel's plugin has `capability`. The context's info comes from the 1-hour
 * cache, so when it lacks the capability the plugin is re-probed once (throttled per gateway)
 * before the caller answers 428 — a gateway upgraded after its last probe is recognized at once.
 */
export async function hasPluginCapability(
  ctx: Pick<CronChannelContext, "gateway" | "info">,
  capability: string,
): Promise<boolean> {
  if (ctx.info.capabilities.includes(capability)) return true;
  const fresh = await forceReprobePluginInfo(
    ctx.gateway,
    decryptGatewayToken(ctx.gateway.tokenEncrypted),
  );
  return fresh?.capabilities.includes(capability) ?? false;
}

// ---------------------------------------------------------------------------
// NPC → profile → profile-key client
// ---------------------------------------------------------------------------

export type NpcProfileClient = {
  npc: NpcRow;
  profile: HermesProfileRow;
  /** `hermes_profiles.display_name ?? profile_name` — `npcs.name` is never read. */
  npcName: string;
  client: ProfilePluginClient;
};

export type NpcProfileClientResult =
  { ok: true; value: NpcProfileClient } | { ok: false; response: NextResponse };

function displayNameOf(profile: HermesProfileRow): string {
  return profile.displayName?.trim() || profile.profileName;
}

function buildClient(gateway: GatewayResourceRow, profile: HermesProfileRow): ProfilePluginClient {
  return createProfilePluginClient({
    baseUrl: gateway.baseUrl,
    profileName: profile.profileName,
    profileToken: decryptGatewayToken(profile.tokenEncrypted),
  });
}

/**
 * Resolves `npcId` to this channel's **active** NPC row, confirms its profile belongs to
 * the channel's current gateway, and only then builds the profile-key client. An NPC from
 * another channel, a dormant NPC, or an NPC on an old gateway all get 404
 * `npc_not_found` — existence is never leaked outside the channel.
 */
export async function resolveNpcProfileClient(
  ctx: Pick<CronChannelContext, "channelId" | "gateway">,
  npcId: string,
): Promise<NpcProfileClientResult> {
  const [row] = await db
    .select({ npc: npcs, profile: hermesProfiles })
    .from(npcs)
    .innerJoin(hermesProfiles, eq(hermesProfiles.id, npcs.hermesProfileId))
    .where(and(eq(npcs.id, npcId), eq(npcs.channelId, ctx.channelId), eq(npcs.active, true)))
    .limit(1);
  if (!row || row.profile.gatewayId !== ctx.gateway.id) {
    return {
      ok: false,
      response: cronError(404, "npc_not_found", "NPC not found in this channel"),
    };
  }
  return {
    ok: true,
    value: {
      npc: row.npc,
      profile: row.profile,
      npcName: displayNameOf(row.profile),
      client: buildClient(ctx.gateway, row.profile),
    },
  };
}

/** All active NPCs of the channel (profiles on the current gateway only) — for the union list (R15). */
export async function listNpcProfileClients(
  ctx: Pick<CronChannelContext, "channelId" | "gateway">,
): Promise<NpcProfileClient[]> {
  const rows = await db
    .select({ npc: npcs, profile: hermesProfiles })
    .from(npcs)
    .innerJoin(hermesProfiles, eq(hermesProfiles.id, npcs.hermesProfileId))
    .where(
      and(
        eq(npcs.channelId, ctx.channelId),
        eq(npcs.active, true),
        eq(hermesProfiles.gatewayId, ctx.gateway.id),
      ),
    );
  return rows.map((row) => ({
    npc: row.npc,
    profile: row.profile,
    npcName: displayNameOf(row.profile),
    client: buildClient(ctx.gateway, row.profile),
  }));
}

// ---------------------------------------------------------------------------
// Forward Hermes errors as-is (R32)
// ---------------------------------------------------------------------------

/**
 * Turns a plugin failure into an HTTP response. The status code is passed through exactly
 * as Hermes gave it; the body is `{code, message}`. There's no local substitute. Only a
 * failure at the client layer (status 0) gets its code decided by us — 503 if unreachable,
 * 504 if it timed out waiting (same value as a gate-judgment failure).
 */
export function pluginFailureResponse(res: Extract<PluginResponse<unknown>, { ok: false }>) {
  const status = res.status > 0 ? res.status : res.failure.code === "timeout" ? 504 : 503;
  return cronError(status, res.failure.code, res.failure.message, res.failure.details);
}

/** A failure-list entry (when one profile fails within the union list). */
export function pluginFailureSummary(res: Extract<PluginResponse<unknown>, { ok: false }>) {
  return { code: res.failure.code, message: res.failure.message };
}
