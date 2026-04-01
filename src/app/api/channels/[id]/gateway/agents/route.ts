import { db } from "@/db";
import { channels, npcs } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { internalRpc, getUserId } from "@/lib/internal-rpc";
import { parseDbObject } from "@/lib/db-json";
import { buildGatewayErrorPayload, getGatewayErrorStatus } from "@/lib/openclaw-gateway.js";

function normalizeGatewayAgents(
  result: unknown,
): { id: string; name: string; workspace: string }[] {
  if (Array.isArray(result)) {
    return result as { id: string; name: string; workspace: string }[];
  }
  if (result && typeof result === "object" && Array.isArray((result as { agents?: unknown[] }).agents)) {
    return (result as { agents: { id: string; name: string; workspace: string }[] }).agents;
  }
  return [];
}

// GET /api/channels/:id/gateway/agents — owner-only, lists gateway agents with NPC usage info
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = getUserId(req);
  if (!userId) return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  const { id } = await params;

  const [channel] = await db
    .select({ ownerId: channels.ownerId, gatewayConfig: channels.gatewayConfig })
    .from(channels)
    .where(eq(channels.id, id))
    .limit(1);

  if (!channel) return NextResponse.json({ errorCode: "not_found", error: "not found" }, { status: 404 });
  if (channel.ownerId !== userId) return NextResponse.json({ errorCode: "forbidden", error: "forbidden" }, { status: 403 });

  try {
    const result = await internalRpc(id, "agents.list");
    const gatewayAgents = normalizeGatewayAgents(result);

    // Query NPCs for this channel to check agent usage
    const channelNpcs = await db
      .select({ id: npcs.id, name: npcs.name, openclawConfig: npcs.openclawConfig })
      .from(npcs)
      .where(eq(npcs.channelId, id));

    // Build a map of agentId -> NPC name for quick lookup
    const agentIdToNpcName = new Map<string, string>();
    for (const npc of channelNpcs) {
      const openclawConfig = parseDbObject(npc.openclawConfig);
      const agentId = typeof openclawConfig?.agentId === "string" ? openclawConfig.agentId : null;
      if (agentId) {
        agentIdToNpcName.set(agentId, npc.name);
      }
    }

    const agents = gatewayAgents.map((agent) => {
      const usedByNpcName = agentIdToNpcName.get(agent.id) ?? null;
      return {
        id: agent.id,
        name: agent.name,
        workspace: agent.workspace,
        inUse: usedByNpcName !== null,
        usedByNpcName,
      };
    });

    return NextResponse.json({ agents });
  } catch (err) {
    console.error("Failed to list agents:", err);
    return NextResponse.json(
      buildGatewayErrorPayload(err, {
        fallbackErrorCode: "failed_to_list_agents",
        fallbackError: "Failed to list agents",
      }),
      { status: getGatewayErrorStatus(err, 502) },
    );
  }
}

// DELETE /api/channels/:id/gateway/agents?agentId=xxx — delete agent from gateway (owner only, not in use)
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = getUserId(req);
  if (!userId) return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  const { id } = await params;

  const agentId = req.nextUrl.searchParams.get("agentId");
  if (!agentId) {
    return NextResponse.json(
      { errorCode: "agent_id_required", error: "agentId required" },
      { status: 400 },
    );
  }
  if (agentId === "main") {
    return NextResponse.json(
      { errorCode: "cannot_delete_main_agent", error: "Cannot delete main agent" },
      { status: 400 },
    );
  }

  const [channel] = await db
    .select({ ownerId: channels.ownerId })
    .from(channels)
    .where(eq(channels.id, id))
    .limit(1);

  if (!channel) {
    return NextResponse.json({ errorCode: "channel_not_found", error: "not found" }, { status: 404 });
  }
  if (channel.ownerId !== userId) return NextResponse.json({ errorCode: "forbidden", error: "forbidden" }, { status: 403 });

  // Check if agent is in use by any NPC
  const channelNpcs = await db.select().from(npcs).where(eq(npcs.channelId, id));
  const inUse = channelNpcs.some((npc) => {
    const oc = parseDbObject(npc.openclawConfig);
    return oc?.agentId === agentId;
  });
  if (inUse) {
    return NextResponse.json(
      { errorCode: "agent_in_use_by_npc", error: "Agent is in use by an NPC" },
      { status: 409 },
    );
  }

  try {
    await internalRpc(id, "agents.delete", { agentId, deleteFiles: true });
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Failed to remove agent:", err);
    return NextResponse.json(
      buildGatewayErrorPayload(err, {
        fallbackErrorCode: "failed_to_remove_agent_from_gateway",
        fallbackError: "Failed to remove agent from gateway",
      }),
      { status: getGatewayErrorStatus(err, 502) },
    );
  }
}
