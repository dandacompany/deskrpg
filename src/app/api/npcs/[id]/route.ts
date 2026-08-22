import { NextRequest, NextResponse } from "next/server";
import { db, isPostgres, jsonForDb } from "@/db";
import { npcs, channels } from "@/db";
import { eq } from "drizzle-orm";
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
import { parseDbJson, parseDbObject } from "@/lib/db-json";

async function verifyNpcOwnership(req: NextRequest, npcId: string) {
  const userId = getUserId(req);
  if (!userId) return { errorCode: "unauthorized", error: "Unauthorized", status: 401 };

  const [npc] = await db.select().from(npcs).where(eq(npcs.id, npcId));
  if (!npc) return { errorCode: "npc_not_found", error: "NPC not found", status: 404 };

  const [channel] = await db.select().from(channels).where(eq(channels.id, npc.channelId));
  if (!channel || channel.ownerId !== userId) {
    return {
      errorCode: "only_channel_owner_can_modify_npcs",
      error: "Only channel owner can modify NPCs",
      status: 403,
    };
  }

  return { npc, channel, userId };
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const result = await verifyNpcOwnership(req, id);
    if ("error" in result) {
      return NextResponse.json(
        { errorCode: result.errorCode, error: result.error },
        { status: result.status },
      );
    }

    const { npc } = result;
    const body = await req.json();
    const updates: Record<string, unknown> = {
      updatedAt: (isPostgres ? new Date() : new Date().toISOString()) as unknown as Date,
    };
    const nextName = body.name?.trim() || npc.name;
    const normalizedLocale = normalizeLocale(body.locale);

    if (body.name?.trim()) updates.name = body.name.trim().slice(0, 100);
    if (body.appearance) updates.appearance = jsonForDb(body.appearance);
    if (typeof body.direction === "string") {
      updates.direction = ["up", "down", "left", "right"].includes(body.direction)
        ? body.direction
        : "down";
    }
    if (body.presetId && !hasNpcPresetDefaults(body.presetId)) {
      return NextResponse.json(
        {
          errorCode: "unknown_preset_id",
          error: `Unknown presetId: ${body.presetId}`,
        },
        { status: 400 },
      );
    }

    // Handle persona/identity/soul updates
    const existingConfig = parseDbObject(npc.agentConfig) || {};
    const existingAgentId = existingConfig.agentId as string | null;
    const presetDefaults = hasNpcPresetDefaults(body.presetId)
      ? getNpcPresetDefaults({
          presetId: body.presetId,
          npcName: nextName,
          locale: normalizedLocale,
        })
      : null;
    const resolvedIdentity =
      body.identity?.trim() ?? body.persona?.trim() ?? presetDefaults?.identity ?? "";
    const resolvedSoul = body.soul?.trim() ?? presetDefaults?.soul ?? "";

    // 예전에는 여기서 body.agentAction(select/create)을 받아 OpenClaw 게이트웨이에
    // 에이전트를 만들고 ~/.openclaw/workspace-<id> 에 페르소나 파일을 써 넣었다.
    // OpenClaw 가 사라지면서 그 개념 전체가 없어졌다 — Hermes 는 프로필이 이미 그
    // 자리에 있고 우리는 바인딩만 한다. 고용 모달도 agentAction 을 더는 보내지 않는다.

    if (body.passPolicy !== undefined) {
      const currentConfig = (updates.agentConfig as Record<string, unknown>) || existingConfig;
      updates.agentConfig = {
        ...currentConfig,
        passPolicy: body.passPolicy?.trim() || null,
        locale: normalizedLocale,
      };

      // passPolicy 는 DB(agent config)에만 남는다. 예전에는 게이트웨이의 IDENTITY.md
      // 에도 같은 내용을 써 넣었지만, 그 파일은 OpenClaw 워크스페이스의 것이었다.
    }

    if (
      body.identity !== undefined ||
      body.soul !== undefined ||
      body.persona !== undefined ||
      body.locale !== undefined ||
      body.presetId !== undefined
    ) {
      const newIdentity = resolvedIdentity;
      const newSoul = resolvedSoul;
      const personaConfig = hasNpcPresetDefaults(body.presetId)
        ? buildPersonaConfig({
            presetId: body.presetId,
            npcName: nextName,
            locale: normalizedLocale,
            identityOverride: body.identity?.trim(),
            soulOverride: body.soul?.trim(),
            fallbackPersona: body.persona?.trim(),
          })
        : {
            identity: injectTaskPrompt(
              localizeNpcPromptDocument(newIdentity, normalizedLocale, "identity"),
              normalizedLocale,
            ),
            soul: localizeNpcPromptDocument(newSoul, normalizedLocale, "soul"),
          };

      // 페르소나는 DB(agent config)에만 남는다. 예전에는 게이트웨이 워크스페이스의
      // IDENTITY.md / SOUL.md / AGENTS.md 에도 같은 내용을 써 넣었지만, 그 파일들은
      // OpenClaw 에이전트의 것이었다. Hermes 프로필은 자기 홈을 직접 들고 있다.

      // Update agentConfig in DB
      updates.agentConfig = {
        ...existingConfig,
        persona: newIdentity.slice(0, 500), // backward compat
        personaConfig,
        locale: normalizedLocale,
        meetingProtocol: hasNpcPresetDefaults(body.presetId)
          ? getNpcPresetDefaults({
              presetId: body.presetId,
              npcName: nextName,
              locale: normalizedLocale,
            }).meetingProtocol
          : getDefaultMeetingProtocol(normalizedLocale),
      };
    }

    if (updates.agentConfig !== undefined) {
      updates.agentConfig = jsonForDb(updates.agentConfig);
    }

    const [updated] = await db.update(npcs).set(updates).where(eq(npcs.id, id)).returning();
    return NextResponse.json({
      npc: {
        ...updated,
        appearance: parseDbJson(updated.appearance) ?? updated.appearance,
        agentConfig: parseDbObject(updated.agentConfig) ?? updated.agentConfig,
      },
    });
  } catch (err) {
    console.error("Failed to update NPC:", err);
    return NextResponse.json(
      { errorCode: "failed_to_update_npc", error: "Failed to update NPC" },
      { status: 500 },
    );
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const result = await verifyNpcOwnership(req, id);
    if ("error" in result) {
      return NextResponse.json(
        { errorCode: result.errorCode, error: result.error },
        { status: result.status },
      );
    }

    const { npc } = result;

    // 예전에는 NPC 를 지울 때 게이트웨이의 OpenClaw 에이전트도 함께 지웠다. Hermes
    // 프로필은 NPC 보다 오래 사는 자원이고 다른 NPC 가 다시 바인딩할 수 있으므로,
    // NPC 삭제가 프로필을 건드려서는 안 된다.
    await db.delete(npcs).where(eq(npcs.id, id));
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Failed to delete NPC:", err);
    return NextResponse.json(
      { errorCode: "failed_to_delete_npc", error: "Failed to delete NPC" },
      { status: 500 },
    );
  }
}
