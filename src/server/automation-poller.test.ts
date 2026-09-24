import { after, test } from "node:test";
import assert from "node:assert/strict";

import { startFakePluginServer, type FakePluginServer } from "@/lib/hermes/fake-plugin-server";
import type { RoomMessage } from "@/lib/chat-rooms-policy";
import {
  seedChannel,
  seedGateway,
  seedHermesProfile,
  seedNpc,
  seedUser,
  setupThrowawaySqlite,
} from "@/test-setup/npc-seed";
import type { PollerTimerHandle, PollerTimers } from "./automation-poller";

// T5. Poller — cursor storage, the "now" token, unknown_cursor recovery, has_more paging, last_error,
// and through the real wiring (createLiveIngestDeps), whether notice_json lands in the office room.
setupThrowawaySqlite("automation-poller-test");

const OWNER_TOKEN = "gateway-owner-key-1234567890";
const PROFILE_TOKEN = "profile-key-1234567890";

const servers: FakePluginServer[] = [];
async function startPlugin(info?: { version?: string; capabilities?: string[] }) {
  const server = await startFakePluginServer({
    ownerToken: OWNER_TOKEN,
    profileTokens: { sophie: PROFILE_TOKEN, noah: PROFILE_TOKEN },
    ...(info ? { info } : {}),
  });
  servers.push(server);
  return server;
}
after(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

type Emitted = { channelId: string; event: string; payload: unknown };

/** One channel + a gateway pointing at the fake plugin + an on-duty NPC for profile sophie. */
async function seedBoundChannel(server: FakePluginServer, opts: { npcActive?: boolean } = {}) {
  const owner = await seedUser("poller-owner");
  const gateway = await seedGateway(owner.id, server.baseUrl);
  const channel = await seedChannel(owner.id, "폴링 채널");
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
    name: "STALE",
    positionX: 0,
    positionY: 0,
    active: opts.npcActive ?? true,
  });
  return { owner, gateway, channel, profile, npc };
}

async function makeDeps(overrides: Partial<import("./automation-poller").PollOnceDeps> = {}) {
  const { createDefaultPollDeps } = await import("./automation-poller");
  const emitted: Emitted[] = [];
  const roomEmits: Array<{ roomId: string; message: RoomMessage }> = [];
  const deps = createDefaultPollDeps({
    emitChannel: (channelId, event, payload) => emitted.push({ channelId, event, payload }),
    emitRoomMessage: (roomId, message) => roomEmits.push({ roomId, message }),
  });
  return { deps: { ...deps, ...overrides }, emitted, roomEmits };
}

async function readRow(channelId: string) {
  const { getChannelBoard } = await import("@/lib/kanban-boards");
  return (await getChannelBoard(channelId))!;
}

function slugOf(channelId: string) {
  return `deskrpg-${channelId.replace(/-/g, "").toLowerCase()}`;
}

function eventPolls(server: FakePluginServer) {
  return server.requests().filter((r) => r.path.startsWith("/deskrpg/events"));
}

test("the first poll (no cursor) only stores the 'now' token and broadcasts nothing — no replay of the past", async () => {
  const plugin = await startPlugin();
  const { channel } = await seedBoundChannel(plugin);
  // Events that had already piled up before the poller attached — must not be replayed.
  plugin.pushEvent({
    kind: "task.status",
    board: slugOf(channel.id),
    task_id: "old",
    payload: { from: "running", to: "done", parent_count: 0, title: "옛 카드", assignee: "sophie" },
  });

  const { pollChannelOnce } = await import("./automation-poller");
  const h = await makeDeps();
  const outcome = await pollChannelOnce(channel.id, h.deps);
  assert.ok(outcome.ok, JSON.stringify(outcome));
  assert.equal(outcome.events, 0);

  const polls = eventPolls(plugin);
  assert.equal(polls.length, 1);
  assert.ok(!polls[0].path.includes("cursor="), "커서 없이 부른다");
  assert.ok(polls[0].path.includes(`board=${slugOf(channel.id)}`), "보드로 좁힌다");
  assert.match(polls[0].path, /include=artifacts/, "아티팩트 사건도 함께 묻는다");

  const row = await readRow(channel.id);
  assert.ok(row.eventCursor, "지금 토큰이 저장된다");
  assert.equal(row.lastError, null);
  assert.ok(row.lastPolledAt, "last_polled_at 이 찍힌다");
  assert.equal(h.emitted.length, 0);
  assert.equal(h.roomEmits.length, 0);
});

test("event queries include artifacts and card proposals together", async () => {
  // Proposal events ride on the **same cursor** as artifacts. If include does not enable them, the plugin
  // filters them out, and even if enabled later the cursor has already moved past, so they never arrive (silent death).
  const plugin = await startPlugin();
  const { channel } = await seedBoundChannel(plugin);
  const { pollChannelOnce } = await import("./automation-poller");
  const h = await makeDeps();
  assert.ok((await pollChannelOnce(channel.id, h.deps)).ok);

  const includes = eventPolls(plugin).map((r) => decodeURIComponent(r.path));
  assert.ok(includes.length > 0);
  assert.ok(
    includes.every((path) => /include=[^&]*\bartifacts\b/.test(path)),
    "아티팩트를 include 한다",
  );
  assert.ok(
    includes.every((path) => /include=[^&]*\bcard_proposals\b/.test(path)),
    "카드 제안을 include 한다",
  );
});

