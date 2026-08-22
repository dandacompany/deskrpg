import { NextRequest, NextResponse } from "next/server";

import { db, providerResources } from "@/db";
import { encryptGatewayToken } from "@/lib/gateway-resources";
import { getUserId } from "@/lib/internal-rpc";
import {
  listAccessibleProviderResources,
  normalizeOptionalProviderText,
  serializeProviderCredentials,
  toProviderListItem,
} from "@/lib/provider-resources";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function GET(req: NextRequest) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }

  const providers = await listAccessibleProviderResources(userId);
  return NextResponse.json({ providers });
}

export async function POST(req: NextRequest) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!isRecord(body)) {
    return NextResponse.json({ errorCode: "invalid_json", error: "invalid JSON" }, { status: 400 });
  }

  const providerType = typeof body.providerType === "string" ? body.providerType.trim() : "";
  const authMethod = typeof body.authMethod === "string" ? body.authMethod.trim() : "";
  if (!providerType) {
    return NextResponse.json(
      { errorCode: "provider_type_required", error: "Provider type is required" },
      { status: 400 },
    );
  }
  if (!authMethod) {
    return NextResponse.json(
      { errorCode: "provider_auth_method_required", error: "Auth method is required" },
      { status: 400 },
    );
  }

  let displayName: string | null | undefined;
  let baseUrl: string | null | undefined;
  try {
    displayName = normalizeOptionalProviderText(body.displayName);
    baseUrl = normalizeOptionalProviderText(body.baseUrl);
  } catch {
    return NextResponse.json(
      {
        errorCode: "invalid_provider_payload",
        error: "displayName/baseUrl must be a string or null",
      },
      { status: 400 },
    );
  }

  let credentialsEncrypted: string | null = null;
  if (body.credentials !== undefined && body.credentials !== null) {
    try {
      credentialsEncrypted = encryptGatewayToken(serializeProviderCredentials(body.credentials));
    } catch {
      return NextResponse.json(
        {
          errorCode: "invalid_provider_credentials",
          error: "Provider credentials must be serializable",
        },
        { status: 400 },
      );
    }
  }

  const [created] = await db
    .insert(providerResources)
    .values({
      ownerUserId: userId,
      providerType,
      displayName: displayName ?? null,
      authMethod,
      credentialsEncrypted,
      baseUrl: baseUrl ?? null,
    })
    .returning();

  return NextResponse.json({
    provider: toProviderListItem(created, { isOwner: true, shareRole: null }),
  });
}
