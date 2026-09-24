// The body of the approval-decision REST endpoint. Runs end to end with a fake plugin server + a throwaway SQLite.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import {
  authHeaders,
  seedChannel,
  seedGateway,
  seedHermesProfile,
  seedNpc,
  seedUser,
  setupThrowawaySqlite,
} from "@/test-setup/npc-seed";
import { startFakePluginServer, type FakePluginServer } from "@/lib/hermes/fake-plugin-server";

setupThrowawaySqlite("approval-routes-test");

let server: FakePluginServer;

before(async () => {
  server = await startFakePluginServer({
    ownerToken: "gateway-owner-key-1234567890",
    profileTokens: { sophie: "profile-key-1234567890" },
  });
});
after(async () => {
  await server.close();
});

async function seedCtx() {
  const owner = await seedUser(`dec-${Math.random().toString(36).slice(2, 8)}`);
  const gateway = await seedGateway(owner.id, server.baseUrl);
  const channel = await seedChannel(owner.id, "결정 채널");
  const { bindGatewayToChannel } = await import("@/lib/gateway-resources");
  await bindGatewayToChannel({
    channelId: channel.id,
    gatewayId: gateway.id,
    boundByUserId: owner.id,
  });
  const profile = await seedHermesProfile(gateway.id, { profileName: "sophie" });
  await seedNpc({ channelId: channel.id, hermesProfileId: profile.id, positionX: 0, positionY: 0 });
  const { resolveKanbanChannelContext } = await import("@/lib/kanban-access");
  const resolved = await resolveKanbanChannelContext({ userId: owner.id, channelId: channel.id });
  assert.ok(resolved.ok);
  return { ctx: resolved.ctx, ownerId: owner.id, channelId: channel.id };
}

async function makeApproval(ctx: Awaited<ReturnType<typeof seedCtx>>["ctx"], titles: string[]) {
  const { createApprovalBatch } = await import("@/lib/approvals");
  const result = await createApprovalBatch(ctx, {
    type: "task_execution",
    title: `${titles.length}건 수행할까요?`,
    requestedBy: "sophie",
    source: { kind: "meeting", id: `m-${Math.random().toString(36).slice(2, 8)}` },
    items: titles.map((title) => ({ title })),
  });
  assert.ok(result.ok);
  if (!result.ok) throw new Error("unreachable");
  return result;
}

function post(userId: string, channelId: string, approvalId: string, body: unknown) {
  return new NextRequest(
    `http://localhost/api/channels/${channelId}/approvals/${approvalId}/decide`,
    { method: "POST", headers: authHeaders(userId), body: JSON.stringify(body) },
  );
}

test("approving unblocks every target card", async () => {
  const { ctx, ownerId, channelId } = await seedCtx();
  const batch = await makeApproval(ctx, ["가", "나"]);
  const { decideApproval } = await import("@/lib/approval-routes");
  const res = await decideApproval(
    post(ownerId, channelId, batch.approvalId, { decision: "approve" }),
    channelId,
    batch.approvalId,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "approved");
  assert.equal(body.unblocked.length, 2);
  for (const id of batch.taskIds) {
    const task = await ctx.client.kanban.getTask(ctx.boardSlug, id!);
    assert.ok(task.ok);
    assert.notEqual(task.data.task.status, "blocked", "승인했으면 더 이상 막혀 있으면 안 된다");
  }
});

test("deciding makes the room's approval-request line report the result — the button doesn't stay", async () => {
  const { ctx, ownerId, channelId } = await seedCtx();
  const batch = await makeApproval(ctx, ["가"]);
  const { decideApproval } = await import("@/lib/approval-routes");
  const res = await decideApproval(
    post(ownerId, channelId, batch.approvalId, { decision: "approve" }),
    channelId,
    batch.approvalId,
  );
  assert.equal(res.status, 200);

  const { ensureOfficeRoom, recentRoomMessages } = await import("@/lib/chat-rooms");
  const room = await ensureOfficeRoom(channelId, ownerId);
  const notice = (await recentRoomMessages(room.id, 20))
    .map((m) => m.notice)
    .find((n) => n?.kind === "approval_requested" && n.approvalId === batch.approvalId);
  assert.ok(notice && notice.kind === "approval_requested");
  if (!notice || notice.kind !== "approval_requested") return;
  assert.equal(notice.resolved?.decision, "approved");
  assert.equal(notice.resolved?.by, ownerId);
});

