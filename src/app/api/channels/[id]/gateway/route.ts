import { isManagedSshUrl } from "@/lib/hermes/setup/transport-id";
import { db } from "@/db";
import { channels } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getUserId } from "@/lib/internal-rpc";
import { hireGatewayProfilesIntoChannel, sleepChannelNpcs } from "@/lib/npc-roster";
import {
  bindGatewayToChannel,
  decryptGatewayToken,
  getAccessibleGatewayResource,
  getChannelGatewayBinding,
  unbindGatewayFromChannel,
  upsertOwnedGatewayResource,
} from "@/lib/gateway-resources";
import internalTransport from "@/lib/internal-transport.js";
import { getGatewayConfigUpdatedHandler } from "@/lib/rpc-registry";
import { requestRefreshPollers } from "@/lib/automation-registry";

const { buildInternalAuthHeaders, getInternalSocketBaseUrl } = internalTransport as {
  buildInternalAuthHeaders: () => Record<string, string>;
  getInternalSocketBaseUrl: () => string;
};

/** When the binding changes, make the poller reread its table — without waiting, and failures never mix into the response. */
function refreshPollersInBackground() {
  void requestRefreshPollers().catch((err: unknown) => {
    console.warn(
      `[gateway-route] refreshPollers failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

function buildResponseGatewayConfig(input: {
  userId: string;
  binding: Awaited<ReturnType<typeof getChannelGatewayBinding>>;
}) {
  const boundGateway = input.binding?.resource ?? null;
  const canEditCredentials = !boundGateway || boundGateway.ownerUserId === input.userId;

  // The decrypted token is not put in the response (hard gate 2). Even restricted to owners it
  // leaks into browser memory, proxy logs and extensions. All the screen actually needs is
  // "is a key stored", and changing it takes a newly entered value.
  const hasToken = Boolean(boundGateway && decryptGatewayToken(boundGateway.tokenEncrypted).trim());

  return {
    gatewayId: boundGateway?.id ?? null,
    displayName: boundGateway?.displayName ?? null,
    url: boundGateway?.baseUrl ?? null,
    hasToken,
    canEditCredentials,
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
    .select({ ownerId: channels.ownerId })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);
  return channel ?? null;
}

// GET /api/channels/:id/gateway — owner-only, returns bound gateway resource
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = getUserId(req);
  if (!userId)
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  const { id } = await params;

  const channel = await getChannelWithOwner(id);
  if (!channel)
    return NextResponse.json({ errorCode: "not_found", error: "not found" }, { status: 404 });
  if (channel.ownerId !== userId)
    return NextResponse.json({ errorCode: "forbidden", error: "forbidden" }, { status: 403 });

  const binding = await getChannelGatewayBinding(id);

  return NextResponse.json({
    gatewayConfig: buildResponseGatewayConfig({ userId, binding }),
  });
}

// PUT /api/channels/:id/gateway — owner-only, binds a gateway resource or creates an owned one
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = getUserId(req);
  if (!userId)
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  const { id } = await params;

  const channel = await getChannelWithOwner(id);
  if (!channel)
    return NextResponse.json({ errorCode: "not_found", error: "not found" }, { status: 404 });
  if (channel.ownerId !== userId)
    return NextResponse.json({ errorCode: "forbidden", error: "forbidden" }, { status: 403 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ errorCode: "invalid_json", error: "invalid JSON" }, { status: 400 });
  }

  if (!(typeof body.gatewayId === "string" && body.gatewayId.trim()) && isManagedSshUrl(body.url)) {
    return NextResponse.json(
      { errorCode: "setup_invalid_request", error: "setup_invalid_request" },
      { status: 400 },
    );
  }

  const currentBinding = await getChannelGatewayBinding(id);
  const requestedUrl = typeof body.url === "string" ? body.url.trim() || null : null;
  // The screen no longer holds the existing key, so a body without token means "leave it as is".
  // Overwriting with an empty string as before would wipe the key on a save that only fixed the URL.
  const rawToken: unknown = body.token;
  const tokenProvided = typeof rawToken === "string";
  const requestedToken = tokenProvided ? rawToken.trim() || null : null;

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
    if (!requestedUrl) {
      nextGatewayId = null;
    } else {
      const resource = await upsertOwnedGatewayResource({
        ownerUserId: userId,
        baseUrl: requestedUrl,
        token: tokenProvided ? (requestedToken ?? "") : undefined,
        displayName: typeof body.displayName === "string" ? body.displayName : undefined,
      });
      nextGatewayId = resource.id;
    }
  }

  const previousGatewayId = currentBinding?.resource.id ?? null;
  const isBindingChanging = previousGatewayId !== nextGatewayId;

  if (nextGatewayId) {
    await bindGatewayToChannel({
      channelId: id,
      gatewayId: nextGatewayId,
      boundByUserId: userId,
    });
  } else {
    await unbindGatewayFromChannel(id);
  }

  // Switching gateways no longer deletes NPCs. The old gateway's NPCs sleep remembering their
  // seats (reconnecting brings them back to those seats), and the new gateway's profiles
  // clock in. Channel artifacts such as minutes and tasks stay as well.
  if (previousGatewayId && previousGatewayId !== nextGatewayId) {
    await sleepChannelNpcs(id, previousGatewayId);
  }
  // Hiring happens **only when the connection changes**. If a PUT that re-saves the same gateway ran
  // hiring every time, NPCs the user had individually put to sleep would silently come back to life
  // with a single settings save (Task 7's per-NPC toggle creates that state).
  if (nextGatewayId && isBindingChanging) {
    await hireGatewayProfilesIntoChannel(id, nextGatewayId);
  }

  await emitGatewayConfigUpdated(id);
  refreshPollersInBackground();

  const nextBinding = await getChannelGatewayBinding(id);
  // Moved to another gateway — the board was secured on the new gateway (inside bindGatewayToChannel),
  // but cards and cron jobs stay on the previous gateway (R4). Tell the user.
  const movedToAnotherGateway = Boolean(previousGatewayId && nextGatewayId && isBindingChanging);
  return NextResponse.json({
    ok: true,
    gatewayConfig: buildResponseGatewayConfig({ userId, binding: nextBinding }),
    ...(movedToAnotherGateway ? { warning: "previous_board_retained" as const } : {}),
  });
}

// DELETE /api/channels/:id/gateway — owner-only, unbinds the channel gateway and puts its NPCs to sleep
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = getUserId(req);
  if (!userId)
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  const { id } = await params;

  const channel = await getChannelWithOwner(id);
  if (!channel)
    return NextResponse.json({ errorCode: "not_found", error: "not found" }, { status: 404 });
  if (channel.ownerId !== userId)
    return NextResponse.json({ errorCode: "forbidden", error: "forbidden" }, { status: 403 });

  // Disconnecting is the same as switching — it puts NPCs to sleep rather than deleting them. Seats and minutes
  // stay, and reconnecting brings them back to those seats. So there is nothing to confirm
  // (the former 409 gateway_disconnect_requires_npc_reset).
  const previousGatewayId = (await getChannelGatewayBinding(id))?.resource.id ?? null;

  await unbindGatewayFromChannel(id);
  if (previousGatewayId) {
    await sleepChannelNpcs(id, previousGatewayId);
  }
  await emitGatewayConfigUpdated(id);
  refreshPollersInBackground();

  return NextResponse.json({
    ok: true,
    gatewayConfig: buildResponseGatewayConfig({ userId, binding: null }),
  });
}