test("events after the token are ingested and the cursor advances; the next round does not reprocess them", async () => {
  const plugin = await startPlugin();
  const { channel, npc } = await seedBoundChannel(plugin);
  const { pollChannelOnce } = await import("./automation-poller");
  const h = await makeDeps();
  assert.ok((await pollChannelOnce(channel.id, h.deps)).ok);
  const firstCursor = (await readRow(channel.id)).eventCursor;

  plugin.pushEvent({
    kind: "task.status",
    board: slugOf(channel.id),
    task_id: "t1",
    payload: { from: "running", to: "done", parent_count: 0, title: "보고서", assignee: "sophie" },
  });
  const second = await pollChannelOnce(channel.id, h.deps);
  assert.ok(second.ok);
  assert.equal(second.events, 1);
  assert.notEqual((await readRow(channel.id)).eventCursor, firstCursor);

  // Real wiring: stored as an NPC utterance in the office room and notice_json is read back.
  assert.equal(h.roomEmits.length, 1);
  const message = h.roomEmits[0].message;
  assert.equal(message.senderKind, "npc");
  assert.equal(message.senderId, npc.id);
  assert.equal(message.senderName, "소피");
  assert.equal(message.content, "보고서");
  assert.deepEqual(message.notice, {
    kind: "card_done",
    cardId: "t1",
    cardTitle: "보고서",
    boardSlug: slugOf(channel.id),
    npcName: "소피",
  });
  const { recentRoomMessages } = await import("@/lib/chat-rooms");
  const stored = await recentRoomMessages(h.roomEmits[0].roomId, 10);
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0].notice, message.notice, "notice_json → RoomMessage.notice");
  assert.deepEqual(
    h.emitted.map((e) => e.event),
    ["kanban:event"],
  );

  const third = await pollChannelOnce(channel.id, h.deps);
  assert.ok(third.ok);
  assert.equal(third.events, 0, "커서가 전진했으니 같은 사건은 다시 오지 않는다");
  assert.equal(h.roomEmits.length, 1);
});

test("a dormant NPC's card becomes a system message — real DB lookup path", async () => {
  const plugin = await startPlugin();
  const { channel } = await seedBoundChannel(plugin, { npcActive: false });
  const { pollChannelOnce } = await import("./automation-poller");
  const h = await makeDeps();
  assert.ok((await pollChannelOnce(channel.id, h.deps)).ok);
  plugin.pushEvent({
    kind: "task.status",
    board: slugOf(channel.id),
    task_id: "t1",
    payload: { from: "ready", to: "blocked", parent_count: 1, title: "막힘", assignee: "sophie" },
  });
  assert.ok((await pollChannelOnce(channel.id, h.deps)).ok);
  assert.equal(h.roomEmits.length, 1);
  assert.equal(h.roomEmits[0].message.senderKind, "system");
  assert.equal(h.roomEmits[0].message.senderId, null);
  assert.equal(h.roomEmits[0].message.content, "소피: 막힘");
  assert.equal(h.roomEmits[0].message.notice?.kind, "card_blocked");
});

test("cron results — posted if the origin ledger is this channel, not posted for another channel (real ledger)", async () => {
  const plugin = await startPlugin();
  const mine = await seedBoundChannel(plugin);
  const other = await seedChannel(mine.owner.id, "다른 채널");
  const { recordCronOrigin } = await import("@/lib/cron-origins");
  await recordCronOrigin({
    gatewayId: mine.gateway.id,
    profileName: "sophie",
    jobId: "job-mine",
    channelId: mine.channel.id,
    createdByUserId: mine.owner.id,
  });
  await recordCronOrigin({
    gatewayId: mine.gateway.id,
    profileName: "sophie",
    jobId: "job-other",
    channelId: other.id,
    createdByUserId: mine.owner.id,
  });

  const { pollChannelOnce } = await import("./automation-poller");
  const h = await makeDeps();
  assert.ok((await pollChannelOnce(mine.channel.id, h.deps)).ok);
  const finished = (jobId: string, text: string) =>
    plugin.pushEvent({
      kind: "cron.run.finished",
      profile: "sophie",
      job_id: jobId,
      run_id: `run-${jobId}`,
      payload: {
        job_id: jobId,
        job_name: `작업 ${jobId}`,
        profile: "sophie",
        session_id: "s",
        started_at: "2026-09-14T00:00:00Z",
        status: "ok",
        ended_at: "2026-09-14T00:01:00Z",
        result_text: text,
      },
    });
  finished("job-mine", "내 결과");
  finished("job-other", "남의 결과");
  finished("job-nobody", "출처 없음");

  const outcome = await pollChannelOnce(mine.channel.id, h.deps);
  assert.ok(outcome.ok);
  assert.equal(outcome.events, 3, "크론 사건은 보드 필터를 통과한다");
  assert.equal(h.emitted.filter((e) => e.event === "cron:event").length, 3);
  assert.equal(h.roomEmits.length, 1, "이 채널 출처만 게시");
  assert.equal(h.roomEmits[0].message.content, "내 결과");
  assert.deepEqual(h.roomEmits[0].message.notice, {
    kind: "cron_result",
    jobId: "job-mine",
    jobName: "작업 job-mine",
    npcName: "소피",
    status: "ok",
  });
});

test("on unknown_cursor, re-calls without a cursor and stores a new token — no replay (E7)", async () => {
  const plugin = await startPlugin();
  const { channel } = await seedBoundChannel(plugin);
  const { pollChannelOnce } = await import("./automation-poller");
  const h = await makeDeps();
  assert.ok((await pollChannelOnce(channel.id, h.deps)).ok);

  // The plugin restarted and forgot the cursor (request history remains — only look at what comes after).
  plugin.reset();
  const seenBefore = eventPolls(plugin).length;
  plugin.pushEvent({
    kind: "task.status",
    board: slugOf(channel.id),
    task_id: "t1",
    payload: {
      from: "running",
      to: "done",
      parent_count: 0,
      title: "재생 금지",
      assignee: "sophie",
    },
  });
  const before = (await readRow(channel.id)).eventCursor;
  const outcome = await pollChannelOnce(channel.id, h.deps);
  assert.ok(outcome.ok, JSON.stringify(outcome));
  assert.equal(outcome.restarted, true);
  assert.equal(outcome.events, 0, "잊힌 커서 이후의 사건은 재생하지 않는다");

  const polls = eventPolls(plugin).slice(seenBefore);
  assert.equal(polls.length, 2);
  assert.equal(polls[0].status, 400);
  assert.ok(polls[0].path.includes(`cursor=${before}`));
  assert.ok(!polls[1].path.includes("cursor="), "두 번째는 커서 없이");

  const row = await readRow(channel.id);
  assert.ok(row.eventCursor && row.eventCursor !== before, "새 토큰이 저장된다");
  assert.equal(row.lastError, null);
  assert.equal(h.roomEmits.length, 0);
});

