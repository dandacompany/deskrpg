// POST /api/gateways/:id/plugin/profiles/:name/import — register an existing Hermes profile as an
// employee. Body `{ rotate?: true }` replaces a key the profile already has. Gateway owner only.
// The issued key is stored encrypted and never returned.
import { NextRequest, NextResponse } from "next/server";

import { importHermesProfile } from "@/lib/hermes/profile-import";
import { ERROR_CODE_HEADER } from "@/lib/i18n/error-codes";
import { getUserId } from "@/lib/internal-rpc";

type Ctx = { params: Promise<{ id: string; name: string }> };

export async function POST(req: NextRequest, { params }: Ctx) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }
  const { id, name } = await params;

  let rotate = false;
  const text = await req.text();
  if (text.trim()) {
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return NextResponse.json(
        { errorCode: "bad_request", error: "body must be JSON" },
        { status: 400 },
      );
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return NextResponse.json({ errorCode: "bad_request", error: "bad_request" }, { status: 400 });
    }
    const record = payload as Record<string, unknown>;
    if ("rotate" in record) {
      if (record.rotate !== true) {
        return NextResponse.json(
          { errorCode: "bad_request", error: "rotate must be true" },
          { status: 400 },
        );
      }
      rotate = true;
    }
  }

  const result = await importHermesProfile({ userId, gatewayId: id, profileName: name, rotate });
  if (!result.ok) {
    return NextResponse.json(
      { errorCode: result.errorCode, error: result.errorCode },
      result.upstream
        ? { status: 200, headers: { [ERROR_CODE_HEADER]: result.errorCode } }
        : { status: result.status },
    );
  }
  return NextResponse.json(
    { profile: result.profile, attendedChannels: result.attendedChannels, rotated: result.rotated },
    { status: 201 },
  );
}
