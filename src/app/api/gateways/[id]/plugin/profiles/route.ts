import { NextRequest, NextResponse } from "next/server";

import { db, users } from "@/db";
import { eq } from "drizzle-orm";
import { decryptGatewayToken, getAccessibleGatewayResource } from "@/lib/gateway-resources";
import { registerHermesProfile } from "@/lib/hermes-profiles";
import { createPluginClient } from "@/lib/hermes/plugin-client";
import { attachKeyStorage, stripApiKey } from "@/lib/hermes/plugin-provision";
import { getUserId } from "@/lib/internal-rpc";
import { hireProfileIntoBoundChannels } from "@/lib/npc-roster";
import { ERROR_CODE_HEADER } from "@/lib/i18n/error-codes";

import { validateCreatableProfileName, validateCreateOptions } from "../validation";

/**
 * Profile create and list use the **default key** — a credential covering the whole gateway, so
 * only `system_admin` can call them. Persona and config (profile-scoped) are not subject to this restriction.
 *
 * Proxy failures are returned as 200 + errorCode (same reason as gateways/[id]/test/route.ts —
 * Cloudflare replaces 5xx bodies with its own error page).
 */
const proxyInit = (errorCode: string) => ({
  status: 200,
  headers: { [ERROR_CODE_HEADER]: errorCode },
});

async function requireSystemAdmin(userId: string) {
  const [row] = await db
    .select({ systemRole: users.systemRole })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.systemRole === "system_admin";
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }
  if (!(await requireSystemAdmin(userId))) {
    return NextResponse.json({ errorCode: "forbidden", error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const accessible = await getAccessibleGatewayResource(userId, id);
  if (!accessible) {
    return NextResponse.json({ errorCode: "not_found", error: "not found" }, { status: 404 });
  }

  const client = createPluginClient({
    baseUrl: accessible.resource.baseUrl,
    defaultToken: decryptGatewayToken(accessible.resource.tokenEncrypted),
  });
  const res = await client.listProfiles();
  if (!res.ok) {
    return NextResponse.json(
      { errorCode: res.failure.code, error: res.failure.message, upstreamStatus: res.status },
      proxyInit(res.failure.code),
    );
  }
  return NextResponse.json(res.data);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }
  if (!(await requireSystemAdmin(userId))) {
    return NextResponse.json({ errorCode: "forbidden", error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json(
      { errorCode: "bad_request", error: "body must be JSON" },
      { status: 400 },
    );
  }

  // Verdict A: names to be newly created use `isCreatableProfileName` (strict) — using the
  // lenient `PROFILE_NAME_RE` meant for registering existing profiles lets local validation pass while the remote gives 400,
  // and the reason never reaches the screen.
  const nameCheck = validateCreatableProfileName(payload);
  if (!nameCheck.ok) {
    return NextResponse.json(
      { errorCode: nameCheck.errorCode, error: nameCheck.errorCode },
      { status: 400 },
    );
  }

  // The only clone source for now is `default` — make the reason clear here before the remote gives 400.
  const options = validateCreateOptions(payload);
  if (!options.ok) {
    return NextResponse.json(
      { errorCode: options.errorCode, error: options.errorCode },
      { status: 400 },
    );
  }

  const accessible = await getAccessibleGatewayResource(userId, id);
  if (!accessible) {
    return NextResponse.json({ errorCode: "not_found", error: "not found" }, { status: 404 });
  }

  const client = createPluginClient({
    baseUrl: accessible.resource.baseUrl,
    defaultToken: decryptGatewayToken(accessible.resource.tokenEncrypted),
  });
  const res = await client.createProfile(
    nameCheck.name,
    options.cloneFrom ? { cloneFrom: options.cloneFrom, cloneKeys: options.cloneKeys } : undefined,
  );
  if (!res.ok) {
    return NextResponse.json(
      { errorCode: res.failure.code, error: res.failure.message, upstreamStatus: res.status },
      proxyInit(res.failure.code),
    );
  }

  // Verdict B: if a key came back, store it **immediately**. There is no way to read it again, so missing it
  // here leaves a profile that exists but cannot be talked to, permanently. `registerHermesProfile`
  // returns `{error:"forbidden"}` for non-owners of the gateway, but the route only checks
  // system_admin, so that failure is sent in the response instead of being swallowed.
  let keyStorage: { ok: true } | { ok: false; reason: string } | null;
  // **How many channels** this profile actually clocked into. Clocking in only happens in channels that gateway
  // is already attached to — send the fact along so the screen does not say "이미 출근했습니다" unconditionally.
  let attendedChannels = 0;
  if (!res.data.keyIssued) {
    // No key was issued in the first place — attachKeyStorage distinguishes this case with null.
    keyStorage = null;
  } else if (!res.data.apiKey) {
    // M-3: keyIssued:true but apiKey came back empty — a different situation from "nothing was issued at all" (null),
    // so keyStored:false must not go out without a reason. Send a code —
    // final review M-3; the screen translates it with the wizard-error-codes dictionary.
    keyStorage = { ok: false, reason: "key_missing_after_issue" };
  } else {
    const stored = await registerHermesProfile({
      userId,
      gatewayId: id,
      profileName: res.data.name,
      token: res.data.apiKey,
      // Final review I-2: only this route actually creates this profile — pass explicitly here the fact
      // that the wizard set this mark. Manual registration (profiles/route.ts,
      // a different file) does not pass this argument, so it stays false.
      provisionedByDeskrpg: true,
    });
    if ("error" in stored) {
      keyStorage = { ok: false, reason: "key_store_forbidden" };
    } else {
      // Profiles made by the wizard clock in right away too (same convention as manual registration).
      //
      // If a hiring failure returned 500, the profile would remain on the remote Hermes and the user could not
      // recreate it with the same name — instead of creating an irreversible state, swallow it and only log.
      try {
        attendedChannels = (await hireProfileIntoBoundChannels(stored.profile.id)).created;
      } catch (hireErr) {
        console.error(
          `Failed to hire wizard profile ${stored.profile.id} into bound channels:`,
          hireErr,
        );
      }
      keyStorage = { ok: true };
    }
  }

  // `stripApiKey` never carries `apiKey` — `cloned`/`needsLogin`/`cloneError`
  // are fields that function does not know, so they are added here separately **only when present** (no values are invented).
  const cloneFields: Record<string, unknown> = {};
  if (res.data.cloned !== undefined) cloneFields.cloned = res.data.cloned;
  if (res.data.needsLogin !== undefined) cloneFields.needsLogin = res.data.needsLogin;
  if (res.data.cloneError !== undefined) cloneFields.cloneError = res.data.cloneError;

  return NextResponse.json(
    { ...attachKeyStorage(stripApiKey(res.data), keyStorage), attendedChannels, ...cloneFields },
    { status: 201 },
  );
}
