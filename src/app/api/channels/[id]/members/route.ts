import { db } from "@/db";
import { channels, channelMembers, users } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import internalTransport from "@/lib/internal-transport.js";

const { buildInternalAuthHeaders, getInternalSocketBaseUrl } = internalTransport as {
  buildInternalAuthHeaders: () => Record<string, string>;
  getInternalSocketBaseUrl: () => string;
};

function getUserId(req: NextRequest): string | null {
  return req.headers.get("x-user-id");
}

// GET /api/channels/:id/members — list members (owner only)
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = getUserId(req);
  if (!userId) return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });

  const { id } = await params;

  try {
    const [channel] = await db
      .select({ ownerId: channels.ownerId })
      .from(channels)
      .where(eq(channels.id, id))
      .limit(1);

    if (!channel) return NextResponse.json({ errorCode: "channel_not_found", error: "Channel not found" }, { status: 404 });
    if (channel.ownerId !== userId) return NextResponse.json({ errorCode: "forbidden", error: "Not authorized" }, { status: 403 });

    const members = await db
      .select({
        userId: channelMembers.userId,
        nickname: users.nickname,
        role: channelMembers.role,
        joinedAt: channelMembers.joinedAt,
      })
      .from(channelMembers)
      .leftJoin(users, eq(channelMembers.userId, users.id))
      .where(eq(channelMembers.channelId, id))
      .orderBy(channelMembers.joinedAt);

    let onlineUserIds: string[] = [];
    try {
      const res = await fetch(`${getInternalSocketBaseUrl()}/_internal/room-members?channelId=${encodeURIComponent(id)}`, {
        headers: buildInternalAuthHeaders(),
      });
      if (res.ok) {
        const data = await res.json();
        onlineUserIds = data.userIds || [];
      }
    } catch {}

    const result = members.map((m) => ({
      ...m,
      isOnline: onlineUserIds.includes(m.userId),
    }));

    return NextResponse.json({ members: result });
  } catch (err) {
    console.error("Failed to fetch members:", err);
    return NextResponse.json(
      { errorCode: "failed_to_fetch_members", error: "Failed to fetch members" },
      { status: 500 },
    );
  }
}
