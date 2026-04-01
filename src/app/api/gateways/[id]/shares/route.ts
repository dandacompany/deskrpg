import { NextRequest, NextResponse } from "next/server";

import { getUserId } from "@/lib/internal-rpc";
import {
  createGatewayShare,
  listGatewaySharesForOwner,
  removeGatewayShare,
} from "@/lib/gateway-resources";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  const result = await listGatewaySharesForOwner(userId, id);
  if (!result) {
    return NextResponse.json({ errorCode: "forbidden", error: "forbidden" }, { status: 403 });
  }

  return NextResponse.json({
    gateway: {
      id: result.resource.id,
      displayName: result.resource.displayName,
    },
    shares: result.shares,
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  const body = await req.json().catch(() => null);
  const targetLoginId = typeof body?.loginId === "string" ? body.loginId.trim() : "";
  if (!targetLoginId) {
    return NextResponse.json({ errorCode: "login_id_required", error: "loginId required" }, { status: 400 });
  }

  const result = await createGatewayShare({
    ownerUserId: userId,
    gatewayId: id,
    targetLoginId,
    role: typeof body?.role === "string" ? body.role : "use",
  });

  if (!result.resource) {
    return NextResponse.json({ errorCode: "forbidden", error: "forbidden" }, { status: 403 });
  }
  if (!result.targetUser || !result.share) {
    return NextResponse.json(
      { errorCode: "share_target_not_found", error: "Share target not found" },
      { status: 404 },
    );
  }

  return NextResponse.json({
    share: {
      id: result.share.id,
      userId: result.targetUser.id,
      loginId: result.targetUser.loginId,
      nickname: result.targetUser.nickname,
      role: result.share.role,
      createdAt: result.share.createdAt,
    },
  });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  const body = await req.json().catch(() => null);
  const targetUserId = typeof body?.userId === "string" ? body.userId : "";
  if (!targetUserId) {
    return NextResponse.json({ errorCode: "user_id_required", error: "userId required" }, { status: 400 });
  }

  const removed = await removeGatewayShare({
    ownerUserId: userId,
    gatewayId: id,
    targetUserId,
  });

  if (!removed) {
    return NextResponse.json({ errorCode: "forbidden", error: "forbidden" }, { status: 403 });
  }

  return NextResponse.json({ ok: true });
}
