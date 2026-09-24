import { NextRequest, NextResponse } from "next/server";

import { db, hermesProfiles } from "@/db";
import { eq } from "drizzle-orm";
import { decryptGatewayToken, getAccessibleGatewayResource } from "@/lib/gateway-resources";
import { createPluginClient } from "@/lib/hermes/plugin-client";
import { selectProfileToken } from "@/lib/hermes/plugin-profile-access";
import { getUserId } from "@/lib/internal-rpc";
import { ERROR_CODE_HEADER } from "@/lib/i18n/error-codes";

import { validateConfigPatch } from "../../../validation";

/**
 * Like the persona, config is profile-scoped, so gateway access is enough.
 * `resolve` copies the identity route's shape as is — better that the two routes
 * read independently (brief's call).
 */
const proxyInit = (errorCode: string) => ({
  status: 200,
  headers: { [ERROR_CODE_HEADER]: errorCode },
});

type Ctx = { params: Promise<{ id: string; name: string }> };

async function resolve(req: NextRequest, ctx: Ctx) {
  const userId = getUserId(req);
  if (!userId) return { error: NextResponse.json({ errorCode: "unauthorized" }, { status: 401 }) };
  const { id, name } = await ctx.params;

  const accessible = await getAccessibleGatewayResource(userId, id);
  if (!accessible) return { error: NextResponse.json({ errorCode: "not_found" }, { status: 404 }) };

  const rows = await db
    .select({
      profileName: hermesProfiles.profileName,
      tokenEncrypted: hermesProfiles.tokenEncrypted,
    })
    .from(hermesProfiles)
    .where(eq(hermesProfiles.gatewayId, id));

  const token = selectProfileToken({ rows, profileName: name, decrypt: decryptGatewayToken });
  if (!token.ok) {
    return { error: NextResponse.json({ errorCode: token.reason }, { status: 404 }) };
  }

  const client = createPluginClient({
    baseUrl: accessible.resource.baseUrl,
    defaultToken: decryptGatewayToken(accessible.resource.tokenEncrypted),
  });
  return { client, name, profileToken: token.profileToken };
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const r = await resolve(req, ctx);
  if ("error" in r) return r.error;
  const res = await r.client.getConfig(r.name, r.profileToken);
  if (!res.ok) {
    return NextResponse.json(
      { errorCode: res.failure.code, error: res.failure.message, upstreamStatus: res.status },
      proxyInit(res.failure.code),
    );
  }
  return NextResponse.json(res.data);
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  const r = await resolve(req, ctx);
  if ("error" in r) return r.error;

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ errorCode: "bad_request" }, { status: 400 });
  }
  const patchCheck = validateConfigPatch(payload);
  if (!patchCheck.ok) {
    const body =
      patchCheck.errorCode === "unsupported_config_key"
        ? { errorCode: patchCheck.errorCode, error: patchCheck.unknownKeys.join(",") }
        : { errorCode: patchCheck.errorCode };
    return NextResponse.json(body, { status: 400 });
  }

  const res = await r.client.putConfig(r.name, r.profileToken, patchCheck.patch);
  if (!res.ok) {
    return NextResponse.json(
      { errorCode: res.failure.code, error: res.failure.message, upstreamStatus: res.status },
      proxyInit(res.failure.code),
    );
  }
  return NextResponse.json(res.data);
}