test("has_more is followed within the page cap — everything absorbed in one round", async () => {
  const plugin = await startPlugin();
  const { channel } = await seedBoundChannel(plugin);
  const { pollChannelOnce } = await import("./automation-poller");
  const h = await makeDeps({ pageLimit: 2, maxPages: 10 });
  assert.ok((await pollChannelOnce(channel.id, h.deps)).ok);
  for (let i = 0; i < 5; i += 1) {
    plugin.pushEvent({
      kind: "task.created",
      board: slugOf(channel.id),
      task_id: `t${i}`,
      payload: {},
    });
  }
  const outcome = await pollChannelOnce(channel.id, h.deps);
  assert.ok(outcome.ok);
  assert.equal(outcome.events, 5);
  assert.equal(outcome.pages, 3);
  assert.equal(h.emitted.filter((e) => e.event === "kanban:event").length, 5);
  const again = await pollChannelOnce(channel.id, h.deps);
  assert.ok(again.ok);
  assert.equal(again.events, 0);
});

test("poll failures are swallowed and recorded in last_error; the next success clears it (E6)", async () => {
  const plugin = await startPlugin();
  const { channel } = await seedBoundChannel(plugin);
  const { pollChannelOnce } = await import("./automation-poller");
  const h = await makeDeps();
  assert.ok((await pollChannelOnce(channel.id, h.deps)).ok);
  const cursor = (await readRow(channel.id)).eventCursor;

  // Kill only the events path — the plugin verdict cache is fresh, so we get this far.
  const broken = await makeDeps({
    resolveBoard: async (id) => {
      const real = await h.deps.resolveBoard(id);
      if (!real.ok) return real;
      return {
        ...real,
        ownerClient: {
          ...real.ownerClient,
          events: {
            ...real.ownerClient.events,
            poll: async () => ({
              ok: false as const,
              status: 0,
              failure: {
                code: "unreachable",
                message: "boom",
                blocksEditor: false,
                showsShellCommand: null,
                details: {},
              },
            }),
          },
        },
      };
    },
  });
  const failed = await pollChannelOnce(channel.id, broken.deps);
  assert.equal(failed.ok, false);
  let row = await readRow(channel.id);
  assert.equal(row.lastError, "unreachable");
  assert.equal(row.eventCursor, cursor, "커서는 그대로");

  const recovered = await pollChannelOnce(channel.id, h.deps);
  assert.ok(recovered.ok);
  row = await readRow(channel.id);
  assert.equal(row.lastError, null);
});

test("an unbound channel ends as unbound and writes nothing", async () => {
  const owner = await seedUser("loose-owner");
  const channel = await seedChannel(owner.id, "묶이지 않은 채널");
  const { pollChannelOnce } = await import("./automation-poller");
  const h = await makeDeps();
  const outcome = await pollChannelOnce(channel.id, h.deps);
  assert.deepEqual(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.code, "unbound");
  const { getChannelBoard } = await import("@/lib/kanban-boards");
  assert.equal(await getChannelBoard(channel.id), null);
});

test("with no link row (ensure failed at bind time), ensures the board first and then polls", async () => {
  const plugin = await startPlugin();
  const { channel } = await seedBoundChannel(plugin);
  // Delete the row created by binding to produce the "no row because ensure failed" state.
  const { db, channelKanbanBoards } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  await db.delete(channelKanbanBoards).where(eq(channelKanbanBoards.channelId, channel.id));
  const requestsBefore = plugin.requests().length;

  const { pollChannelOnce } = await import("./automation-poller");
  const h = await makeDeps();
  const outcome = await pollChannelOnce(channel.id, h.deps);
  assert.ok(outcome.ok, JSON.stringify(outcome));
  const paths = plugin
    .requests()
    .slice(requestsBefore)
    .map((r) => `${r.method} ${r.path.split("?")[0]}`);
  assert.ok(paths.includes("POST /deskrpg/kanban/boards"), `행을 다시 세운다: ${paths}`);
  assert.ok((await readRow(channel.id)).eventCursor);
});

test("a channel whose board was blocked by the gate at bind time creates the board on the next round after the plugin is upgraded (R5)", async () => {
  const plugin = await startPlugin({ version: "0.5.0" });
  const { channel, gateway } = await seedBoundChannel(plugin);
  let row = await readRow(channel.id);
  assert.equal(row.lastError, "plugin_upgrade_required", "바인딩은 성공하되 이유가 남는다");
  assert.equal(row.boardNameSyncedAt, null, "보드가 한 번도 확보되지 않았다");
  assert.equal(
    plugin.requests().filter((r) => r.path.startsWith("/deskrpg/kanban/boards")).length,
    0,
  );

  const { pollChannelOnce } = await import("./automation-poller");
  const h = await makeDeps();
  const blocked = await pollChannelOnce(channel.id, h.deps);
  assert.equal(blocked.ok, false);
  assert.equal(!blocked.ok && blocked.code, "plugin_upgrade_required");

  // Upgraded the plugin to 0.6.0. Treat the verdict cache (1 hour) as expired — while the cache is fresh,
  // the rule is that no path re-hits Hermes.
  plugin.setInfo({ version: "0.6.0", capabilities: ["kanban", "cron", "events"] });
  const { db, gatewayResources } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  await db
    .update(gatewayResources)
    .set({ pluginCheckedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() as never })
    .where(eq(gatewayResources.id, gateway.id));

  const outcome = await pollChannelOnce(channel.id, h.deps);
  assert.ok(outcome.ok, JSON.stringify(outcome));
  assert.equal(
    plugin.requests().filter((r) => r.method === "POST" && r.path === "/deskrpg/kanban/boards")
      .length,
    1,
    "다음 바퀴가 보드를 만든다",
  );
  row = await readRow(channel.id);
  assert.equal(row.lastError, null);
  assert.ok(row.boardNameSyncedAt, "확보 시각이 찍힌다");
  assert.ok(row.eventCursor, "그 바퀴에서 바로 토큰까지 받는다");
});

