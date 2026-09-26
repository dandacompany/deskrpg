// The entry point for the pre-execution approval gate. Runs end to end with a fake plugin
// server + a throwaway SQLite.
//
// What's pinned down here: cards land in `blocked`, an in-batch precedent gets wired up by
// id, a partial failure doesn't block the rest, a failed precedent means its child is **not
// created**, and if not a single card can be created, no approval is created either.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";

import {
  seedChannel,
  seedGateway,
  seedHermesProfile,
  seedNpc,
  seedUser,
  setupThrowawaySqlite,
} from "@/test-setup/npc-seed";
import { startFakePluginServer, type FakePluginServer } from "@/lib/hermes/fake-plugin-server";

setupThrowawaySqlite("approvals-test");

const OWNER_TOKEN = "gateway-owner-key-1234567890";

let server: FakePluginServer;

before(async () => {
  server = await startFakePluginServer({
    ownerToken: OWNER_TOKEN,
    profileTokens: { sophie: "profile-key-1234567890" },
  });
});

after(async () => {
  await server.close();
});

async function seedCtx() {
  const owner = await seedUser(`appr-${Math.random().toString(36).slice(2, 8)}`);
  const gateway = await seedGateway(owner.id, server.baseUrl);
  const channel = await seedChannel(owner.id, "승인 채널");
  const { bindGatewayToChannel } = await import("@/lib/gateway-resources");
  await bindGatewayToChannel({
    channelId: channel.id,
    gatewayId: gateway.id,
    boundByUserId: owner.id,
  });
  const profile = await seedHermesProfile(gateway.id, {
    profileName: "sophie",
    displayName: "소피",
  });
  const npc = await seedNpc({
    channelId: channel.id,
    hermesProfileId: profile.id,
    positionX: 0,
    positionY: 0,
  });
  const { resolveKanbanChannelContext } = await import("@/lib/kanban-access");
  const resolved = await resolveKanbanChannelContext({
    userId: owner.id,
    channelId: channel.id,
  });
  assert.ok(resolved.ok, "칸반 컨텍스트를 풀지 못했습니다");
  return { ctx: resolved.ctx, npcId: npc.id, channelId: channel.id, ownerId: owner.id };
}

const source = { kind: "meeting" as const, id: "m1" };

