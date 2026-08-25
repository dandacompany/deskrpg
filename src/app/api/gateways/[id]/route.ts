import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db, gatewayResources } from "@/db";
import { getUserId } from "@/lib/internal-rpc";
import {
  countChannelBindingsForGateway,
  listChannelBindingsForGateway,
  decryptGatewayToken,
  getAccessibleGatewayResource,
  getOwnedGatewayResource,
  upsertOwnedGatewayResource,
} from "@/lib/gateway-resources";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  const accessible = await getAccessibleGatewayResource(userId, id);
  if (!accessible) {
    return NextResponse.json(
      { errorCode: "gateway_not_found", error: "Gateway not found" },
      { status: 404 },
    );
  }

  return NextResponse.json({
    gateway: {
      id: accessible.resource.id,
      displayName: accessible.resource.displayName,
      baseUrl: accessible.resource.baseUrl,
      token: accessible.isOwner ? decryptGatewayToken(accessible.resource.tokenEncrypted) : null,
      ownerUserId: accessible.resource.ownerUserId,
      canEditCredentials: accessible.isOwner,
      isOwner: accessible.isOwner,
      shareRole: accessible.share?.role ?? null,
      lastValidatedAt: accessible.resource.lastValidatedAt,
      lastValidationStatus: accessible.resource.lastValidationStatus,
      lastValidationError: accessible.resource.lastValidationError,
    },
  });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  const owned = await getOwnedGatewayResource(userId, id);
  if (!owned) {
    return NextResponse.json({ errorCode: "forbidden", error: "forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ errorCode: "invalid_json", error: "invalid JSON" }, { status: 400 });
  }

  const nextBaseUrl = typeof body.url === "string" && body.url.trim() ? body.url : owned.baseUrl;
  const nextToken =
    typeof body.token === "string" ? body.token : decryptGatewayToken(owned.tokenEncrypted);
  const nextDisplayName =
    typeof body.displayName === "string" ? body.displayName : owned.displayName;
  const existingToken = decryptGatewayToken(owned.tokenEncrypted);
  const isCredentialChanging = nextBaseUrl !== owned.baseUrl || nextToken !== existingToken;

  if (isCredentialChanging) {
    const inUseCount = await countChannelBindingsForGateway(owned.id);
    if (inUseCount > 0) {
      return NextResponse.json(
        {
          errorCode: "gateway_in_use_by_channels",
          error:
            "This gateway is still bound to channels. Rebind channels before rotating credentials.",
        },
        { status: 409 },
      );
    }
  }

  const updated = await upsertOwnedGatewayResource({
    ownerUserId: userId,
    baseUrl: nextBaseUrl,
    token: nextToken,
    displayName: nextDisplayName,
  });

  if (updated.id !== owned.id) {
    await db.delete(gatewayResources).where(eq(gatewayResources.id, owned.id));
  }

  return NextResponse.json({
    gateway: {
      id: updated.id,
      displayName: updated.displayName,
      baseUrl: updated.baseUrl,
      token: decryptGatewayToken(updated.tokenEncrypted),
      ownerUserId: updated.ownerUserId,
      canEditCredentials: true,
      isOwner: true,
      shareRole: null,
      lastValidatedAt: updated.lastValidatedAt,
      lastValidationStatus: updated.lastValidationStatus,
      lastValidationError: updated.lastValidationError,
    },
  });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  const owned = await getOwnedGatewayResource(userId, id);
  if (!owned) {
    return NextResponse.json({ errorCode: "forbidden", error: "forbidden" }, { status: 403 });
  }

  const bindings = await listChannelBindingsForGateway(id, userId);
  if (bindings.length > 0) {
    // 개수만 돌려주면 사용자가 어느 채널인지 찾아 헤맨다. 이름과 "풀면 무엇이 사라지는가"
    // 까지 실어 보내, 게이트웨이 화면에서 그대로 결정할 수 있게 한다.
    return NextResponse.json(
      {
        errorCode: "gateway_in_use_by_channels",
        error: "Gateway is currently bound to one or more channels",
        channels: bindings,
      },
      { status: 409 },
    );
  }

  await db.delete(gatewayResources).where(eq(gatewayResources.id, id));
  return NextResponse.json({ ok: true });
}