test("if name sync lags after a channel rename, polling fixes it once and leaves it alone afterwards (R2)", async () => {
  const plugin = await startPlugin();
  const { channel } = await seedBoundChannel(plugin);
  const { pollChannelOnce } = await import("./automation-poller");
  const h = await makeDeps();
  assert.ok((await pollChannelOnce(channel.id, h.deps)).ok);
  const patches = () =>
    plugin
      .requests()
      .filter((r) => r.method === "PATCH" && r.path.startsWith("/deskrpg/kanban/boards/"));
  assert.equal(patches().length, 0);

  // Renamed, but board name sync failed — the channel's updated_at is later than synced_at.
  const { db, channels, channelKanbanBoards } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  const renamedAt = new Date(Date.now() - 5_000);
  await db
    .update(channelKanbanBoards)
    .set({ boardNameSyncedAt: new Date(renamedAt.getTime() - 5_000).toISOString() as never })
    .where(eq(channelKanbanBoards.channelId, channel.id));
  await db
    .update(channels)
    .set({ name: "새 이름", updatedAt: renamedAt.toISOString() as never })
    .where(eq(channels.id, channel.id));

  const outcome = await pollChannelOnce(channel.id, h.deps);
  assert.ok(outcome.ok, JSON.stringify(outcome));
  assert.equal(patches().length, 1, "한 바퀴에 한 번");
  assert.deepEqual(patches()[0].json, { name: "새 이름" });
  const row = await readRow(channel.id);
  assert.equal(row.lastError, null);
  assert.ok(
    new Date(row.boardNameSyncedAt as unknown as string).getTime() >= renamedAt.getTime(),
    "동기화 시각이 개명 시각을 넘어선다",
  );

  assert.ok((await pollChannelOnce(channel.id, h.deps)).ok);
  assert.equal(patches().length, 1, "맞춘 뒤에는 다시 부르지 않는다");
});

test("boardNameStale — true when the sync time is missing or earlier than the channel's update time", async () => {
  const { boardNameStale } = await import("./automation-poller");
  const t0 = new Date("2026-09-14T00:00:00Z");
  const t1 = new Date("2026-09-14T00:00:01Z");
  assert.equal(boardNameStale({ boardNameSyncedAt: null }, t0), true);
  assert.equal(boardNameStale({ boardNameSyncedAt: t0 }, t1), true);
  assert.equal(boardNameStale({ boardNameSyncedAt: t1 }, t0), false);
  assert.equal(boardNameStale({ boardNameSyncedAt: t1 }, t1), false);
  assert.equal(boardNameStale({ boardNameSyncedAt: t1.toISOString() as never }, t1), false);
  assert.equal(boardNameStale({ boardNameSyncedAt: t0 }, null), false, "채널 시각을 모르면 그대로");
});

/**
 * Fake clock. Runs the poller's waits on ticks instead of real time — eliminates the intermittent
 * interval-check failures caused by ticks slipping when the machine was busy (B48).
 */
function createFakeClock() {
  let now = 0;
  let seq = 0;
  const pending = new Map<number, { at: number; handler: () => void }>();
  const timers: PollerTimers = {
    setTimeout(handler: () => void, delayMs: number) {
      const id = (seq += 1);
      pending.set(id, { at: now + delayMs, handler });
      return { id, unref() {} };
    },
    clearTimeout(handle: PollerTimerHandle) {
      const id = (handle as { id?: number }).id;
      if (id != null) pending.delete(id);
    },
  };
  return {
    timers,
    /** Advance the ticks and wake the waits that fell in between, in time order. */
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        // The poller only sets the next wait after awaiting pollOnce — drain the queue before sweeping.
        await new Promise((resolve) => setImmediate(resolve));
        const due = [...pending.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, timer] = due;
        pending.delete(id);
        now = timer.at;
        timer.handler();
      }
      now = target;
    },
  };
}

test("timer registry — when a connection comes on, one round immediately, short interval; when off, long interval; refresh syncs the table", async () => {
  const { createAutomationPoller } = await import("./automation-poller");
  const calls: string[] = [];
  let bound = new Set(["a", "b"]);
  const clock = createFakeClock();
  const poller = createAutomationPoller({
    pollOnce: async (id) => {
      calls.push(id);
      return { ok: true, events: 0, pages: 1, cursor: "c0", restarted: false };
    },
    listBoundChannelIds: async () => [...bound],
    isChannelBound: async (id) => bound.has(id),
    intervals: { activeMs: 15, idleMs: 10_000 },
    timers: clock.timers,
  });
  try {
    await poller.refresh();
    assert.ok(poller.has("a") && poller.has("b"));
    assert.equal(calls.length, 0, "시작만으로는 돌지 않는다(긴 주기 대기)");

    await poller.setActive("a", true);
    assert.deepEqual(calls, ["a"], "켜지면 즉시 한 바퀴");
    await clock.advance(60);
    assert.ok(calls.filter((c) => c === "a").length >= 3, `짧은 주기로 돈다: ${calls}`);
    assert.equal(calls.filter((c) => c === "b").length, 0, "b 는 긴 주기라 아직");

    await poller.setActive("a", false);
    const settled = calls.length;
    await clock.advance(40);
    assert.equal(calls.length, settled, "꺼지면 긴 주기로 돌아간다");

    const outcome = await poller.pollNow("b");
    assert.ok(outcome.ok);
    assert.equal(calls.filter((c) => c === "b").length, 1, "pollNow 는 즉시 한 바퀴");

    // A channel bound after the server started: setActive checks the table and starts. Ignored if unbound.
    bound = new Set(["a", "c"]);
    await poller.setActive("c", true);
    assert.ok(poller.has("c"));
    await poller.setActive("zzz", true);
    assert.equal(poller.has("zzz"), false);

    await poller.refresh();
    assert.equal(poller.has("b"), false, "풀린 채널은 멈춘다");
    assert.ok(poller.has("c"));
  } finally {
    poller.stopAll();
  }
});

test("timer registry — an unbound result stops that channel's poller", async () => {
  const { createAutomationPoller } = await import("./automation-poller");
  const poller = createAutomationPoller({
    pollOnce: async () => ({ ok: false, code: "unbound", reason: "no binding" }),
    listBoundChannelIds: async () => [],
    isChannelBound: async () => true,
    intervals: { activeMs: 10, idleMs: 10 },
  });
  try {
    await poller.pollNow("x");
    assert.equal(poller.has("x"), false);
  } finally {
    poller.stopAll();
  }
});

