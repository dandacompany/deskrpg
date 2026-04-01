import { db } from "@/db";
import { channels, npcs } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { eq, count } from "drizzle-orm";
import { getUserId } from "@/lib/internal-rpc";
import {
  bindGatewayToChannel,
  decryptGatewayToken,
  deleteChannelGatewayArtifacts,
  getAccessibleGatewayResource,
  getChannelGatewayBinding,
  unbindGatewayFromChannel,
  updateChannelTaskAutomationSettings,
  upsertOwnedGatewayResource,
} from "@/lib/gateway-resources";
import { buildGatewayConfig, mergeGatewayConfig } from "@/lib/task-reporting";
import internalTransport from "@/lib/internal-transport.js";
import { getGatewayConfigUpdatedHandler } from "@/lib/rpc-registry";

const { buildInternalAuthHeaders, getInternalSocketBaseUrl } = internalTransport as {
  buildInternalAuthHeaders: () => Record<string, string>;
  getInternalSocketBaseUrl: () => string;
};

function buildResponseGatewayConfig(input: {
  userId: string;
  channelGatewayConfig: unknown;
  binding: Awaited<ReturnType<typeof getChannelGatewayBinding>>;
}) {
  const taskAutomation = buildGatewayConfig(input.channelGatewayConfig).taskAutomation;
  const boundGateway = input.binding?.resource ?? null;
  const canEditCredentials = !boundGateway || boundGateway.ownerUserId === input.userId;

  return {
    gatewayId: boundGateway?.id ?? null,
    displayName: boundGateway?.displayName ?? null,
    url: boundGateway?.baseUrl ?? null,
    token: boundGateway && canEditCredentials ? decryptGatewayToken(boundGateway.tokenEncrypted) : null,
    canEditCredentials,
    taskAutomation,
  };
}

