import test from "node:test";
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
import {
  PanelSourceError,
  readBadges,
  markTabSeen,
  type BadgeDeps,
  type PanelReadRow,
  type PanelTab,
} from "@/lib/npc-panel-reads";

// T-badges. Badges for the `cards`·`cron` tabs of an employee chat window.
//
// The calculation is a pure function (`npc-panel-reads-count.ts`); what's pinned down here is
// the composition: which badge survives when a given fetch fails, and what each tab writes. The
// route cases only cover the gate (non-member 403) and body validation (unknown tab 400) — a
// channel with no gateway must still return 200, so no plugin setup is needed.
setupThrowawaySqlite("npc-panel-reads-test");

const target = { channelId: "c1", userId: "u1", npcId: "n1" };

function gateError(status: number, code: string): PanelSourceError {
  return new PanelSourceError(status, code);
}

type Written = { seenAt?: Date; seenIds?: string[] };

function stubDeps(opts: {
  assignedIds?: string[];
  seenIds?: string[];
  cronTimes?: string[];
  cronSeenAt?: string | null;
  boardError?: PanelSourceError;
  cronError?: PanelSourceError;
}): BadgeDeps & { written: Written } {
  const written: Written = {};
  return {
    written,
    async loadAssignedCardIds() {
      if (opts.boardError) throw opts.boardError;
      return opts.assignedIds ?? [];
    },
    async loadCronNoticeTimes() {
      if (opts.cronError) throw opts.cronError;
      return opts.cronTimes ?? [];
    },
    async loadPanelRead(_t, tab: PanelTab): Promise<PanelReadRow | null> {
      if (tab === "cards") return { seenAt: null, seenIds: opts.seenIds ?? [] };
      return { seenAt: opts.cronSeenAt ?? null, seenIds: [] };
    },
    async savePanelRead(_t, _tab, patch) {
      written.seenAt = patch.seenAt;
      written.seenIds = patch.seenIds;
    },
    now: () => new Date("2026-09-21T12:00:00.000Z"),
  };
}

test("the badge counts unseen assigned cards and cron entries after seenAt", async () => {
  const deps = stubDeps({
    assignedIds: ["a", "b", "c"],
    seenIds: ["a"],
    cronTimes: ["2026-09-20T00:00:00Z", "2026-09-22T00:00:00Z"],
    cronSeenAt: "2026-09-21T00:00:00Z",
  });
  assert.deepEqual(await readBadges(target, deps), { cards: 2, cron: 1 });
});

test("with no read record, everything is unread", async () => {
  const deps = stubDeps({
    assignedIds: ["a"],
    seenIds: [],
    cronTimes: ["2026-09-20T00:00:00Z"],
    cronSeenAt: null,
  });
  assert.deepEqual(await readBadges(target, deps), { cards: 1, cron: 1 });
});

test("reading the cards tab marks all currently assigned cards seen and prunes old ids", async () => {
  const deps = stubDeps({ assignedIds: ["a", "b"], seenIds: ["옛것"] });
  await markTabSeen({ ...target, tab: "cards" }, deps);
  assert.deepEqual(deps.written.seenIds!.sort(), ["a", "b"]);
});

test("reading the cron tab only bumps seen_at and doesn't write seen_ids", async () => {
  const deps = stubDeps({});
  await markTabSeen({ ...target, tab: "cron" }, deps);
  assert.equal(deps.written.seenIds, undefined);
  assert.ok(deps.written.seenAt);
});

test("if the board can't be fetched, the card badge is 0 but the cron badge still counts normally", async () => {
  const deps = stubDeps({
    boardError: gateError(428, "plugin_required"),
    cronTimes: ["2026-09-20T00:00:00Z"],
    cronSeenAt: null,
  });
  assert.deepEqual(await readBadges(target, deps), { cards: 0, cron: 1 });
});

test("if the board can't be fetched, reading the cards tab keeps the previous record", async () => {
  const deps = stubDeps({ boardError: gateError(503, "board_unavailable"), seenIds: ["a"] });
  await markTabSeen({ ...target, tab: "cards" }, deps);
  assert.deepEqual(deps.written.seenIds, ["a"]);
});

// --- Route -------------------------------------------------------------------

type Routes = typeof import("@/app/api/channels/[id]/npcs/[npcId]/panel-reads/route");

async function loadRoute(): Promise<Routes> {
  return import("@/app/api/channels/[id]/npcs/[npcId]/panel-reads/route");
}

