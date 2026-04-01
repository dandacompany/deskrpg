import { NextRequest, NextResponse } from "next/server";
import { db, isPostgres, jsonForDb } from "@/db";
import { npcs, channels } from "@/db";
import { eq } from "drizzle-orm";
import { internalRpc, getUserId } from "@/lib/internal-rpc";
import { injectTaskPrompt } from "@/lib/task-prompt";
import {
  buildGatewayAgentFiles,
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
    return { errorCode: "only_channel_owner_can_modify_npcs", error: "Only channel owner can modify NPCs", status: 403 };
  }

  return { npc, channel, userId };
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const result = await verifyNpcOwnership(req, id);
    if ("error" in result) {
      return NextResponse.json({ errorCode: result.errorCode, error: result.error }, { status: result.status });
    }

    const { npc } = result;
    const body = await req.json();
    const updates: Record<string, unknown> = { updatedAt: (isPostgres ? new Date() : new Date().toISOString()) as unknown as Date };
    const nextName = body.name?.trim() || npc.name;
    const normalizedLocale = normalizeLocale(body.locale);

    if (body.name?.trim()) updates.name = body.name.trim().slice(0, 100);
    if (body.appearance) updates.appearance = jsonForDb(body.appearance);
    if (typeof body.direction === "string") {
      updates.direction = ["up", "down", "left", "right"].includes(body.direction) ? body.direction : "down";
    }
    if (body.presetId && !hasNpcPresetDefaults(body.presetId)) {
      return NextResponse.json({ errorCode: "unknown_preset_id", error: `Unknown presetId: ${body.presetId}` }, { status: 400 });
    }

    // Handle persona/identity/soul updates
    const existingConfig = parseDbObject(npc.openclawConfig) || {};
    const existingAgentId = existingConfig.agentId as string | null;
    const presetDefaults = hasNpcPresetDefaults(body.presetId)
      ? getNpcPresetDefaults({ presetId: body.presetId, npcName: nextName, locale: normalizedLocale })
      : null;
    const resolvedIdentity = body.identity?.trim() ?? body.persona?.trim() ?? presetDefaults?.identity ?? "";
    const resolvedSoul = body.soul?.trim() ?? presetDefaults?.soul ?? "";

    // Handle agent connection change
    if (body.agentAction === "select" && body.agentId) {
      updates.openclawConfig = {
        ...existingConfig,
        agentId: body.agentId,
        sessionKeyPrefix: `ot-${id.slice(0, 8)}-${body.agentId}`,
      };
    } else if (body.agentAction === "create" && body.agentId) {
      // Create agent via RPC
      await internalRpc(npc.channelId, "agents.create", {
        name: body.agentId,
        workspace: `~/.openclaw/workspace-${body.agentId}`,
      });

      const files = hasNpcPresetDefaults(body.presetId)
        ? buildGatewayAgentFiles({
            presetId: body.presetId,
            npcName: nextName,
            locale: normalizedLocale,
            identityOverride: body.identity?.trim(),
            soulOverride: body.soul?.trim(),
            fallbackPersona: body.persona?.trim(),
          })
        : [
            ...(body.identity?.trim() ? [{
              name: "IDENTITY.md" as const,
              content: injectTaskPrompt(localizeNpcPromptDocument(body.identity.trim(), normalizedLocale, "identity"), normalizedLocale),
            }] : []),
            ...(body.soul?.trim() ? [{
              name: "SOUL.md" as const,
              content: localizeNpcPromptDocument(body.soul.trim(), normalizedLocale, "soul"),
            }] : []),
            {
              name: "AGENTS.md" as const,
              content: getDefaultMeetingProtocol(normalizedLocale),
            },
          ];

      for (const file of files) {
        await internalRpc(npc.channelId, "agents.files.set", {
          agentId: body.agentId,
          name: file.name,
          content: file.content,
        });
      }

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
            identity: injectTaskPrompt(localizeNpcPromptDocument(body.identity?.trim() || "", normalizedLocale, "identity"), normalizedLocale),
            soul: localizeNpcPromptDocument(body.soul?.trim() || "", normalizedLocale, "soul"),
          };

      updates.openclawConfig = {
        ...existingConfig,
        agentId: body.agentId,
        sessionKeyPrefix: `ot-${id.slice(0, 8)}-${body.agentId}`,
        personaConfig,
        locale: normalizedLocale,
      };
    }

    if (body.passPolicy !== undefined) {
      const currentConfig = (updates.openclawConfig as Record<string, unknown>) || existingConfig;
      updates.openclawConfig = {
        ...currentConfig,
        passPolicy: body.passPolicy?.trim() || null,
        locale: normalizedLocale,
      };

      // Also write to IDENTITY.md if agent exists
      if (existingAgentId && body.passPolicy?.trim()) {
        try {
          let identityContent = "";
          try {
            const currentIdentity = await internalRpc(npc.channelId, "agents.files.get", {
              agentId: existingAgentId, name: "IDENTITY.md",
            });
            identityContent = (currentIdentity as { content?: string })?.content || "";
          } catch { /* file may not exist yet */ }

          const sectionHeader = "## 회의 행동 가이드";
          const newSection = `${sectionHeader}\n${body.passPolicy.trim()}`;
          const updated = identityContent.includes(sectionHeader)
            ? identityContent.replace(/## 회의 행동 가이드[\s\S]*?(?=\n## |$)/, newSection)
            : identityContent + "\n\n" + newSection;

          await internalRpc(npc.channelId, "agents.files.set", {
            agentId: existingAgentId, name: "IDENTITY.md", content: updated,
          });
        } catch (err) {
          console.warn("Failed to update IDENTITY.md with pass policy:", err);
        }
      }
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
            identity: injectTaskPrompt(localizeNpcPromptDocument(newIdentity, normalizedLocale, "identity"), normalizedLocale),
            soul: localizeNpcPromptDocument(newSoul, normalizedLocale, "soul"),
          };

      // If NPC has an agent and identity/soul changed, update on gateway via RPC
      if (existingAgentId) {
        try {
          if (personaConfig.identity) {
            await internalRpc(npc.channelId, "agents.files.set", {
              agentId: existingAgentId,
              name: "IDENTITY.md",
              content: personaConfig.identity,
            });
          }
          if (personaConfig.soul) {
            await internalRpc(npc.channelId, "agents.files.set", {
              agentId: existingAgentId,
              name: "SOUL.md",
              content: personaConfig.soul,
            });
          }
          await internalRpc(npc.channelId, "agents.files.set", {
            agentId: existingAgentId,
            name: "AGENTS.md",
            content: hasNpcPresetDefaults(body.presetId)
              ? getNpcPresetDefaults({
                  presetId: body.presetId,
                  npcName: nextName,
                  locale: normalizedLocale,
                }).meetingProtocol
              : getDefaultMeetingProtocol(normalizedLocale),
          });
        } catch (err) {
          console.warn("Failed to update persona files on gateway:", err);
        }
      }

      // Update openclawConfig in DB
      updates.openclawConfig = {
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

    if (updates.openclawConfig !== undefined) {
      updates.openclawConfig = jsonForDb(updates.openclawConfig);
    }

    const [updated] = await db.update(npcs).set(updates).where(eq(npcs.id, id)).returning();
    return NextResponse.json({
      npc: {
        ...updated,
        appearance: parseDbJson(updated.appearance) ?? updated.appearance,
        openclawConfig: parseDbObject(updated.openclawConfig) ?? updated.openclawConfig,
      },
    });
  } catch (err) {
    console.error("Failed to update NPC:", err);
    return NextResponse.json({ errorCode: "failed_to_update_npc", error: "Failed to update NPC" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const result = await verifyNpcOwnership(req, id);
    if ("error" in result) {
      return NextResponse.json({ errorCode: result.errorCode, error: result.error }, { status: result.status });
    }

    const { npc } = result;

    // If NPC has an agent, remove it from the gateway via RPC
    const openclawConfig = parseDbObject(npc.openclawConfig);
    const agentId = openclawConfig?.agentId as string | null;

    if (agentId) {
      try {
        await internalRpc(npc.channelId, "agents.delete", { agentId, deleteFiles: true });
      } catch (err) {
        console.warn(`Failed to remove agent ${agentId} from gateway (proceeding with NPC deletion):`, err);
      }
    }

    await db.delete(npcs).where(eq(npcs.id, id));
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Failed to delete NPC:", err);
    return NextResponse.json({ errorCode: "failed_to_delete_npc", error: "Failed to delete NPC" }, { status: 500 });
  }
}
