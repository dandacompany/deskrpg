import { db, isPostgres, jsonForDb } from "@/db";
import { channels } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getUserId } from "@/lib/internal-rpc";
import { buildGatewayConfig, mergeGatewayConfig } from "@/lib/task-reporting";
import internalTransport from "@/lib/internal-transport.js";

const { buildInternalAuthHeaders, getInternalSocketBaseUrl } = internalTransport as {
  buildInternalAuthHeaders: () => Record<string, string>;
  getInternalSocketBaseUrl: () => string;
};

// GET /api/channels/:id/gateway — owner-only, returns full gatewayConfig
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

  return NextResponse.json({
    gatewayConfig: buildGatewayConfig(channel.gatewayConfig),
  });
}

// PUT /api/channels/:id/gateway — owner-only, saves gatewayConfig
export async function PUT(
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

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ errorCode: "invalid_json", error: "invalid JSON" }, { status: 400 });
  }

  const gatewayConfig = mergeGatewayConfig(channel.gatewayConfig, body);

  await db
    .update(channels)
    .set({ gatewayConfig: jsonForDb(gatewayConfig), updatedAt: (isPostgres ? new Date() : new Date().toISOString()) as unknown as Date })
    .where(eq(channels.id, id));

  // Emit cache invalidation via internal socket endpoint (non-critical)
  try {
    await fetch(`${getInternalSocketBaseUrl()}/_internal/emit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...buildInternalAuthHeaders(),
      },
      body: JSON.stringify({
        event: "gateway:config-updated",
        room: id,
        payload: { channelId: id },
      }),
    });
  } catch {
    console.warn("Failed to emit gateway:config-updated socket event");
  }

  return NextResponse.json({
    ok: true,
    gatewayConfig: buildGatewayConfig(gatewayConfig),
  });
}
