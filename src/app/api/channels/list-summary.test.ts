import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import { authHeaders, seedUser, setupThrowawaySqlite } from "@/test-setup/npc-seed";

/**
 * The channel list (`GET /api/channels`) carries what cards need to draw a map thumbnail and participants —
 * `environmentId` (judged from the map), `memberCount` (owner + channel_members), `participants` (the first five people's
 * nicknames and latest character appearance). The hard-coded `playerCount` is no longer included.
 *
 * Kept outside the `[id]` segment — the node test runner mistakes `[id]` for a character class.
 */
setupThrowawaySqlite("channel-list-summary-test");

async function seedOwnerWithGroup() {
  const owner = await seedUser("list-owner");
  const { db, groups, groupMembers } = await import("@/db");
  const [group] = await db
    .insert(groups)
    .values({
      name: "Default",
      slug: `default-${owner.id.slice(0, 8)}`,
      description: "channel list summary test",
      isDefault: true,
      createdBy: owner.id,
    })
    .returning();
  await db
    .insert(groupMembers)
    .values({ groupId: group.id, userId: owner.id, role: "group_admin" });
  return { owner, groupId: group.id };
}

// The test DB is SQLite, so JSON and time columns are text — mimic the stored shape as is.
async function addCharacter(
  userId: string,
  appearance: Record<string, unknown>,
  updatedAt: string,
) {
  const { db, characters } = await import("@/db");
  await db.insert(characters).values({
    userId,
    name: `c-${userId.slice(0, 6)}`,
    appearance: JSON.stringify(appearance),
    createdAt: updatedAt,
    updatedAt,
  } as never);
}

test("the list carries environment ID, participant count and a preview of the first five, and no playerCount", async () => {
  const { owner, groupId } = await seedOwnerWithGroup();
  await addCharacter(owner.id, { officeLookId: "old-look" }, "2026-01-01T00:00:00.000Z");
  await addCharacter(owner.id, { officeLookId: "office-eun" }, "2026-02-01T00:00:00.000Z");

  const { POST, GET } = await import("./route");
  const created = await POST(
    new NextRequest("http://localhost/api/channels", {
      method: "POST",
      headers: authHeaders(owner.id),
      body: JSON.stringify({ name: "기술팀", isPublic: true, groupId, environmentId: "tech" }),
    }),
  );
  const createdBody = (await created.json()) as { channel?: { id: string } };
  assert.equal(created.status, 201, JSON.stringify(createdBody));
  const channelId = createdBody.channel!.id;

  const member = await seedUser("list-member");
  await addCharacter(member.id, { officeLookId: "office-min" }, "2026-03-01T00:00:00.000Z");
  const { db, channelMembers } = await import("@/db");
  await db.insert(channelMembers).values({ channelId, userId: member.id, role: "member" });

  const res = await GET(
    new NextRequest("http://localhost/api/channels", { headers: authHeaders(owner.id) }),
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { channels: Array<Record<string, unknown>> };
  const channel = body.channels.find((c) => c.id === channelId)!;
  assert.equal(channel.environmentId, "tech");
  assert.equal(channel.memberCount, 2);
  assert.deepEqual(channel.participants, [
    { nickname: owner.nickname, appearance: { officeLookId: "office-eun" } },
    { nickname: member.nickname, appearance: { officeLookId: "office-min" } },
  ]);
  assert.equal("playerCount" in channel, false);
});
