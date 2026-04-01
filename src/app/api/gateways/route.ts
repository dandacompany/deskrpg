import { NextRequest, NextResponse } from "next/server";

import { getUserId } from "@/lib/internal-rpc";
import { listAccessibleGatewayResources, upsertOwnedGatewayResource } from "@/lib/gateway-resources";

export async function GET(req: NextRequest) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }

  const gateways = await listAccessibleGatewayResources(userId);
  return NextResponse.json({ gateways });
}

export async function POST(req: NextRequest) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body.url !== "string" || !body.url.trim()) {
    return NextResponse.json({ errorCode: "gateway_url_required", error: "Gateway URL is required" }, { status: 400 });
  }

  const resource = await upsertOwnedGatewayResource({
    ownerUserId: userId,
    baseUrl: body.url,
    token: typeof body.token === "string" ? body.token : "",
    displayName: typeof body.displayName === "string" ? body.displayName : undefined,
  });

  return NextResponse.json({
    gateway: {
      id: resource.id,
      displayName: resource.displayName,
      baseUrl: resource.baseUrl,
      ownerUserId: resource.ownerUserId,
      lastValidatedAt: resource.lastValidatedAt,
      lastValidationStatus: resource.lastValidationStatus,
      lastValidationError: resource.lastValidationError,
      canEditCredentials: true,
      isOwner: true,
      shareRole: null,
    },
  });
}

