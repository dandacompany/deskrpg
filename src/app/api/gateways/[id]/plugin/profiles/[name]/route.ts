import { NextRequest, NextResponse } from "next/server";

import { db, hermesProfiles, users } from "@/db";
import { and, eq } from "drizzle-orm";
import { decryptGatewayToken, getAccessibleGatewayResource } from "@/lib/gateway-resources";
import { createPluginClient } from "@/lib/hermes/plugin-client";
import { isValidProfileName } from "@/lib/hermes/profile-name";
import { getUserId } from "@/lib/internal-rpc";
import { ERROR_CODE_HEADER } from "@/lib/i18n/error-codes";

/**
 * Deleting a profile uses the default key, which covers the whole gateway, so it is `system_admin` only.
 *
 * The plugin may refuse with `409 profile_has_service` — when the profile has its own systemd
 * unit. Then the shell command in the response is carried to the screen **as is**. If we
 * deleted it ourselves an orphan unit would remain, and leaving it to Hermes's delete_profile kills the gateway.
 */
const proxyInit = (errorCode: string) => ({
  status: 200,
  headers: { [ERROR_CODE_HEADER]: errorCode },
});

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; name: string }> },
) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized" }, { status: 401 });
  }
  const [row] = await db
    .select({ systemRole: users.systemRole })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (row?.systemRole !== "system_admin") {
    return NextResponse.json({ errorCode: "forbidden" }, { status: 403 });
  }

  const { id, name } = await ctx.params;

  // M-1: inserting an unvalidated name into the remote path — encodeURIComponent does not escape "." —
  // makes the profile scope silently disappear through URL normalization when name==".." (exactly the warning
  // in profile-name.ts). Deletion targets *existing* profiles, so the lenient isValidProfileName is used —
  // the new-name grammar (isCreatableProfileName) would make it impossible to delete profiles
  // created in the past with uppercase or dotted names.
  if (!isValidProfileName(name)) {
    return NextResponse.json({ errorCode: "invalid_profile_name" }, { status: 400 });
  }

  const accessible = await getAccessibleGatewayResource(userId, id);
  if (!accessible) {
    return NextResponse.json({ errorCode: "not_found" }, { status: 404 });
  }

  const client = createPluginClient({
    baseUrl: accessible.resource.baseUrl,
    defaultToken: decryptGatewayToken(accessible.resource.tokenEncrypted),
  });
  const res = await client.deleteProfile(name);
  if (!res.ok) {
    return NextResponse.json(
      {
        errorCode: res.failure.code,
        error: res.failure.message,
        shellCommand: res.failure.showsShellCommand,
        upstreamStatus: res.status,
      },
      proxyInit(res.failure.code),
    );
  }

  // M-4: if the remote delete succeeds but the local registration row remains, a profile the gateway no longer has
  // keeps showing in the DeskRPG list, and NPCs bound to it fail only at conversation time. Even without this row
  // (deleting a profile that was never registered) the delete is a no-op, so it is safe.
  await db
    .delete(hermesProfiles)
    .where(and(eq(hermesProfiles.gatewayId, id), eq(hermesProfiles.profileName, name)));

  return NextResponse.json(res.data);
}
