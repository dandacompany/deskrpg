import { NextRequest, NextResponse } from "next/server";
import { db, jsonForDb } from "@/db";
import { npcs, channels } from "@/db";
import { eq, count } from "drizzle-orm";
import { getUserId } from "@/lib/internal-rpc";
import { injectTaskPrompt } from "@/lib/task-prompt";
import {
  buildPersonaConfig,
  getDefaultMeetingProtocol,
  getNpcPresetDefaults,
  hasNpcPresetDefaults,
  localizeNpcPromptDocument,
} from "@/lib/npc-agent-defaults";
import { normalizeLocale } from "@/lib/i18n/server";
import { getGatewayRuntimeStateForChannel } from "@/lib/gateway-resources";
import { parseDbJson, parseDbObject } from "@/lib/db-json";

export async function GET(req: NextRequest) {
  try {
    const channelId = req.nextUrl.searchParams.get("channelId");
    let rows;
    if (channelId) {
      const gatewayState = await getGatewayRuntimeStateForChannel(channelId, { forceRefresh: true });
      if (gatewayState.status !== "valid") {
        return NextResponse.json({ npcs: [] });
      }
      rows = await db.select().from(npcs).where(eq(npcs.channelId, channelId));
    } else {
      rows = await db.select().from(npcs);
    }
    const result = rows.map((npc) => {
      const openclawConfig = parseDbObject(npc.openclawConfig);
      const appearance = parseDbJson<unknown>(npc.appearance) ?? npc.appearance;

      return {
      id: npc.id,
      name: npc.name,
      positionX: npc.positionX,
      positionY: npc.positionY,
      direction: npc.direction,
      appearance,
      hasAgent: !!openclawConfig?.agentId,
      agentId: (openclawConfig?.agentId as string) || null,
    };
    });
    return NextResponse.json({ npcs: result });
  } catch (err) {
    console.error("Failed to fetch NPCs:", err);
    return NextResponse.json({ errorCode: "failed_to_fetch_npcs", error: "Failed to fetch NPCs" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const userId = getUserId(req);
    if (!userId) return NextResponse.json({ errorCode: "unauthorized", error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    const {
      channelId, name, persona, appearance, positionX, positionY, direction,
      agentId, agentAction, identity, soul, presetId, locale,
    } = body;
    const normalizedLocale = normalizeLocale(locale);

    if (!channelId || !name?.trim() || !appearance || positionX == null || positionY == null) {
      return NextResponse.json({ errorCode: "missing_required_fields", error: "Missing required fields" }, { status: 400 });
    }

    if (presetId && !hasNpcPresetDefaults(presetId)) {
      return NextResponse.json({ errorCode: "unknown_preset_id", error: `Unknown presetId: ${presetId}` }, { status: 400 });
    }

    // At least persona or identity must be provided (unless selecting existing agent)
    if (!persona?.trim() && !identity?.trim() && !presetId && agentAction !== "select") {
      return NextResponse.json({ errorCode: "missing_persona_or_identity", error: "Missing persona or identity" }, { status: 400 });
    }

    // Verify channel ownership
    const [channel] = await db.select().from(channels).where(eq(channels.id, channelId));
    if (!channel) return NextResponse.json({ errorCode: "channel_not_found", error: "Channel not found" }, { status: 404 });
    if (channel.ownerId !== userId) return NextResponse.json({ errorCode: "only_channel_owner_can_hire_npcs", error: "Only channel owner can hire NPCs" }, { status: 403 });

    // Check NPC count limit (max 10)
    const [{ value: npcCount }] = await db.select({ value: count() }).from(npcs).where(eq(npcs.channelId, channelId));
    if (npcCount >= 10) {
      return NextResponse.json({ errorCode: "max_npcs_per_channel", error: "Maximum 10 NPCs per channel" }, { status: 400 });
    }

    // Build openclawConfig based on agent action
    let openclawConfig: Record<string, unknown>;
    const presetDefaults = hasNpcPresetDefaults(presetId)
      ? getNpcPresetDefaults({ presetId, npcName: name.trim(), locale: normalizedLocale })
      : null;
    const resolvedIdentity = identity?.trim() || persona?.trim() || presetDefaults?.identity || "";
    const resolvedSoul = soul?.trim() || presetDefaults?.soul || "";

    if (agentAction === "create" && agentId) {
      const personaConfig = hasNpcPresetDefaults(presetId)
        ? buildPersonaConfig({
            presetId,
            npcName: name.trim(),
            locale: normalizedLocale,
            identityOverride: identity?.trim(),
            soulOverride: soul?.trim(),
            fallbackPersona: persona?.trim(),
          })
        : {
            identity: injectTaskPrompt(localizeNpcPromptDocument(resolvedIdentity, normalizedLocale, "identity"), normalizedLocale),
            soul: localizeNpcPromptDocument(resolvedSoul, normalizedLocale, "soul"),
          };
      // Agent was already created via /api/npcs/create-agent
      openclawConfig = {
        agentId,
        sessionKeyPrefix: `ot-${channelId.slice(0, 8)}-${agentId}`,
        personaConfig,
        locale: normalizedLocale,
      };
    } else if (agentAction === "select" && agentId) {
      // Select an existing agent on the gateway
      openclawConfig = {
        agentId,
        sessionKeyPrefix: `ot-${channelId.slice(0, 8)}-${agentId}`,
        locale: normalizedLocale,
      };
    } else {
      // No agent — backward compat: store persona in openclawConfig
      const identityText = resolvedIdentity;
      const personaConfig = identityText || resolvedSoul
        ? (
          hasNpcPresetDefaults(presetId)
            ? buildPersonaConfig({
                presetId,
                npcName: name.trim(),
                locale: normalizedLocale,
                identityOverride: identity?.trim(),
                soulOverride: soul?.trim(),
                fallbackPersona: persona?.trim(),
              })
            : {
                identity: injectTaskPrompt(localizeNpcPromptDocument(identityText, normalizedLocale, "identity"), normalizedLocale),
                soul: localizeNpcPromptDocument(resolvedSoul, normalizedLocale, "soul"),
              }
        )
        : null;
      openclawConfig = {
        agentId: null,
        sessionKeyPrefix: "",
        persona: identityText.slice(0, 500), // backward compat
        locale: normalizedLocale,
        meetingProtocol: getDefaultMeetingProtocol(normalizedLocale),
        ...(personaConfig ? { personaConfig } : {}),
      };
    }

    // Insert NPC
    const [npc] = await db.insert(npcs).values({
      channelId,
      name: name.trim().slice(0, 100),
      positionX,
      positionY,
      direction: ["up", "down", "left", "right"].includes(direction) ? direction : "down",
      appearance: jsonForDb(appearance),
      openclawConfig: jsonForDb(openclawConfig),
    }).returning();

    return NextResponse.json({
      npc: {
        ...npc,
        appearance: parseDbJson(npc.appearance) ?? npc.appearance,
        openclawConfig: parseDbObject(npc.openclawConfig) ?? npc.openclawConfig,
      },
    }, { status: 201 });
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23505") {
      return NextResponse.json({ errorCode: "tile_already_occupied", error: "This tile is already occupied" }, { status: 409 });
    }
    console.error("Failed to create NPC:", err);
    return NextResponse.json({ errorCode: "failed_to_create_npc", error: "Failed to create NPC" }, { status: 500 });
  }
}
