import { db } from "@/db";
import { channels } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { internalRpc, getUserId } from "@/lib/internal-rpc";
import { buildGatewayErrorPayload, getGatewayErrorStatus } from "@/lib/openclaw-gateway.js";

function normalizeGatewayAgents(result: unknown) {
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object" && Array.isArray((result as { agents?: unknown[] }).agents)) {
    return (result as { agents: unknown[] }).agents;
  }
  return [];
}

// POST /api/channels/:id/gateway/test — owner-only, tests gateway connection
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = getUserId(req);
  if (!userId) return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  const { id } = await params;

  // Verify ownership
  const [channel] = await db
    .select({ ownerId: channels.ownerId })
    .from(channels)
    .where(eq(channels.id, id))
    .limit(1);

  if (!channel) return NextResponse.json({ errorCode: "not_found", error: "not found" }, { status: 404 });
  if (channel.ownerId !== userId) return NextResponse.json({ errorCode: "forbidden", error: "forbidden" }, { status: 403 });

  try {
    const result = await internalRpc(id, "agents.list");
    return NextResponse.json({
      ok: true,
      agents: normalizeGatewayAgents(result),
    });
  } catch (err) {
    return NextResponse.json(
      buildGatewayErrorPayload(err, {
        ok: false,
        fallbackErrorCode: "connection_failed",
        fallbackError: "Connection failed",
      }),
      { status: getGatewayErrorStatus(err, 502) },
    );
  }
}