function req(channelId: string, userId: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/channels/${channelId}/npcs/n1/panel-reads`, {
    method,
    headers: authHeaders(userId),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const ctx = (id: string, npcId = "n1") => ({ params: Promise.resolve({ id, npcId }) });

test("a non-member gets 403", async () => {
  const { GET } = await loadRoute();
  const owner = await seedUser("panel-owner");
  const outsider = await seedUser("panel-outsider");
  const channel = await seedChannel(owner.id);
  const res = await GET(req(channel.id, outsider.id, "GET"), ctx(channel.id));
  assert.equal(res.status, 403);
});

test("not being logged in gets 401", async () => {
  const { GET } = await loadRoute();
  const owner = await seedUser("panel-owner");
  const channel = await seedChannel(owner.id);
  const res = await GET(
    new NextRequest(`http://localhost/api/channels/${channel.id}/npcs/n1/panel-reads`),
    ctx(channel.id),
  );
  assert.equal(res.status, 401);
});

test("an unknown tab value gets 400", async () => {
  const { POST } = await loadRoute();
  const owner = await seedUser("panel-owner");
  const channel = await seedChannel(owner.id);
  const res = await POST(req(channel.id, owner.id, "POST", { tab: "무엇" }), ctx(channel.id));
  assert.equal(res.status, 400);
});

// --- Badge reads don't provision a board ------------------------------------
//
// Badges are polled periodically. Routing this through `resolveKanbanChannelContext` (the main
// path) would repeatedly send board-creation requests to Hermes via `requireBoardRow` →
// `ensureChannelBoard` — a remote write the user never asked for. So a read-only branch is used
// instead. This test pins that down with what the fake plugin server received and the
// `channel_kanban_boards` row.
test("badge reads don't provision a board, and with no link, cards is 0 while cron still counts normally", async () => {
  const { GET } = await loadRoute();
  const { startFakePluginServer } = await import("@/lib/hermes/fake-plugin-server");
  const { db, channelKanbanBoards, chatRoomMessages, chatRooms } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  const { bindGatewayToChannel } = await import("@/lib/gateway-resources");

  const server = await startFakePluginServer({
    ownerToken: "gateway-owner-key-1234567890",
    profileTokens: { sophie: "profile-key-1234567890" },
  });
  try {
    const owner = await seedUser("panel-owner");
    const gateway = await seedGateway(owner.id, server.baseUrl);
    const channel = await seedChannel(owner.id);
    await bindGatewayToChannel({
      channelId: channel.id,
      gatewayId: gateway.id,
      boundByUserId: owner.id,
    });
    const profile = await seedHermesProfile(gateway.id, { profileName: "sophie" });
    const npc = await seedNpc({ channelId: channel.id, hermesProfileId: profile.id });

    // Delete the link row the binding created — this makes "a channel with no board link."
    await db.delete(channelKanbanBoards).where(eq(channelKanbanBoards.channelId, channel.id));

    // One cron-result notice left by this NPC.
    const [room] = await db
      .insert(chatRooms)
      .values({
        channelId: channel.id,
        kind: "office",
        name: "사무실",
        replyPolicy: "mention",
        createdBy: owner.id,
      })
      .returning();
    await db.insert(chatRoomMessages).values({
      roomId: room.id,
      senderKind: "npc",
      senderId: npc.id,
      senderName: "sophie",
      content: "결과",
      noticeJson: JSON.stringify({
        kind: "cron_result",
        jobId: "j1",
        jobName: "일일 보고",
        npcName: "sophie",
        status: "ok",
      }),
    });

    const before = server.requests().length;
    const res = await GET(
      req(channel.id, owner.id, "GET"),
      ctx(channel.id, npc.id) as ReturnType<typeof ctx>,
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { cards: 0, cron: 1 });

    // No board-creation request went out.
    const sent = server.requests().slice(before);
    assert.deepEqual(
      sent.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path}`),
      [],
    );
    assert.deepEqual(
      sent.filter((r) => r.path.includes("kanban/boards")).map((r) => `${r.method} ${r.path}`),
      [],
    );
    // The link row wasn't revived either.
    const rows = await db
      .select({ channelId: channelKanbanBoards.channelId })
      .from(channelKanbanBoards)
      .where(eq(channelKanbanBoards.channelId, channel.id));
    assert.equal(rows.length, 0);
  } finally {
    await server.close();
  }
});