// ---------------------------------------------------------------------------
// Multiple boards (design 2026-09-21 project-registry)
// ---------------------------------------------------------------------------

async function addBoard(channelId: string): Promise<string> {
  const { ensureChannelBoard, newChannelBoardSlug } = await import("@/lib/kanban-boards");
  const slug = newChannelBoardSlug(channelId);
  const ensured = await ensureChannelBoard(channelId, undefined, slug);
  assert.ok(ensured.ok, "둘째 보드 확보 실패");
  return slug;
}

test("cursors are stored by board row id — writing per channel would overwrite other boards", async () => {
  const server = await startPlugin();
  const { channel } = await seedBoundChannel(server);
  await addBoard(channel.id);
  const { pollChannelOnce } = await import("./automation-poller");

  // Intercept the save call to see **what was used as the key**. The fake server gives both boards the same
  // cursor token when their state matches, so looking only at the stored value cannot tell an overwrite.
  const saved: string[] = [];
  const base = await makeDeps();
  const h = await makeDeps({
    saveRow: async (boardLinkId, patch) => {
      saved.push(boardLinkId);
      return base.deps.saveRow(boardLinkId, patch);
    },
  });

  assert.ok((await pollChannelOnce(channel.id, h.deps)).ok);

  const { listChannelBoards } = await import("@/lib/kanban-boards");
  const rows = await listChannelBoards(channel.id);
  const ids = new Set(rows.map((r) => r.id));
  assert.equal(ids.size, 2);
  for (const id of saved) {
    assert.ok(
      ids.has(id),
      `연결 행 id 가 아닌 값(${id})으로 저장했습니다 — 채널 단위로 쓰면 다른 보드 커서를 덮습니다`,
    );
  }
  assert.equal(
    new Set(saved).size,
    2,
    "보드 둘을 돌았는데 저장 키가 하나뿐입니다 — 한 행에 두 보드의 커서가 겹쳐 쓰입니다",
  );
});

test("with two boards, events are fetched from both", async () => {
  const server = await startPlugin();
  const { channel } = await seedBoundChannel(server);
  const second = await addBoard(channel.id);
  const { pollChannelOnce } = await import("./automation-poller");
  const h = await makeDeps();
  assert.ok((await pollChannelOnce(channel.id, h.deps)).ok);

  const polledBoards = new Set(
    eventPolls(server).map((r) => new URL(`http://x${r.path}`).searchParams.get("board")),
  );
  assert.ok(polledBoards.has(second), "둘째 보드를 폴링하지 않으면 그 카드는 실시간으로 안 옵니다");
  assert.equal(polledBoards.size, 2);
});

test("include goes only on the receiving board, and the artifact·card-proposal tokens are always attached together", async () => {
  // The two sources share cursor `a` — enabling only one makes the cursor advance past the other's events and they
  // silently vanish.
  // And both are gateway-global, so attaching them per board would duplicate them by the number of boards.
  const server = await startPlugin();
  const { channel } = await seedBoundChannel(server);
  const second = await addBoard(channel.id);
  const { pollChannelOnce } = await import("./automation-poller");
  const h = await makeDeps();
  assert.ok((await pollChannelOnce(channel.id, h.deps)).ok);

  const byBoard = new Map<string | null, Array<string | null>>();
  for (const r of eventPolls(server)) {
    const params = new URL(`http://x${r.path}`).searchParams;
    const board = params.get("board");
    byBoard.set(board, [...(byBoard.get(board) ?? []), params.get("include")]);
  }
  assert.equal(byBoard.size, 2);
  for (const [board, includes] of byBoard) {
    const expected = board === second ? null : "artifacts,card_proposals";
    assert.deepEqual(
      [...new Set(includes)],
      [expected],
      `보드 ${board} 의 include 가 ${JSON.stringify(includes)} 입니다`,
    );
  }
});

test("a board that is not the event-receiving board drops cron events", async () => {
  const server = await startPlugin();
  const { channel } = await seedBoundChannel(server);
  await addBoard(channel.id);
  const { pollChannelOnce } = await import("./automation-poller");
  const h = await makeDeps();
  assert.ok((await pollChannelOnce(channel.id, h.deps)).ok);

  // Cron events are gateway-global, so they come in both boards' responses.
  server.pushEvent({
    kind: "cron.run.finished",
    profile: "sophie",
    job_id: "job-1",
    payload: {
      job_id: "job-1",
      job_name: "정기 보고",
      profile: "sophie",
      status: "ok",
      result_text: "끝",
    },
  });
  const outcome = await pollChannelOnce(channel.id, h.deps);
  assert.ok(outcome.ok);

  const cronEmits = h.emitted.filter((e) => String(e.event).includes("cron"));
  assert.equal(
    cronEmits.length,
    1,
    `크론 사건이 ${cronEmits.length}번 소비됐습니다 — 보드 수만큼 중복되면 안 됩니다`,
  );
});

test("a channel with zero event-receiving boards recovers in one poll round", async () => {
  const server = await startPlugin();
  const { channel } = await seedBoundChannel(server);
  await addBoard(channel.id);

  const { db, channelKanbanBoards } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  await db
    .update(channelKanbanBoards)
    .set({ isEventCarrier: false })
    .where(eq(channelKanbanBoards.channelId, channel.id));

  const { listChannelBoards } = await import("@/lib/kanban-boards");
  assert.equal(
    (await listChannelBoards(channel.id)).filter((r) => r.isEventCarrier).length,
    0,
    "사전 조건: carrier 가 0개다",
  );

  const { pollChannelOnce } = await import("./automation-poller");
  const h = await makeDeps();
  assert.ok((await pollChannelOnce(channel.id, h.deps)).ok);

  const rows = await listChannelBoards(channel.id);
  assert.equal(
    rows.filter((r) => r.isEventCarrier).length,
    1,
    "carrier 0개가 복구되지 않으면 그 채널은 크론 사건을 아무도 받지 않습니다",
  );
  assert.equal(
    rows.find((r) => r.isEventCarrier)?.boardSlug,
    rows[0].boardSlug,
    "가장 오래된 보드가 그 자리를 맡아야 합니다",
  );
});