test("rejecting unblocks nothing and the card stays blocked", async () => {
  const { ctx, ownerId, channelId } = await seedCtx();
  const batch = await makeApproval(ctx, ["가"]);
  const { decideApproval } = await import("@/lib/approval-routes");
  const res = await decideApproval(
    post(ownerId, channelId, batch.approvalId, { decision: "reject", note: "범위가 넓습니다" }),
    channelId,
    batch.approvalId,
  );
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).unblocked, []);
  const task = await ctx.client.kanban.getTask(ctx.boardSlug, batch.taskIds[0]!);
  assert.ok(task.ok);
  assert.equal(task.data.task.status, "blocked", "단테 결정: 반려해도 카드는 남는다");
});

test("a second decision is 409 — clicking from two tabs, only one wins", async () => {
  const { ctx, ownerId, channelId } = await seedCtx();
  const batch = await makeApproval(ctx, ["가"]);
  const { decideApproval } = await import("@/lib/approval-routes");
  const first = await decideApproval(
    post(ownerId, channelId, batch.approvalId, { decision: "approve" }),
    channelId,
    batch.approvalId,
  );
  assert.equal(first.status, 200);
  const second = await decideApproval(
    post(ownerId, channelId, batch.approvalId, { decision: "reject" }),
    channelId,
    batch.approvalId,
  );
  assert.equal(second.status, 409);
  assert.equal((await second.json()).code, "approval_already_decided");
});

test("an approval id from another channel is 404 — existence doesn't leak", async () => {
  const a = await seedCtx();
  const b = await seedCtx();
  const batch = await makeApproval(a.ctx, ["가"]);
  const { decideApproval } = await import("@/lib/approval-routes");
  const res = await decideApproval(
    post(b.ownerId, b.channelId, batch.approvalId, { decision: "approve" }),
    b.channelId,
    batch.approvalId,
  );
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, "approval_not_found");
});

test("401 when not logged in", async () => {
  const { ctx, channelId } = await seedCtx();
  const batch = await makeApproval(ctx, ["가"]);
  const { decideApproval } = await import("@/lib/approval-routes");
  const req = new NextRequest(`http://localhost/x`, {
    method: "POST",
    body: JSON.stringify({ decision: "approve" }),
  });
  const res = await decideApproval(req, channelId, batch.approvalId);
  assert.equal(res.status, 401);
});

test("an invalid decision value is 400 and the approval stays pending", async () => {
  const { ctx, ownerId, channelId } = await seedCtx();
  const batch = await makeApproval(ctx, ["가"]);
  const { decideApproval } = await import("@/lib/approval-routes");
  const res = await decideApproval(
    post(ownerId, channelId, batch.approvalId, { decision: "unblock" }),
    channelId,
    batch.approvalId,
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "invalid_decision");

  const { pendingApprovalTaskIds } = await import("@/lib/approvals");
  assert.equal(
    (await pendingApprovalTaskIds(channelId)).size,
    1,
    "거절된 요청이 상태를 바꾸면 안 된다",
  );
});

test("targeting a card outside this approval is 400 and unblocks nothing", async () => {
  const { ctx, ownerId, channelId } = await seedCtx();
  const batch = await makeApproval(ctx, ["가"]);
  const { decideApproval } = await import("@/lib/approval-routes");
  const res = await decideApproval(
    post(ownerId, channelId, batch.approvalId, {
      decision: "approve",
      targets: [{ task_id: "ghost", decision: "approve" }],
    }),
    channelId,
    batch.approvalId,
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "target_not_in_approval");
  const task = await ctx.client.kanban.getTask(ctx.boardSlug, batch.taskIds[0]!);
  assert.ok(task.ok);
  assert.equal(task.data.task.status, "blocked");
});

test("a partial rejection blocks only that card and unblocks the rest", async () => {
  const { ctx, ownerId, channelId } = await seedCtx();
  const batch = await makeApproval(ctx, ["가", "나"]);
  const { decideApproval } = await import("@/lib/approval-routes");
  const res = await decideApproval(
    post(ownerId, channelId, batch.approvalId, {
      decision: "approve",
      targets: [{ task_id: batch.taskIds[0]!, decision: "reject" }],
    }),
    channelId,
    batch.approvalId,
  );
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).unblocked, [batch.taskIds[1]]);
  const blocked = await ctx.client.kanban.getTask(ctx.boardSlug, batch.taskIds[0]!);
  assert.ok(blocked.ok);
  assert.equal(blocked.data.task.status, "blocked");
});

