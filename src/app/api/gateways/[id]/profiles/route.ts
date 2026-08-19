import { NextRequest, NextResponse } from "next/server";

import { getAccessibleGatewayResource } from "@/lib/gateway-resources";
import {
  listHermesProfiles,
  registerHermesProfile,
} from "@/lib/hermes-profiles";
import { getUserId } from "@/lib/internal-rpc";

import { validateProfileRegistration } from "./validation";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json(
      { errorCode: "unauthorized", error: "unauthorized" },
      { status: 401 },
    );
  }
  const { id } = await params;

  const accessible = await getAccessibleGatewayResource(userId, id);
  if (!accessible) {
    return NextResponse.json(
      { errorCode: "gateway_not_found", error: "Gateway not found" },
      { status: 404 },
    );
  }

  const profiles = await listHermesProfiles(userId, id);
  return NextResponse.json({ profiles });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json(
      { errorCode: "unauthorized", error: "unauthorized" },
      { status: 401 },
    );
  }
  const { id } = await params;

  const accessible = await getAccessibleGatewayResource(userId, id);
  if (!accessible) {
    return NextResponse.json(
      { errorCode: "gateway_not_found", error: "Gateway not found" },
      { status: 404 },
    );
  }

  const body = await req.json().catch(() => ({}));
  const validation = validateProfileRegistration(body);
  if (!validation.ok) {
    return NextResponse.json(
      { errorCode: validation.errorCode, error: validation.errorCode },
      { status: 400 },
    );
  }

  const displayName =
    typeof body.displayName === "string" ? body.displayName : undefined;

  const result = await registerHermesProfile({
    userId,
    gatewayId: id,
    profileName: validation.profileName,
    token: validation.token,
    displayName,
  });

  if ("error" in result) {
    return NextResponse.json(
      { errorCode: result.error, error: result.error },
      { status: 403 },
    );
  }

  // Never serialize tokenEncrypted — it is ciphertext of a credential.
  const { tokenEncrypted: _tokenEncrypted, ...safeProfile } = result.profile;

  return NextResponse.json({ profile: safeProfile }, { status: 201 });
}
