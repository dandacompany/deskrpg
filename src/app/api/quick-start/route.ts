import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";

import { channelMembers, channels, db, groupMembers, groups, users } from "@/db";
import { getUserId } from "@/lib/internal-rpc";
import { ensureMyCharacter } from "@/lib/my-character";
import { QUICK_START_ENVIRONMENT_ID, quickStartChannelName } from "@/lib/quick-start";

/**
 * `POST /api/quick-start` — folds the six screens right after sign-up (character → channel → placement → …) into one.
 *
 * **It makes no new domain rules.** The character via `ensureMyCharacter` (the one place for the "me" rule),
 * the channel via `POST` of `/api/channels` (inside which `ensureOfficeRoom` guarantees one office room
 * per channel), and seat placement via `PATCH` of `/api/npcs/:id` are **called as is**.
 * Apart from the character, nothing here writes tables directly — it only reads.
 *
 * Idempotent: if a character and channel already exist, nothing is created and those are returned.
 * It does not fail without a gateway (only step 3 is skipped).
 * The response has only two identifiers and carries no tokens or secrets.
 */

const JSON_HEADERS = { "Content-Type": "application/json" };

class QuickStartFailure extends Error {
  constructor(readonly response: NextResponse) {
    super("quick start step failed");
  }
}

function authHeaders(req: NextRequest): Headers {
  // Sub-routes also look only at `x-user-id` (pass the value the proxy set as is).
  const headers = new Headers(JSON_HEADERS);
  const userId = req.headers.get("x-user-id");
  if (userId) headers.set("x-user-id", userId);
  return headers;
}

function subRequest(req: NextRequest, path: string, body: unknown, method = "POST"): NextRequest {
  const bodyless = method === "GET" || method === "HEAD";
  return new NextRequest(new URL(path, req.nextUrl.origin), {
    method,
    headers: authHeaders(req),
    ...(bodyless ? {} : { body: JSON.stringify(body) }),
  });
}

async function expectOk(response: Response): Promise<Record<string, unknown>> {
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new QuickStartFailure(NextResponse.json(payload, { status: response.status }));
  }
  return payload;
}

/** The group to create the channel in. Look first at the user's memberships with management rights — the permission verdict itself is made by the channel route. */
async function resolveGroupId(userId: string): Promise<string | null> {
  const memberships = await db
    .select({ groupId: groupMembers.groupId, role: groupMembers.role, isDefault: groups.isDefault })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(eq(groupMembers.userId, userId));

  const ranked = [...memberships].sort(
    (a, b) =>
      Number(b.role === "group_admin") - Number(a.role === "group_admin") ||
      Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)),
  );
  if (ranked[0]) return ranked[0].groupId;

  const [fallback] = await db
    .select({ id: groups.id })
    .from(groups)
    .where(eq(groups.isDefault, true))
    .limit(1);
  return fallback?.id ?? null;
}

async function ensureChannel(req: NextRequest, userId: string, nickname: string | null) {
  const [owned] = await db
    .select({ id: channels.id })
    .from(channels)
    .where(eq(channels.ownerId, userId))
    .orderBy(asc(channels.createdAt))
    .limit(1);
  if (owned) return owned.id;

  const [joined] = await db
    .select({ id: channels.id })
    .from(channels)
    .innerJoin(channelMembers, eq(channelMembers.channelId, channels.id))
    .where(eq(channelMembers.userId, userId))
    .orderBy(asc(channels.createdAt))
    .limit(1);
  if (joined) return joined.id;

  const groupId = await resolveGroupId(userId);
  if (!groupId) {
    throw new QuickStartFailure(
      NextResponse.json(
        { errorCode: "channel_creation_forbidden", error: "channel creation forbidden" },
        { status: 403 },
      ),
    );
  }

  // The channel route builds the environment layout directly from code — no template table involved.
  const { POST } = await import("../channels/route");
  const payload = await expectOk(
    await POST(
      subRequest(req, "/api/channels", {
        name: quickStartChannelName(nickname),
        isPublic: true,
        groupId,
        environmentId: QUICK_START_ENVIRONMENT_ID,
      }),
    ),
  );
  const created = payload.channel as { id?: string } | undefined;
  if (!created?.id) {
    throw new QuickStartFailure(
      NextResponse.json(
        { errorCode: "failed_to_create_channel", error: "Failed to create channel" },
        { status: 500 },
      ),
    );
  }
  return created.id;
}

/**
 * Place NPCs that are clocked in but have no seat. The hiring path already places them, so usually there is nothing
 * to do — this is a safety net for reopening, via quick start, channels created before this feature.
 */
async function seatUnplacedNpcs(channelId: string) {
  const { placeUnplacedNpcs } = await import("@/lib/npc-seating");
  const { seated, standing } = await placeUnplacedNpcs(channelId);
  return seated + standing;
}

export async function POST(req: NextRequest) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }

  try {
    const [user] = await db
      .select({ nickname: users.nickname })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) {
      return NextResponse.json(
        { errorCode: "unauthorized", error: "unauthorized" },
        { status: 401 },
      );
    }

    const mine = await ensureMyCharacter(userId, user.nickname);
    const characterId = mine.id;
    const channelId = await ensureChannel(req, userId, user.nickname);

    // Only the channel owner can change NPC seats (the placement route's rule). When entering someone else's channel
    // do not seat them — do not bypass that rule.
    const [owned] = await db
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.id, channelId), eq(channels.ownerId, userId)))
      .limit(1);
    if (owned) {
      try {
        await seatUnplacedNpcs(channelId);
      } catch (seatErr) {
        console.warn("Quick start could not seat NPCs:", seatErr);
      }
    }

    return NextResponse.json({ channelId, characterId });
  } catch (err) {
    if (err instanceof QuickStartFailure) return err.response;
    console.error("Quick start failed:", err);
    return NextResponse.json(
      { errorCode: "internal_server_error", error: "Quick start failed" },
      { status: 500 },
    );
  }
}