test("requesting revision unblocks nothing and leaves the note as a card comment", async () => {
  const { ctx, ownerId, channelId } = await seedCtx();
  const batch = await makeApproval(ctx, ["가"]);
  const { decideApproval } = await import("@/lib/approval-routes");
  const res = await decideApproval(
    post(ownerId, channelId, batch.approvalId, {
      decision: "request_revision",
      note: "완료 조건을 적어 주세요",
    }),
    channelId,
    batch.approvalId,
  );
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, "revision_requested");
  const task = await ctx.client.kanban.getTask(ctx.boardSlug, batch.taskIds[0]!);
  assert.ok(task.ok);
  assert.equal(task.data.task.status, "blocked");
  assert.equal(task.data.comments?.length, 1, "고쳐 달라는 말이 카드에 남아야 직원이 읽는다");
});

test("no note means no comment — an empty comment is noise", async () => {
  const { ctx, ownerId, channelId } = await seedCtx();
  const batch = await makeApproval(ctx, ["가"]);
  const { decideApproval } = await import("@/lib/approval-routes");
  await decideApproval(
    post(ownerId, channelId, batch.approvalId, { decision: "reject" }),
    channelId,
    batch.approvalId,
  );
  const task = await ctx.client.kanban.getTask(ctx.boardSlug, batch.taskIds[0]!);
  assert.ok(task.ok);
  assert.equal(task.data.comments?.length ?? 0, 0);
});

test("an unknown per-item decision value is 400 — blocked before it reaches the DB", async () => {
  // `decideTargets` is fail-closed and won't unblock a card for an unknown value, but that
  // value could still land in `approval_targets.decision`. Filtered out at the boundary.
  const { ctx, ownerId, channelId } = await seedCtx();
  const batch = await makeApproval(ctx, ["가"]);
  const { decideApproval } = await import("@/lib/approval-routes");
  const res = await decideApproval(
    post(ownerId, channelId, batch.approvalId, {
      decision: "approve",
      targets: [{ task_id: batch.taskIds[0]!, decision: "maybe" }],
    }),
    channelId,
    batch.approvalId,
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "invalid_targets");

  const { db, approvalTargets } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  const rows = await db
    .select()
    .from(approvalTargets)
    .where(eq(approvalTargets.approvalId, batch.approvalId));
  assert.equal(rows[0].decision, null, "거절된 요청이 항목 결정을 쓰면 안 된다");
});

/** Creates a second board and returns its slug — multi-board support is already shipped. */
async function makeSecondBoard(ownerId: string, channelId: string): Promise<string> {
  const routes = await import(`@/app/api/channels/[id]/projects/route`);
  const res = await routes.POST(
    new NextRequest(`http://localhost/api/channels/${channelId}/projects`, {
      method: "POST",
      headers: { ...authHeaders(ownerId), "content-type": "application/json" },
      body: JSON.stringify({ name: "둘째 프로젝트" }),
    }),
    { params: Promise.resolve({ id: channelId }) } as never,
  );
  const body = (await res.json()) as { project?: { boardSlug: string }; code?: string };
  assert.equal(res.status, 201, JSON.stringify(body));
  return body.project!.boardSlug;
}

test("approving unblocks a card even on a board other than the default one", async () => {
  // Previously, a decision always sent `unblock` to the channel's default board, so if the
  // card lived on another board it always failed with task_not_found — but the approval had
  // already closed. That left a state where approving did nothing at all.
  const { ctx, ownerId, channelId } = await seedCtx();
  const second = await makeSecondBoard(ownerId, channelId);
  assert.notEqual(second, ctx.boardSlug, "둘째 보드가 기본 보드와 같으면 이 시험이 무의미하다");

  const { createApprovalBatch } = await import("@/lib/approvals");
  const batch = await createApprovalBatch(ctx, {
    type: "task_execution",
    title: "둘째 보드의 일",
    requestedBy: "sophie",
    source: { kind: "meeting", id: "m-board" },
    boardSlug: second,
    items: [{ title: "가" }],
  });
  assert.ok(batch.ok);
  if (!batch.ok) return;

  const { decideApproval } = await import("@/lib/approval-routes");
  const res = await decideApproval(
    post(ownerId, channelId, batch.approvalId, { decision: "approve" }),
    channelId,
    batch.approvalId,
  );
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.failed, undefined, "그 보드로 갔으면 실패가 없어야 한다");
  assert.deepEqual(body.unblocked, batch.taskIds);

  const task = await ctx.client.kanban.getTask(second, batch.taskIds[0]!);
  assert.ok(task.ok);
  assert.notEqual(task.data.task.status, "blocked");
});

