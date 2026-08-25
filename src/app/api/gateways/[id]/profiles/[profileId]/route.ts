import { NextRequest, NextResponse } from "next/server";

import { deleteHermesProfile, updateHermesProfile } from "@/lib/hermes-profiles";
import { getUserId } from "@/lib/internal-rpc";

/**
 * 프로필 수정·삭제.
 *
 * 이 두 메서드가 없어서, 토큰을 잘못 넣은 프로필은 화면에서 손댈 방법이 없었다 —
 * 만들 수만 있고 고칠 수도 지울 수도 없는 막다른 길이었다.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ profileId: string }> },
) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }
  const { profileId } = await params;

  const body = (await req.json().catch(() => ({}))) as {
    token?: unknown;
    displayName?: unknown;
  };

  const result = await updateHermesProfile(userId, profileId, {
    // 토큰은 보낼 때만 바뀐다 — 화면이 빈 칸을 아예 보내지 않는 규약이다.
    token: typeof body.token === "string" ? body.token : undefined,
    displayName: typeof body.displayName === "string" ? body.displayName : undefined,
  });

  if (!result.ok) {
    return NextResponse.json(
      { errorCode: result.errorCode, error: result.errorCode },
      { status: result.errorCode === "forbidden" ? 403 : 404 },
    );
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ profileId: string }> },
) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }
  const { profileId } = await params;

  const result = await deleteHermesProfile(userId, profileId);
  if (!result.ok) {
    return NextResponse.json(
      { errorCode: result.errorCode, error: result.errorCode },
      { status: result.errorCode === "forbidden" ? 403 : 404 },
    );
  }
  // 몇 개의 NPC 가 연결 해제됐는지 돌려준다 — 화면이 그 사실을 알려야 한다.
  return NextResponse.json({ ok: true, unboundNpcs: result.unboundNpcs });
}