test("boards of archived projects are excluded from receiving-board candidates", async () => {
  const server = await startPlugin();
  const { channel } = await seedBoundChannel(server);
  const second = await addBoard(channel.id);

  const { db, channelKanbanBoards, channelProjects } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  const { listChannelBoards, ensureChannelCarrier } = await import("@/lib/kanban-boards");

  const rows = await listChannelBoards(channel.id);
  const oldest = rows[0];
  // Put the oldest board in the archived state — then the second board must take the slot.
  await db.insert(channelProjects).values({
    boardLinkId: oldest.id,
    channelId: channel.id,
    status: "completed",
  });
  await db
    .update(channelKanbanBoards)
    .set({ isEventCarrier: false })
    .where(eq(channelKanbanBoards.channelId, channel.id));

  await ensureChannelCarrier(channel.id);
  const after = await listChannelBoards(channel.id);
  assert.equal(after.filter((r) => r.isEventCarrier).length, 1);
  assert.equal(
    after.find((r) => r.isEventCarrier)?.boardSlug,
    second,
    "끝난 일의 보드를 사건 수신 자리로 되살리면 보관의 뜻이 무너집니다",
  );
});

// ---------------------------------------------------------------------------
// Re-establishing "working" after a restart (design 2026-09-21 npc-working-state, decision A-1)
// ---------------------------------------------------------------------------

/** Create a real card on that board and move it to running. */
async function seedRunningCard(
  channelId: string,
  slug: string,
  title: string,
  assignee = "sophie",
): Promise<string> {
  const { resolveChannelBoard } = await import("@/lib/kanban-boards");
  const resolved = await resolveChannelBoard(channelId);
  assert.ok(resolved.ok);
  const made = await resolved.ownerClient.kanban.createTask(slug, { title, assignee });
  assert.ok(made.ok, `createTask 실패: ${made.ok ? "" : made.failure.code}`);
  const taskId = made.data.task.id;
  const moved = await resolved.ownerClient.kanban.updateTask(slug, taskId, { status: "running" });
  assert.ok(moved.ok);
  return taskId;
}

/** Process restart — drops both working state and reconstruction markers (the cursor stays in the DB). */
async function simulateRestart(channelId: string) {
  const { resetAutomationState } = await import("./automation-events");
  const { resetWorkingResyncForTests } = await import("./automation-poller");
  resetAutomationState();
  resetWorkingResyncForTests(channelId);
}

test("a restart clears working, and one poll round re-establishes it", async () => {
  const server = await startPlugin();
  const { channel, npc } = await seedBoundChannel(server);
  const { pollChannelOnce } = await import("./automation-poller");
  const { getWorkingSnapshot } = await import("./automation-events");
  const { channelBoardSlug } = await import("@/lib/kanban-boards");
  const slug = channelBoardSlug(channel.id);
  const h = await makeDeps();

  assert.ok((await pollChannelOnce(channel.id, h.deps)).ok);
  const taskId = await seedRunningCard(channel.id, slug, "돌고 있는 카드");
  server.pushEvent({
    kind: "task.run.started",
    board: slug,
    task_id: taskId,
    payload: { assignee: "sophie" },
  });
  assert.ok((await pollChannelOnce(channel.id, h.deps)).ok);
  assert.equal(getWorkingSnapshot(channel.id).length, 1, "사전 조건: 일하는 중이다");

  await simulateRestart(channel.id);
  assert.deepEqual(getWorkingSnapshot(channel.id), [], "재시작하면 사라진다");

  assert.ok((await pollChannelOnce(channel.id, h.deps)).ok);
  const restored = getWorkingSnapshot(channel.id);
  assert.equal(restored.length, 1, "폴링 한 바퀴가 되세우지 못했습니다");
  assert.equal(restored[0].npcId, npc.id);
  assert.equal(restored[0].sources.runningCards, 1);
});

test("after re-establishing, a real finished turns it off — it does not stay on forever", async () => {
  const server = await startPlugin();
  const { channel } = await seedBoundChannel(server);
  const { pollChannelOnce } = await import("./automation-poller");
  const { getWorkingSnapshot } = await import("./automation-events");
  const { channelBoardSlug } = await import("@/lib/kanban-boards");
  const slug = channelBoardSlug(channel.id);
  const h = await makeDeps();

  assert.ok((await pollChannelOnce(channel.id, h.deps)).ok);
  const taskId = await seedRunningCard(channel.id, slug, "끝날 카드");
  await simulateRestart(channel.id);
  assert.ok((await pollChannelOnce(channel.id, h.deps)).ok);
  assert.equal(getWorkingSnapshot(channel.id).length, 1, "사전 조건: 되세워졌다");

  server.pushEvent({
    kind: "task.run.finished",
    board: slug,
    task_id: taskId,
    payload: { assignee: "sophie" },
  });
  assert.ok((await pollChannelOnce(channel.id, h.deps)).ok);
  assert.deepEqual(
    getWorkingSnapshot(channel.id),
    [],
    "합성 시작을 진짜 종료가 닫지 못했습니다 — task_id 가 어긋났습니다",
  );
});

test("the assignee of a running card is still working after a replayed old finished", async () => {
  const server = await startPlugin();
  const { channel } = await seedBoundChannel(server);
  const { pollChannelOnce } = await import("./automation-poller");
  const { getWorkingSnapshot } = await import("./automation-events");
  const { channelBoardSlug } = await import("@/lib/kanban-boards");
  const slug = channelBoardSlug(channel.id);
  const h = await makeDeps();

  assert.ok((await pollChannelOnce(channel.id, h.deps)).ok);
  const taskId = await seedRunningCard(channel.id, slug, "재시도로 다시 도는 카드");

  // Events that piled up while it was down: the card finished once and started again. The cursor stays in the DB, so
  // the first poll after restart replays this. If re-establishing ran **before** polling, the replayed finished would
  // erase the synthetic started and a card that is actually running would flip to "쉬는 중" (resting).
  server.pushEvent({
    kind: "task.run.finished",
    board: slug,
    task_id: taskId,
    payload: { assignee: "sophie" },
  });

  await simulateRestart(channel.id);
  assert.ok((await pollChannelOnce(channel.id, h.deps)).ok);

  const snapshot = getWorkingSnapshot(channel.id);
  assert.equal(
    snapshot.length,
    1,
    "재생된 옛 종료가 되세우기를 지웠습니다 — 되세우기는 폴링을 비운 뒤에 와야 합니다",
  );
  assert.equal(snapshot[0].sources.runningCards, 1);
});