test("when every unblock fails, the approval is reverted and returns 502 — so it can be retried", async () => {
  const { ctx, ownerId, channelId } = await seedCtx();
  const { createApprovalBatch } = await import("@/lib/approvals");
  const batch = await createApprovalBatch(ctx, {
    type: "task_execution",
    title: "게이트웨이가 안 닿는 순간",
    requestedBy: "sophie",
    source: { kind: "meeting", id: "m-down" },
    items: [{ title: "가" }, { title: "나" }],
  });
  assert.ok(batch.ok);
  if (!batch.ok) return;

  // Makes both unblock calls fail.
  server.failNext("/deskrpg/kanban/tasks", 2);

  const { decideApproval } = await import("@/lib/approval-routes");
  const res = await decideApproval(
    post(ownerId, channelId, batch.approvalId, { decision: "approve" }),
    channelId,
    batch.approvalId,
  );
  assert.equal(res.status, 502);
  assert.equal((await res.json()).code, "unblock_failed");

  const { pendingApprovalTaskIds } = await import("@/lib/approvals");
  assert.equal(
    (await pendingApprovalTaskIds(channelId)).size,
    2,
    "되돌리지 않으면 다시 누를 pending 이 없어 사용자가 카드를 손으로 풀어야 한다",
  );
});

// Unblocking a card via approval requests one dispatch. The card-action route calls dispatch
// right after unblock, but an approval decision sends unblock directly and bypassed that rule —
// leaving the card at the mercy of the gateway's built-in dispatcher cycle, which left cards
// sitting in `ready` for about 5 minutes in staging.
function dispatchCount() {
  return server
    .requests()
    .filter((r) => r.method === "POST" && r.path.startsWith("/deskrpg/kanban/dispatch")).length;
}

async function decide(approvalId: string, ownerId: string, channelId: string, body: unknown) {
  const { decideApproval } = await import("@/lib/approval-routes");
  return decideApproval(post(ownerId, channelId, approvalId, body), channelId, approvalId);
}

test("unblocking a card via approval requests one dispatch", async () => {
  const { ctx, ownerId, channelId } = await seedCtx();
  const batch = await makeApproval(ctx, ["가", "나"]);
  const before = dispatchCount();
  const res = await decide(batch.approvalId, ownerId, channelId, { decision: "approve" });
  assert.equal(res.status, 200);
  assert.equal(dispatchCount() - before, 1, "카드 두 장이어도 디스패치는 한 번이다");
});

test("rejecting/requesting revision unblocks nothing, so it never dispatches", async () => {
  const { ctx, ownerId, channelId } = await seedCtx();
  for (const decision of ["reject", "request_revision"]) {
    const batch = await makeApproval(ctx, [`${decision}-가`]);
    const before = dispatchCount();
    await decide(batch.approvalId, ownerId, channelId, { decision });
    assert.equal(dispatchCount() - before, 0, `${decision} 뒤에 디스패치가 나갔다`);
  }
});

test("when every unblock fails, it never dispatches", async () => {
  const { ctx, ownerId, channelId } = await seedCtx();
  const batch = await makeApproval(ctx, ["가"]);
  server.failNext("/deskrpg/kanban/tasks", 1);
  const before = dispatchCount();
  const res = await decide(batch.approvalId, ownerId, channelId, { decision: "approve" });
  assert.equal(res.status, 502);
  assert.equal(dispatchCount() - before, 0);
});

test("even if dispatch fails, the approval still succeeds — the built-in dispatcher takes over", async () => {
  const { ctx, ownerId, channelId } = await seedCtx();
  const batch = await makeApproval(ctx, ["가"]);
  server.failNext("/deskrpg/kanban/dispatch", 1);
  const res = await decide(batch.approvalId, ownerId, channelId, { decision: "approve" });
  assert.equal(res.status, 200);
});
