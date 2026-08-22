import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db, providerResources } from "@/db";
import { decryptGatewayToken, encryptGatewayToken } from "@/lib/gateway-resources";
import { getUserId } from "@/lib/internal-rpc";
import {
  getAccessibleProviderResource,
  getOwnedProviderResource,
  normalizeOptionalProviderText,
  parseProviderCredentials,
  providerNowForDb,
  serializeProviderCredentials,
  toProviderListItem,
} from "@/lib/provider-resources";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  const accessible = await getAccessibleProviderResource(userId, id);
  if (!accessible) {
    return NextResponse.json(
      { errorCode: "provider_not_found", error: "Provider not found" },
      { status: 404 },
    );
  }

  return NextResponse.json({
    provider: {
      ...toProviderListItem(accessible.resource, {
        isOwner: accessible.isOwner,
        shareRole: accessible.share?.role ?? null,
      }),
      credentials:
        accessible.isOwner && accessible.resource.credentialsEncrypted
          ? parseProviderCredentials(decryptGatewayToken(accessible.resource.credentialsEncrypted))
          : null,
    },
  });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  const owned = await getOwnedProviderResource(userId, id);
  if (!owned) {
    return NextResponse.json({ errorCode: "forbidden", error: "forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  if (!isRecord(body)) {
    return NextResponse.json({ errorCode: "invalid_json", error: "invalid JSON" }, { status: 400 });
  }

  const updates: Partial<typeof providerResources.$inferInsert> = {
    updatedAt: providerNowForDb(),
  };

  if (body.providerType !== undefined) {
    if (typeof body.providerType !== "string" || !body.providerType.trim()) {
      return NextResponse.json(
        { errorCode: "provider_type_required", error: "Provider type must be a non-empty string" },
        { status: 400 },
      );
    }
    updates.providerType = body.providerType.trim();
  }

  if (body.authMethod !== undefined) {
    if (typeof body.authMethod !== "string" || !body.authMethod.trim()) {
      return NextResponse.json(
        {
          errorCode: "provider_auth_method_required",
          error: "Auth method must be a non-empty string",
        },
        { status: 400 },
      );
    }
    updates.authMethod = body.authMethod.trim();
  }

  try {
    if (Object.prototype.hasOwnProperty.call(body, "displayName")) {
      updates.displayName = normalizeOptionalProviderText(body.displayName) ?? null;
    }

    if (Object.prototype.hasOwnProperty.call(body, "baseUrl")) {
      updates.baseUrl = normalizeOptionalProviderText(body.baseUrl) ?? null;
    }
  } catch {
    return NextResponse.json(
      {
        errorCode: "invalid_provider_payload",
        error: "displayName/baseUrl must be a string or null",
      },
      { status: 400 },
    );
  }

  if (Object.prototype.hasOwnProperty.call(body, "credentials")) {
    if (body.credentials === null) {
      updates.credentialsEncrypted = null;
    } else {
      try {
        updates.credentialsEncrypted = encryptGatewayToken(
          serializeProviderCredentials(body.credentials),
        );
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
  }

  const [updated] = await db
    .update(providerResources)
    .set(updates)
    .where(eq(providerResources.id, owned.id))
    .returning();

  return NextResponse.json({
    provider: {
      ...toProviderListItem(updated, { isOwner: true, shareRole: null }),
      credentials: updated.credentialsEncrypted
        ? parseProviderCredentials(decryptGatewayToken(updated.credentialsEncrypted))
        : null,
    },
  });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  const owned = await getOwnedProviderResource(userId, id);
  if (!owned) {
    return NextResponse.json({ errorCode: "forbidden", error: "forbidden" }, { status: 403 });
  }

  await db.delete(providerResources).where(eq(providerResources.id, id));
  return NextResponse.json({ ok: true });
}