// Reproduction of card `…72Q0M`. The claim was "proposals made while DeskRPG was down are lost forever".
// The cursor lives in `channel_kanban_boards.event_cursor` and a restart does not delete that row, so the first
// poll after restart replays the proposals from the gap. The two assertions below pin that property — if either breaks,
// the query route actually becomes necessary.
test("card proposals made while down show up as notifications on the first poll after restart", async () => {
  const server = await startPlugin();
  const { channel, npc } = await seedBoundChannel(server);
  const { pollChannelOnce } = await import("./automation-poller");
  const h = await makeDeps();

  // The first round stores the "now" token in the DB.
  assert.ok((await pollChannelOnce(channel.id, h.deps)).ok);

  // From here DeskRPG is down — meanwhile a staff member made a proposal.
  server.pushEvent({
    kind: "card_proposal.created",
    profile: "sophie",
    payload: {
      proposal_id: "0123456789abcdef0123456789abcdef",
      title: "주간 보고 정리",
      summary: "금요일마다 모은다",
      profile: "sophie",
    },
  });

  await simulateRestart(channel.id);
  assert.ok((await pollChannelOnce(channel.id, h.deps)).ok);

  const notices = h.roomEmits.filter((e) => e.message.notice?.kind === "card_proposal");
  assert.equal(
    notices.length,
    1,
    "꺼져 있던 동안의 제안이 오지 않았습니다 — 커서가 재시작에 살아남지 못했다는 뜻입니다",
  );
  const notice = notices[0].message.notice;
  assert.ok(notice?.kind === "card_proposal");
  assert.equal(notice.proposalId, "0123456789abcdef0123456789abcdef");
  assert.equal(notice.npcId, npc.id);

  // Second property: the same proposal does not produce two notifications (the cursor advanced).
  assert.ok((await pollChannelOnce(channel.id, h.deps)).ok);
  assert.equal(
    h.roomEmits.filter((e) => e.message.notice?.kind === "card_proposal").length,
    1,
    "같은 제안의 알림이 둘 생겼습니다 — 커서가 전진하지 않았습니다",
  );
});

test("re-establishing reads the board only once per channel per process lifetime", async () => {
  const server = await startPlugin();
  const { channel } = await seedBoundChannel(server);
  const { pollChannelOnce } = await import("./automation-poller");
  const { channelBoardSlug } = await import("@/lib/kanban-boards");
  const slug = channelBoardSlug(channel.id);
  const h = await makeDeps();

  assert.ok((await pollChannelOnce(channel.id, h.deps)).ok);
  await seedRunningCard(channel.id, slug, "카드");
  await simulateRestart(channel.id);

  const before = server.requests().filter((r) => r.path.startsWith("/deskrpg/kanban/board")).length;
  await pollChannelOnce(channel.id, h.deps);
  const afterFirst = server
    .requests()
    .filter((r) => r.path.startsWith("/deskrpg/kanban/board")).length;
  await pollChannelOnce(channel.id, h.deps);
  await pollChannelOnce(channel.id, h.deps);
  const afterMore = server
    .requests()
    .filter((r) => r.path.startsWith("/deskrpg/kanban/board")).length;

  assert.ok(afterFirst > before, "첫 바퀴가 보드를 읽지 않았습니다");
  assert.equal(
    afterMore,
    afterFirst,
    "한가한 채널이 매 바퀴 보드를 조회합니다 — 조건이 '상태가 비었나' 로 잡혀 있습니다",
  );
});

test("re-establishing skips running cards with no assignee", async () => {
  const server = await startPlugin();
  const { channel } = await seedBoundChannel(server);
  const { pollChannelOnce } = await import("./automation-poller");
  const { getWorkingSnapshot } = await import("./automation-events");
  const { channelBoardSlug, resolveChannelBoard } = await import("@/lib/kanban-boards");
  const slug = channelBoardSlug(channel.id);
  const h = await makeDeps();

  assert.ok((await pollChannelOnce(channel.id, h.deps)).ok);
  const resolved = await resolveChannelBoard(channel.id);
  assert.ok(resolved.ok);
  const made = await resolved.ownerClient.kanban.createTask(slug, { title: "담당 없는 카드" });
  assert.ok(made.ok);
  await resolved.ownerClient.kanban.updateTask(slug, made.data.task.id, { status: "running" });

  await simulateRestart(channel.id);
  assert.ok((await pollChannelOnce(channel.id, h.deps)).ok);
  assert.deepEqual(
    getWorkingSnapshot(channel.id),
    [],
    "담당자가 없으면 누구를 일하는 중으로 만들지 정할 수 없습니다",
  );
});

test("a round whose board query failed is not marked done — re-established on the next round", async () => {
  const server = await startPlugin();
  const { channel } = await seedBoundChannel(server);
  const { pollChannelOnce } = await import("./automation-poller");
  const { getWorkingSnapshot } = await import("./automation-events");
  const { channelBoardSlug } = await import("@/lib/kanban-boards");
  const slug = channelBoardSlug(channel.id);
  const h = await makeDeps();

  assert.ok((await pollChannelOnce(channel.id, h.deps)).ok);
  await seedRunningCard(channel.id, slug, "재시작 때 돌고 있던 카드");
  await simulateRestart(channel.id);

  // Restarts often coincide with deploys — the gateway is unreachable at the very moment re-establishing runs.
  server.failNext("/deskrpg/kanban/board");
  assert.ok((await pollChannelOnce(channel.id, h.deps)).ok);
  assert.deepEqual(
    getWorkingSnapshot(channel.id),
    [],
    "사전 조건: 보드를 못 읽었으니 이 바퀴는 아무것도 못 세운다",
  );

  assert.ok((await pollChannelOnce(channel.id, h.deps)).ok);
  const restored = getWorkingSnapshot(channel.id);
  assert.equal(
    restored.length,
    1,
    "실패한 바퀴를 '끝났다' 로 표시했습니다 — 그 채널은 프로세스가 사는 동안 다시 시도하지 않습니다",
  );

  // After success, do not query again (so idle channels do not read the board every round).
  const after = server.requests().filter((r) => r.path.startsWith("/deskrpg/kanban/board")).length;
  await pollChannelOnce(channel.id, h.deps);
  await pollChannelOnce(channel.id, h.deps);
  assert.equal(
    server.requests().filter((r) => r.path.startsWith("/deskrpg/kanban/board")).length,
    after,
    "성공한 뒤에도 매 바퀴 보드를 조회합니다",
  );
});

