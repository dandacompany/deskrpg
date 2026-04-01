import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { channels } from "@/db";
import { eq } from "drizzle-orm";
import { internalRpc, getUserId } from "@/lib/internal-rpc";
import { injectTaskPrompt } from "@/lib/task-prompt";
import {
  buildGatewayAgentFiles,
  getDefaultMeetingProtocol,
  hasNpcPresetDefaults,
  localizeNpcPromptDocument,
} from "@/lib/npc-agent-defaults";
import { normalizeLocale } from "@/lib/i18n/server";

export async function POST(req: NextRequest) {
  try {
    const userId = getUserId(req);
    if (!userId) return NextResponse.json({ errorCode: "unauthorized", error: "Unauthorized" }, { status: 401 });

    const { channelId, agentId, identity, soul, presetId, npcName, locale } = await req.json();
    const normalizedLocale = normalizeLocale(locale);

    if (!channelId || !agentId?.trim()) {
      return NextResponse.json(
        { errorCode: "missing_channel_or_agent_id", error: "Missing channelId or agentId" },
        { status: 400 },
      );
    }

    const [channel] = await db.select().from(channels).where(eq(channels.id, channelId));
    if (!channel) {
      return NextResponse.json(
        { errorCode: "channel_not_found", error: "Channel not found" },
        { status: 404 },
      );
    }
    if (channel.ownerId !== userId) {
      return NextResponse.json({ errorCode: "forbidden", error: "Not authorized" }, { status: 403 });
    }

    if (presetId && !hasNpcPresetDefaults(presetId)) {
      return NextResponse.json(
        { errorCode: "unknown_preset_id", error: `Unknown presetId: ${presetId}` },
        { status: 400 },
      );
    }

    // Create agent via RPC
    await internalRpc(channelId, "agents.create", { name: agentId.trim(), workspace: `/workspace/${agentId.trim()}` });

    const files = hasNpcPresetDefaults(presetId)
      ? buildGatewayAgentFiles({
          presetId,
          npcName: npcName?.trim() || "NPC",
          locale: normalizedLocale,
          identityOverride: identity?.trim(),
          soulOverride: soul?.trim(),
        })
      : [
          ...(identity?.trim() ? [{
            name: "IDENTITY.md" as const,
            content: injectTaskPrompt(localizeNpcPromptDocument(identity.trim(), normalizedLocale, "identity"), normalizedLocale),
          }] : []),
          ...(soul?.trim() ? [{
            name: "SOUL.md" as const,
            content: localizeNpcPromptDocument(soul.trim(), normalizedLocale, "soul"),
          }] : []),
          {
            name: "AGENTS.md" as const,
            content: getDefaultMeetingProtocol(normalizedLocale),
          },
        ];

    for (const file of files) {
      await internalRpc(channelId, "agents.files.set", {
        agentId: agentId.trim(),
        name: file.name,
        content: file.content,
      });
    }

    return NextResponse.json({ success: true, agentId: agentId.trim(), files: files.map((file) => file.name) });
  } catch (err) {
    console.error("Failed to create agent:", err);
    const message = err instanceof Error ? err.message : "Failed to create agent";
    return NextResponse.json(
      { errorCode: "failed_to_create_agent", error: message },
      { status: 500 },
    );
  }
}