test("cards land in blocked and are all bundled into one approval", async () => {
  const { ctx, npcId, channelId } = await seedCtx();
  const { createApprovalBatch, pendingApprovalTaskIds } = await import("@/lib/approvals");
  const result = await createApprovalBatch(ctx, {
    type: "task_execution",
    title: "3건 수행할까요?",
    requestedBy: "sophie",
    source,
    items: [{ title: "가", npcId }, { title: "나" }, { title: "다" }],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.taskIds.filter(Boolean).length, 3);
  assert.equal(result.failed, undefined);

  for (const id of result.taskIds) {
    const res = await ctx.client.kanban.getTask(ctx.boardSlug, id!);
    assert.ok(res.ok);
    assert.equal(res.data.task.status, "blocked", "승인 전에는 디스패치되면 안 된다");
  }
  const created = server
    .requests()
    .filter((r) => r.method === "POST" && r.path.startsWith("/deskrpg/kanban/tasks?"));
  assert.ok(created.length >= 3);
  for (const request of created.slice(-3))
    assert.deepEqual((request.json as Record<string, unknown>).review_policy, {
      version: 1,
      mode: "human",
      reviewer_profile: null,
    });
  const pending = await pendingApprovalTaskIds(channelId);
  assert.equal(pending.size, 3);
});

test("an in-batch precedent given by index gets wired up by id", async () => {
  const { ctx } = await seedCtx();
  const { createApprovalBatch } = await import("@/lib/approvals");
  // 0 has 1 as its precedent — 1 must be created first.
  const result = await createApprovalBatch(ctx, {
    type: "task_execution",
    title: "선행 있는 묶음",
    requestedBy: "sophie",
    source,
    items: [{ title: "나중", parents: [1] }, { title: "먼저" }],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const later = await ctx.client.kanban.getTask(ctx.boardSlug, result.taskIds[0]!);
  assert.ok(later.ok);
  assert.equal(
    later.data.task.link_counts?.parents,
    1,
    "뒤 항목이 앞 항목을 부모로 갖고 있어야 한다",
  );
});

test("a cyclic precedent creates not a single card", async () => {
  const { ctx } = await seedCtx();
  const { createApprovalBatch } = await import("@/lib/approvals");
  const result = await createApprovalBatch(ctx, {
    type: "task_execution",
    title: "순환",
    requestedBy: "sophie",
    source,
    items: [
      { title: "가", parents: [1] },
      { title: "나", parents: [0] },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.errorCode, "parent_cycle");
});

test("if the assignee isn't an NPC in this channel, only that line fails and the rest are created", async () => {
  const { ctx } = await seedCtx();
  const { createApprovalBatch } = await import("@/lib/approvals");
  const result = await createApprovalBatch(ctx, {
    type: "task_execution",
    title: "일부 실패",
    requestedBy: "sophie",
    source,
    items: [{ title: "가", npcId: "00000000-0000-4000-8000-000000000000" }, { title: "나" }],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.taskIds[0], null);
  assert.ok(result.taskIds[1]);
  assert.deepEqual(result.failed, [{ index: 0, errorCode: "assignee_not_in_channel" }]);
});

test("if a precedent fails, its child is not created — never leave a card waiting on a parent that will never unblock", async () => {
  const { ctx } = await seedCtx();
  const { createApprovalBatch } = await import("@/lib/approvals");
  const result = await createApprovalBatch(ctx, {
    type: "task_execution",
    title: "선행 실패",
    requestedBy: "sophie",
    source,
    items: [
      { title: "선행", npcId: "00000000-0000-4000-8000-000000000000" },
      { title: "자식", parents: [0] },
      { title: "무관" },
    ],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.taskIds[0], null);
  assert.equal(result.taskIds[1], null, "부모가 없으면 자식도 만들지 않는다");
  assert.ok(result.taskIds[2], "관계 없는 줄은 만들어진다");
  assert.deepEqual(result.failed, [
    { index: 0, errorCode: "assignee_not_in_channel" },
    { index: 1, errorCode: "parent_failed" },
  ]);
});

test("if not a single card can be created, no approval is created either — an approval with nothing to click is noise", async () => {
  const { ctx, channelId } = await seedCtx();
  const { createApprovalBatch, pendingApprovalTaskIds } = await import("@/lib/approvals");
  const result = await createApprovalBatch(ctx, {
    type: "task_execution",
    title: "전부 실패",
    requestedBy: "sophie",
    source,
    items: [{ title: "가", npcId: "00000000-0000-4000-8000-000000000000" }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.errorCode, "no_tasks_created");
  assert.equal((await pendingApprovalTaskIds(channelId)).size, 0);
});

test("same idempotency key means a retry doesn't add more cards", async () => {
  const { ctx } = await seedCtx();
  const { createApprovalBatch } = await import("@/lib/approvals");
  const input = {
    type: "task_execution",
    title: "재시도",
    requestedBy: "sophie",
    source,
    items: [{ title: "한 번만", idempotencyKey: "meeting:m9:0" }],
  };
  const first = await createApprovalBatch(ctx, input);
  const second = await createApprovalBatch(ctx, input);
  assert.equal(first.ok && second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(first.taskIds[0], second.taskIds[0], "같은 카드를 돌려줘야 한다");
});

test("a retry doesn't add more approval records — pending from the same source is reused", async () => {
  // Only checking whether the card ids match would hide this defect. The approval count must be checked too.
  const { ctx, channelId } = await seedCtx();
  const { createApprovalBatch } = await import("@/lib/approvals");
  const { db, approvals, approvalTargets } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  const input = {
    type: "task_execution",
    title: "재시도",
    requestedBy: "sophie",
    source: { kind: "meeting" as const, id: "m-retry" },
    items: [{ title: "한 번만", idempotencyKey: "meeting:m-retry:0" }],
  };
  const first = await createApprovalBatch(ctx, input);
  const second = await createApprovalBatch(ctx, input);
  assert.ok(first.ok && second.ok);
  if (!first.ok || !second.ok) return;
  assert.equal(second.approvalId, first.approvalId, "같은 승인을 돌려줘야 한다");

  const rows = await db.select().from(approvals).where(eq(approvals.channelId, channelId));
  assert.equal(rows.length, 1, "승인이 두 벌 생기면 하나는 영영 pending 으로 남는다");
  const targets = await db
    .select()
    .from(approvalTargets)
    .where(eq(approvalTargets.approvalId, first.approvalId));
  assert.equal(targets.length, 1);
});

test("if only some succeed on the first call, a retry adds the rest to the same approval", async () => {
  const { ctx, channelId } = await seedCtx();
  const { createApprovalBatch } = await import("@/lib/approvals");
  const { db, approvals, approvalTargets } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  const source = { kind: "meeting" as const, id: "m-partial" };
  const ghost = "00000000-0000-4000-8000-000000000000";

  const first = await createApprovalBatch(ctx, {
    type: "task_execution",
    title: "부분 성공",
    requestedBy: "sophie",
    source,
    items: [
      { title: "되는 것", idempotencyKey: "meeting:m-partial:0" },
      { title: "안 되는 것", npcId: ghost, idempotencyKey: "meeting:m-partial:1" },
    ],
  });
  assert.ok(first.ok);
  if (!first.ok) return;
  assert.equal(first.failed?.length, 1);

  // The user clicks the button again — this time without the assignee.
  const second = await createApprovalBatch(ctx, {
    type: "task_execution",
    title: "부분 성공",
    requestedBy: "sophie",
    source,
    items: [
      { title: "되는 것", idempotencyKey: "meeting:m-partial:0" },
      { title: "안 되는 것", idempotencyKey: "meeting:m-partial:1" },
    ],
  });
  assert.ok(second.ok);
  if (!second.ok) return;
  assert.equal(second.approvalId, first.approvalId);
  assert.equal(
    (await db.select().from(approvals).where(eq(approvals.channelId, channelId))).length,
    1,
  );
  const targets = await db
    .select()
    .from(approvalTargets)
    .where(eq(approvalTargets.approvalId, first.approvalId));
  assert.equal(targets.length, 2, "재시도로 붙은 카드가 같은 승인의 대상이 된다");
});

test("an approval from a different source is not reused", async () => {
  const { ctx, channelId } = await seedCtx();
  const { createApprovalBatch } = await import("@/lib/approvals");
  const { db, approvals } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  const base = { type: "task_execution", title: "다른 출처", requestedBy: "sophie" };
  const a = await createApprovalBatch(ctx, {
    ...base,
    source: { kind: "meeting" as const, id: "m-a" },
    items: [{ title: "가" }],
  });
  const b = await createApprovalBatch(ctx, {
    ...base,
    source: { kind: "meeting" as const, id: "m-b" },
    items: [{ title: "나" }],
  });
  assert.ok(a.ok && b.ok);
  if (!a.ok || !b.ok) return;
  assert.notEqual(a.approvalId, b.approvalId);
  assert.equal(
    (await db.select().from(approvals).where(eq(approvals.channelId, channelId))).length,
    2,
  );
});

test("even if the source's key order differs, it's treated as the same approval", () => {
  // `sourceJson` is a plain string match, so unless serialization is pinned to an explicit field order, this diverges.
  const a = JSON.stringify({ kind: "meeting", id: "m1" });
  const b = JSON.stringify({ kind: "meeting", id: "m1" } as const);
  assert.equal(a, b);
});

test("even if the caller changes the key order, there's still only one approval", async () => {
  const { ctx, channelId } = await seedCtx();
  const { createApprovalBatch } = await import("@/lib/approvals");
  const { db, approvals } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  const base = { type: "task_execution", title: "키 순서", requestedBy: "sophie" };
  await createApprovalBatch(ctx, {
    ...base,
    source: { kind: "meeting", id: "m-order" },
    items: [{ title: "가", idempotencyKey: "meeting:m-order:0" }],
  });
  await createApprovalBatch(ctx, {
    ...base,
    // Passes the same source with only its key order changed.
    source: JSON.parse('{"id":"m-order","kind":"meeting"}'),
    items: [{ title: "가", idempotencyKey: "meeting:m-order:0" }],
  });
  assert.equal(
    (await db.select().from(approvals).where(eq(approvals.channelId, channelId))).length,
    1,
  );
});

test("creating an approval leaves a system notice in the office room", async () => {
  const { ctx, channelId } = await seedCtx();
  const { createApprovalBatch } = await import("@/lib/approvals");
  const result = await createApprovalBatch(ctx, {
    type: "task_execution",
    title: "2건 수행할까요?",
    requestedBy: "sophie",
    source: { kind: "meeting", id: "m-notice" },
    items: [{ title: "가" }, { title: "나" }],
  });
  assert.ok(result.ok);
  if (!result.ok) return;

  const { ensureOfficeRoom, recentRoomMessages, getChannelOwnerId } =
    await import("@/lib/chat-rooms");
  const ownerId = await getChannelOwnerId(channelId);
  assert.ok(ownerId);
  const room = await ensureOfficeRoom(channelId, ownerId!);
  const messages = await recentRoomMessages(room.id, 20, null);
  const notice = messages.map((m) => m.notice).find((n) => n?.kind === "approval_requested");
  assert.ok(notice, "승인 알림이 방에 없다");
  assert.deepEqual(notice, {
    kind: "approval_requested",
    approvalId: result.approvalId,
    title: "2건 수행할까요?",
    npcName: "sophie",
    targetCount: 2,
  });
  const row = messages.find((m) => m.notice?.kind === "approval_requested");
  assert.equal(row?.senderKind, "system", "사람이 시작한 묶음도 있으므로 직원 발화로 두지 않는다");
});

test("a batch requested by a person doesn't carry an employee name in the notice", async () => {
  const { ctx, channelId } = await seedCtx();
  const { createApprovalBatch } = await import("@/lib/approvals");
  const { formatRequester } = await import("@/lib/approval-requester");
  const result = await createApprovalBatch(ctx, {
    type: "task_execution",
    title: "회의에서 나온 일",
    requestedBy: formatRequester({ kind: "user", userId: "u-1" }),
    source: { kind: "meeting", id: "m-user" },
    items: [{ title: "가" }],
  });
  assert.ok(result.ok);

  const { ensureOfficeRoom, recentRoomMessages, getChannelOwnerId } =
    await import("@/lib/chat-rooms");
  const ownerId = await getChannelOwnerId(channelId);
  const room = await ensureOfficeRoom(channelId, ownerId!);
  const messages = await recentRoomMessages(room.id, 20, null);
  const notice = messages.map((m) => m.notice).find((n) => n?.kind === "approval_requested");
  assert.ok(notice && notice.kind === "approval_requested");
  if (!notice || notice.kind !== "approval_requested") return;
  assert.equal(notice.npcName, "", "user:<id> 를 직원 이름 자리에 넣으면 안 된다");
});

test("upstream Hermes (no approval-policy contract): the batch's cards are created blocked without a policy", async () => {
  const { ctx } = await seedCtx();
  const { createApprovalBatch } = await import("@/lib/approvals");
  ctx.info = { ...ctx.info!, capabilities: ["kanban", "cron", "events"] };
  const before = server.requests().length;
  const result = await createApprovalBatch(ctx, {
    type: "task_execution",
    title: "새 업무",
    requestedBy: "sophie",
    source,
    items: [{ title: "정책 없이" }],
  });
  assert.equal(result.ok, true);
  const sent = server
    .requests()
    .slice(before)
    .filter((r) => r.method === "POST" && r.path.startsWith("/deskrpg/kanban/tasks?"));
  assert.equal(sent.length, 1);
  const json = sent[0].json as Record<string, unknown>;
  assert.equal("review_policy" in json, false);
  assert.equal(
    json.initial_status,
    "blocked",
    "the start gate still holds without a completion policy",
  );
});

test("review hooks: the batch's cards carry the human policy like on the patched core", async () => {
  const { ctx } = await seedCtx();
  const { createApprovalBatch } = await import("@/lib/approvals");
  ctx.info = { ...ctx.info!, capabilities: ["kanban", "cron", "events", "review_hooks_v1"] };
  const before = server.requests().length;
  const result = await createApprovalBatch(ctx, {
    type: "task_execution",
    title: "새 업무",
    requestedBy: "sophie",
    source,
    items: [{ title: "훅 정책" }],
  });
  assert.equal(result.ok, true);
  const [sent] = server
    .requests()
    .slice(before)
    .filter((r) => r.method === "POST" && r.path.startsWith("/deskrpg/kanban/tasks?"));
  assert.deepEqual((sent.json as Record<string, unknown>).review_policy, {
    version: 1,
    mode: "human",
    reviewer_profile: null,
  });
});