async function emitGatewayConfigUpdated(channelId: string) {
  const localHandler = getGatewayConfigUpdatedHandler();
  if (localHandler) {
    await localHandler(channelId);
    return;
  }

  try {
    await fetch(`${getInternalSocketBaseUrl()}/_internal/emit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...buildInternalAuthHeaders(),
      },
      body: JSON.stringify({
        event: "gateway:config-updated",
        room: channelId,
        payload: { channelId },
      }),
    });
  } catch {
    console.warn("Failed to emit gateway:config-updated socket event");
  }
}

async function getChannelWithOwner(channelId: string) {
  const [channel] = await db
    .select({ ownerId: channels.ownerId, gatewayConfig: channels.gatewayConfig })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);
  return channel ?? null;
}

// GET /api/channels/:id/gateway — owner-only, returns bound gateway resource + task automation
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = getUserId(req);
  if (!userId) return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  const { id } = await params;

  const channel = await getChannelWithOwner(id);
  if (!channel) return NextResponse.json({ errorCode: "not_found", error: "not found" }, { status: 404 });
  if (channel.ownerId !== userId) return NextResponse.json({ errorCode: "forbidden", error: "forbidden" }, { status: 403 });

  const binding = await getChannelGatewayBinding(id);

  return NextResponse.json({
    gatewayConfig: buildResponseGatewayConfig({
      userId,
      channelGatewayConfig: channel.gatewayConfig,
      binding,
    }),
  });
}

// PUT /api/channels/:id/gateway — owner-only, binds a gateway resource or creates an owned one
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = getUserId(req);
  if (!userId) return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  const { id } = await params;

  const channel = await getChannelWithOwner(id);
  if (!channel) return NextResponse.json({ errorCode: "not_found", error: "not found" }, { status: 404 });
  if (channel.ownerId !== userId) return NextResponse.json({ errorCode: "forbidden", error: "forbidden" }, { status: 403 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ errorCode: "invalid_json", error: "invalid JSON" }, { status: 400 });
  }

  const currentBinding = await getChannelGatewayBinding(id);
  const mergedGatewayConfig = mergeGatewayConfig(channel.gatewayConfig, body);

  let nextGatewayId: string | null = currentBinding?.resource.id ?? null;
  if (typeof body.gatewayId === "string" && body.gatewayId.trim()) {
    const accessible = await getAccessibleGatewayResource(userId, body.gatewayId.trim());
    if (!accessible) {
      return NextResponse.json(
        { errorCode: "gateway_access_denied", error: "Gateway access denied" },
        { status: 403 },
      );
    }
    nextGatewayId = accessible.resource.id;
  } else if (Object.hasOwn(body, "url")) {
    if (!mergedGatewayConfig.url) {
      nextGatewayId = null;
    } else {
      const resource = await upsertOwnedGatewayResource({
        ownerUserId: userId,
        baseUrl: mergedGatewayConfig.url,
        token: mergedGatewayConfig.token ?? "",
        displayName: typeof body.displayName === "string" ? body.displayName : undefined,
      });
      nextGatewayId = resource.id;
    }
  }

  const previousGatewayId = currentBinding?.resource.id ?? null;
  const isBindingChanging = previousGatewayId !== nextGatewayId;

  if (isBindingChanging) {
    const [{ value: npcCount }] = await db
      .select({ value: count() })
      .from(npcs)
      .where(eq(npcs.channelId, id));

    if (npcCount > 0 && body.confirmNpcReset !== true) {
      return NextResponse.json(
        {
          errorCode: "gateway_change_requires_npc_reset",
          error: "Changing the channel gateway removes existing NPCs and their task or meeting context.",
        },
        { status: 409 },
      );
    }

    if (npcCount > 0) {
      await deleteChannelGatewayArtifacts(id);
    }
  }

  if (nextGatewayId) {
    await bindGatewayToChannel({
      channelId: id,
      gatewayId: nextGatewayId,
      boundByUserId: userId,
    });
  } else {
    await unbindGatewayFromChannel(id);
  }

  await updateChannelTaskAutomationSettings(id, {
    taskAutomation: mergedGatewayConfig.taskAutomation,
  });

  await emitGatewayConfigUpdated(id);

  const nextBinding = await getChannelGatewayBinding(id);
  return NextResponse.json({
    ok: true,
    gatewayConfig: buildResponseGatewayConfig({
      userId,
      channelGatewayConfig: {
        taskAutomation: mergedGatewayConfig.taskAutomation,
      },
      binding: nextBinding,
    }),
  });
}

// DELETE /api/channels/:id/gateway — owner-only, unbinds the channel gateway and removes NPC data
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = getUserId(req);
  if (!userId) return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  const { id } = await params;

  const channel = await getChannelWithOwner(id);
  if (!channel) return NextResponse.json({ errorCode: "not_found", error: "not found" }, { status: 404 });
  if (channel.ownerId !== userId) return NextResponse.json({ errorCode: "forbidden", error: "forbidden" }, { status: 403 });

  const [{ value: npcCount }] = await db
    .select({ value: count() })
    .from(npcs)
    .where(eq(npcs.channelId, id));

  const confirmNpcReset = req.nextUrl.searchParams.get("confirmNpcReset") === "1";
  if (npcCount > 0 && !confirmNpcReset) {
    return NextResponse.json(
      {
        errorCode: "gateway_disconnect_requires_npc_reset",
        error: "Disconnecting the channel gateway removes existing NPCs and their task or meeting context.",
      },
      { status: 409 },
    );
  }

  if (npcCount > 0) {
    await deleteChannelGatewayArtifacts(id);
  }

  await unbindGatewayFromChannel(id);
  await emitGatewayConfigUpdated(id);

  return NextResponse.json({
    ok: true,
    gatewayConfig: buildResponseGatewayConfig({
      userId,
      channelGatewayConfig: channel.gatewayConfig,
      binding: null,
    }),
  });
}