for (const status of ["completed", "cancelled"] as const) {
  test(`수신 보드 ${status} 인계 첫 폴링은 제안·아티팩트·크론과 대상 칸반·삭제를 보존한다`, async () => {
    const plugin = await startPlugin();
    const { channel } = await seedBoundChannel(plugin);
    const second = await addBoard(channel.id);
    const { pollChannelOnce } = await import("./automation-poller");
    const { listChannelBoards } = await import("@/lib/kanban-boards");
    const { ensureProjectRow, archiveChannelProject } = await import("@/lib/project-registry");
    const base = await makeDeps();
    const ids: string[] = [];
    const h = await makeDeps({
      pageLimit: 1,
      ingest: async (id, events, deps) => {
        ids.push(...events.map((e) => e.id));
        return base.deps.ingest(id, events, deps);
      },
    });
    // The old board's k/d must start further ahead to expose a regression that wrongly hands over k/d too.
    for (let n = 0; n < 2; n++)
      plugin.pushEvent({
        kind: "task.status",
        board: slugOf(channel.id),
        task_id: `old-${n}`,
        payload: { to: "done" },
      });
    plugin.pushEvent({
      kind: "task.deleted",
      board: slugOf(channel.id),
      task_id: "old-deleted",
      payload: {},
    });
    assert.ok((await pollChannelOnce(channel.id, h.deps)).ok);
    const source = (await listChannelBoards(channel.id)).find((r) => r.isEventCarrier)!;
    const project = await ensureProjectRow(source);
    const events = [
      plugin.pushEvent({
        kind: "card_proposal.created",
        profile: "sophie",
        payload: {
          proposal_id: "0123456789abcdef0123456789abcdef",
          title: "인계 전 제안",
          profile: "sophie",
        },
      }),
      plugin.pushEvent({
        kind: "artifact.created",
        profile: "sophie",
        payload: {
          artifact_id: "artifact-handoff",
          title: "보고서",
          kind: "document",
          version: 1,
          profile: "sophie",
        },
      }),
      plugin.pushEvent({
        kind: "cron.run.finished",
        profile: "sophie",
        job_id: "job-handoff",
        payload: { profile: "sophie", job_id: "job-handoff", status: "ok", result_text: "끝" },
      }),
      plugin.pushEvent({
        kind: "task.status",
        board: second,
        task_id: "task-handoff",
        payload: {
          from: "running",
          to: "done",
          parent_count: 0,
          title: "인계 카드",
          assignee: "sophie",
        },
      }),
      plugin.pushEvent({
        kind: "task.deleted",
        board: second,
        task_id: "deleted-handoff",
        payload: { title: "삭제됨" },
      }),
    ];
    const result = await archiveChannelProject(channel.id, project.id, status);
    assert.equal(result.carrierMovedTo, second);
    assert.ok((await pollChannelOnce(channel.id, h.deps)).ok);
    for (const event of events)
      assert.equal(ids.filter((id) => id === event.id).length, 1, `${event.kind} 누락/중복`);
    assert.equal(h.roomEmits.filter((e) => e.message.notice?.kind === "card_proposal").length, 1);
    assert.equal(h.roomEmits.filter((e) => e.message.notice?.kind === "card_done").length, 1);
    assert.ok((await pollChannelOnce(channel.id, h.deps)).ok);
    assert.equal(ids.length, events.length, "다음 바퀴에 인계 사건을 재소비하지 않는다");
  });
}

test("hands over from the old carrier position even if the new receiving candidate read global events first", async () => {
  const plugin = await startPlugin();
  const { channel } = await seedBoundChannel(plugin);
  const second = await addBoard(channel.id);
  const { pollChannelOnce } = await import("./automation-poller");
  const h = await makeDeps();
  assert.ok((await pollChannelOnce(channel.id, h.deps)).ok);
  const { listChannelBoards, resolveChannelBoard } = await import("@/lib/kanban-boards");
  const rows = await listChannelBoards(channel.id);
  const source = rows.find((r) => r.isEventCarrier)!;
  const target = rows.find((r) => r.boardSlug === second)!;
  const resolved = await resolveChannelBoard(channel.id);
  assert.ok(resolved.ok);
  // The case where global events were read and dropped at the candidate cursor holding a. Mixing in the target k/d
  // would make the card below vanish too.
  const primed = await resolved.ownerClient.events.poll({
    board: second,
    include: "artifacts,card_proposals",
  });
  assert.ok(primed.ok);
  plugin.pushEvent({
    kind: "card_proposal.created",
    profile: "sophie",
    payload: {
      proposal_id: "0123456789abcdef0123456789abcdef",
      title: "앞서 읽은 제안",
      profile: "sophie",
    },
  });
  const ahead = await resolved.ownerClient.events.poll({
    board: second,
    cursor: primed.data.cursor,
    include: "artifacts,card_proposals",
  });
  assert.ok(ahead.ok);
  await h.deps.saveRow(target.id, { eventCursor: ahead.data.cursor, lastError: null });
  const { ensureProjectRow, archiveChannelProject } = await import("@/lib/project-registry");
  await archiveChannelProject(channel.id, (await ensureProjectRow(source)).id, "completed");
  assert.ok((await pollChannelOnce(channel.id, h.deps)).ok);
  assert.equal(h.roomEmits.filter((e) => e.message.notice?.kind === "card_proposal").length, 1);
});
