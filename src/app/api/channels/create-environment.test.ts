import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import { authHeaders, seedUser, setupThrowawaySqlite } from "@/test-setup/npc-seed";
import { buildOfficeEnvironment, OFFICE_ENVIRONMENTS } from "@/game/three/office-environments";
import { normalizeMeetingMap } from "@/game/meeting-map-normalization";
import { effectiveMapSpawn } from "@/lib/effective-map-spawn";
import { parseDbJson } from "@/lib/db-json";

/**
 * Channel creation takes only an environment ID, without the `map_templates` table.
 *
 * The server builds the layout with `buildOfficeEnvironment(environmentId)` and stores a copy on the channel.
 * The stored result must match what the old template path (`ensureOfficeEnvironmentTemplate` → `mapTemplateId`)
 * left behind — `map_data` passed through `normalizeMeetingMap`, and a `map_config` with the four keys
 * cols, rows, spawnCol, spawnRow.
 *
 * Kept outside the `[id]` segment (at the channel API root) — the node test runner mistakes `[id]` for a character
 * class and misses the *.test.ts inside it.
 */
setupThrowawaySqlite("channel-create-environment-test");

async function seedGroupAdmin() {
  const user = await seedUser("channel-create");
  const { db, groups, groupMembers } = await import("@/db");
  const [group] = await db
    .insert(groups)
    .values({
      name: "Default",
      slug: `default-${user.id.slice(0, 8)}`,
      description: "channel create test workspace",
      isDefault: true,
      createdBy: user.id,
    })
    .returning();
  await db.insert(groupMembers).values({ groupId: group.id, userId: user.id, role: "group_admin" });
  return { userId: user.id, groupId: group.id };
}

async function createChannel(userId: string, body: Record<string, unknown>) {
  const { POST } = await import("./route");
  const response = await POST(
    new NextRequest("http://localhost/api/channels", {
      method: "POST",
      headers: authHeaders(userId),
      body: JSON.stringify(body),
    }),
  );
  return { response, body: (await response.json()) as Record<string, unknown> };
}

for (const environment of OFFICE_ENVIRONMENTS) {
  test(`환경 ${environment.id} 로 채널을 만들면 배치 사본과 map_config 가 저장된다`, async () => {
    const { userId, groupId } = await seedGroupAdmin();

    const { response, body } = await createChannel(userId, {
      name: `${environment.nameKo} 사무실`,
      isPublic: true,
      groupId,
      environmentId: environment.id,
    });
    assert.equal(response.status, 201, JSON.stringify(body));
    const created = body.channel as { id: string };

    const { db, channels, chatRooms } = await import("@/db");
    const { and, eq } = await import("drizzle-orm");
    const [row] = await db
      .select({ mapData: channels.mapData, mapConfig: channels.mapConfig })
      .from(channels)
      .where(eq(channels.id, created.id));

    // The same computation as the old template path: environment layout → actual entrance spawn → normalizeMeetingMap.
    const map = buildOfficeEnvironment(environment.id);
    const spawn = effectiveMapSpawn(map);
    assert.ok(spawn, "환경 배치에는 spawn 이 있다");
    const expected = normalizeMeetingMap(map, { spawnCol: spawn.col, spawnRow: spawn.row });

    assert.deepEqual(parseDbJson(row.mapData), expected.mapData);
    assert.deepEqual(parseDbJson(row.mapConfig), {
      cols: map.width,
      rows: map.height,
      spawnCol: spawn.col,
      spawnRow: spawn.row,
    });

    // Hard gate: exactly one kind=office room per channel.
    const offices = await db
      .select({ id: chatRooms.id })
      .from(chatRooms)
      .where(and(eq(chatRooms.channelId, created.id), eq(chatRooms.kind, "office")));
    assert.equal(offices.length, 1);
  });
}

test("without environmentId it is 400 environment_required", async () => {
  const { userId, groupId } = await seedGroupAdmin();
  const { response, body } = await createChannel(userId, {
    name: "환경 없음",
    isPublic: true,
    groupId,
  });
  assert.equal(response.status, 400);
  assert.equal(body.errorCode, "environment_required");
});

test("an unknown environmentId is 400 environment_unknown", async () => {
  const { userId, groupId } = await seedGroupAdmin();
  const { response, body } = await createChannel(userId, {
    name: "미상 환경",
    isPublic: true,
    groupId,
    environmentId: "moon-base",
  });
  assert.equal(response.status, 400);
  assert.equal(body.errorCode, "environment_unknown");
});

test("sending mapTemplateId is 400 map_template_removed — rejected even when an environment ID comes along", async () => {
  const { userId, groupId } = await seedGroupAdmin();
  const { response, body } = await createChannel(userId, {
    name: "옛 계약",
    isPublic: true,
    groupId,
    environmentId: "trading",
    mapTemplateId: "template-trading",
  });
  assert.equal(response.status, 400);
  assert.equal(body.errorCode, "map_template_removed");

  const { db, channels } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  const rows = await db
    .select({ id: channels.id })
    .from(channels)
    .where(eq(channels.ownerId, userId));
  assert.equal(rows.length, 0, "거부된 요청은 채널을 만들지 않는다");
});
