// The body of the attention-inbox REST endpoint. A fake plugin server + a throwaway SQLite.
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

setupThrowawaySqlite("attention-routes-test");

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
  const owner = await seedUser(`att-${Math.random().toString(36).slice(2, 8)}`);
  const gateway = await seedGateway(owner.id, server.baseUrl);
  const channel = await seedChannel(owner.id, "판단 채널");
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

const get = (userId: string, channelId: string) =>
  new NextRequest(`http://localhost/api/channels/${channelId}/attention`, {
    headers: authHeaders(userId),
  });

test("with nothing there, the list is empty and the count is 0", async () => {
  const { ownerId, channelId } = await seedCtx();
  const { getAttentionInbox } = await import("@/lib/attention-routes");
  const res = await getAttentionInbox(get(ownerId, channelId), channelId);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.rows, []);
  assert.equal(body.counts.total, 0);
});

test("items awaiting approval collect into one row and are also counted", async () => {
  const { ctx, ownerId, channelId } = await seedCtx();
  const { createApprovalBatch } = await import("@/lib/approvals");
  const batch = await createApprovalBatch(ctx, {
    type: "task_execution",
    title: "2건 수행할까요?",
    requestedBy: "sophie",
    source: { kind: "meeting", id: "m1" },
    items: [{ title: "가" }, { title: "나" }],
  });
  assert.ok(batch.ok);

  const { getAttentionInbox } = await import("@/lib/attention-routes");
  const body = await (await getAttentionInbox(get(ownerId, channelId), channelId)).json();
  assert.equal(body.rows.length, 1, "카드 둘이 승인 한 줄로 모인다");
  assert.equal(body.rows[0].kind, "approval");
  assert.equal(body.rows[0].count, 2);
  assert.equal(body.counts.awaiting_approval, 2, "수는 카드 단위다");
  assert.equal(body.counts.blocked, 0, "승인 대기가 '막힘' 으로 이중 계상되면 안 된다");
});

test("a decided approval drops out of the list", async () => {
  const { ctx, ownerId, channelId } = await seedCtx();
  const { createApprovalBatch } = await import("@/lib/approvals");
  const batch = await createApprovalBatch(ctx, {
    type: "task_execution",
    title: "1건",
    requestedBy: "sophie",
    source: { kind: "meeting", id: "m2" },
    items: [{ title: "가" }],
  });
  assert.ok(batch.ok);
  if (!batch.ok) return;

  const { decideApproval } = await import("@/lib/approval-routes");
  await decideApproval(
    new NextRequest(`http://localhost/x`, {
      method: "POST",
      headers: authHeaders(ownerId),
      body: JSON.stringify({ decision: "approve" }),
    }),
    channelId,
    batch.approvalId,
  );

  const { getAttentionInbox } = await import("@/lib/attention-routes");
  const body = await (await getAttentionInbox(get(ownerId, channelId), channelId)).json();
  assert.deepEqual(body.rows, [], "결정했으면 더 이상 사람이 할 일이 아니다");
});

test("a non-member can't see the list", async () => {
  const { channelId } = await seedCtx();
  const stranger = await seedUser(`out-${Math.random().toString(36).slice(2, 8)}`);
  const { getAttentionInbox } = await import("@/lib/attention-routes");
  const res = await getAttentionInbox(get(stranger.id, channelId), channelId);
  assert.ok(res.status === 403 || res.status === 404, `got ${res.status}`);
});

test("401 when not logged in", async () => {
  const { channelId } = await seedCtx();
  const { getAttentionInbox } = await import("@/lib/attention-routes");
  const res = await getAttentionInbox(new NextRequest(`http://localhost/x`), channelId);
  assert.equal(res.status, 401);
});

test("a blocked unattended run is a row only for its audience; the allowlist action needs the owner and a pattern key", async () => {
  const { ownerId, channelId } = await seedCtx();
  const member = await seedUser(`att-m-${Math.random().toString(36).slice(2, 8)}`);
  const { db, channelMembers } = await import("@/db");
  await db.insert(channelMembers).values({ channelId, userId: member.id });
  const { ensureOfficeRoom, appendRoomMessage } = await import("@/lib/chat-rooms");
  const office = await ensureOfficeRoom(channelId, ownerId);
  const notice = (audience: string, extra: Record<string, unknown> = {}) => ({
    kind: "approval_blocked" as const,
    audience,
    npcId: "npc-1",
    npcName: "Sophie",
    source: "cron" as const,
    blockKind: "command" as const,
    tool: "terminal",
    jobId: "job-1",
    jobName: "Nightly cleanup",
    command: "rm -r /tmp/probe",
    patternKey: "recursive delete",
    ...extra,
  });
  const post = (n: ReturnType<typeof notice>) =>
    appendRoomMessage({
      roomId: office.id,
      senderKind: "system",
      senderId: null,
      senderName: "Sophie",
      content: n.command ?? n.tool,
      notice: n,
    });
  const forOwner = await post(notice(ownerId));
  await post(
    notice(member.id, {
      blockKind: "mcp",
      command: undefined,
      patternKey: undefined,
      mcpServer: "notes",
      tool: "write_note",
    }),
  );
  await post(
    notice(ownerId, {
      resolved: { allowlisted: "recursive delete", by: ownerId, at: "2026-09-25T00:00:00Z" },
    }),
  );

  const { getAttentionInbox } = await import("@/lib/attention-routes");
  const ownerRows = (await (await getAttentionInbox(get(ownerId, channelId), channelId)).json())
    .rows as Array<Record<string, unknown>>;
  const ownerBlocked = ownerRows.filter((r) => r.kind === "approval_blocked");
  assert.equal(ownerBlocked.length, 1, "someone else's and a resolved notice are not rows");
  assert.equal(ownerBlocked[0].id, forOwner.id);
  assert.equal(ownerBlocked[0].title, "Nightly cleanup");
  assert.deepEqual(ownerBlocked[0], {
    kind: "approval_blocked",
    id: forOwner.id,
    title: "Nightly cleanup",
    at: ownerBlocked[0].at,
    requestedBy: null,
    count: 1,
    messageId: forOwner.id,
    npcId: "npc-1",
    npcName: "Sophie",
    source: "cron",
    blockKind: "command",
    tool: "terminal",
    command: "rm -r /tmp/probe",
    patternKey: "recursive delete",
    patternDescription: null,
    mcpServer: null,
    jobName: "Nightly cleanup",
    taskTitle: null,
    subtitle: "rm -r /tmp/probe",
    canAllowlist: true,
  });

  const memberRows = (await (await getAttentionInbox(get(member.id, channelId), channelId)).json())
    .rows as Array<Record<string, unknown>>;
  const memberBlocked = memberRows.filter((r) => r.kind === "approval_blocked");
  assert.equal(memberBlocked.length, 1);
  // An MCP block's subtitle is the MCP tool; a member is not the gateway owner.
  assert.equal(memberBlocked[0].subtitle, "write_note");
  assert.equal(memberBlocked[0].tool, "write_note");
  assert.equal(memberBlocked[0].patternKey, null);
  assert.equal(memberBlocked[0].canAllowlist, false);
});
