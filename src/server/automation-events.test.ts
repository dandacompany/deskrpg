import { test } from "node:test";
import assert from "node:assert/strict";

import type { PluginEvent } from "@/lib/hermes/deskrpg-plugin-types";
import type { RoomMessage } from "@/lib/chat-rooms-policy";
import {
  AUTOMATION_SOCKET_EVENTS,
  createAutomationState,
  getWorkingSnapshot,
  ingest,
  type ChannelNpcLookup,
  type IngestDeps,
  type NpcWorkingPayload,
} from "./automation-events";

// T5. The single event sink `ingest()` — the poller and (later) the push route call the same function (R25).
// Here every dependency is faked without a DB to pin only the rules:
// broadcast (kanban:event / cron:event), map state (diff broadcast of npc:working), room notices (R28~R30),
// system messages for sleeping/missing NPCs (R22), no double-processing of the same event ID.

const CHANNEL = "channel-1";
const GATEWAY = "gateway-1";
const BOARD = "deskrpg-board";

type Emitted = { channelId: string; event: string; payload: unknown };
type Posted = Parameters<IngestDeps["appendRoomMessage"]>[0];

function harness(
  opts: {
    npcs?: Record<string, ChannelNpcLookup | null>;
    origins?: Record<string, { channelId: string; gatewayId: string }>;
    officeRoomId?: string | null;
    maxResultLength?: number;
    dedupeLimit?: number;
  } = {},
) {
  const emitted: Emitted[] = [];
  const posted: Posted[] = [];
  const roomEmits: Array<{ roomId: string; message: RoomMessage }> = [];
  let seq = 0;
  const deps: IngestDeps = {
    gatewayId: GATEWAY,
    boardSlug: BOARD,
    state: createAutomationState(),
    maxResultLength: opts.maxResultLength,
    dedupeLimit: opts.dedupeLimit,
    findNpcByProfile: async (_channelId, profileName) => opts.npcs?.[profileName] ?? null,
    findCronOriginChannel: async (key) =>
      opts.origins?.[`${key.gatewayId}/${key.profileName}/${key.jobId}`] ?? null,
    ensureOfficeRoomId: async () =>
      opts.officeRoomId === undefined ? "office-room" : opts.officeRoomId,
    appendRoomMessage: async (args) => {
      posted.push(args);
      return {
        id: `msg-${(seq += 1)}`,
        roomId: args.roomId,
        senderKind: args.senderKind,
        senderId: args.senderId,
        senderName: args.senderName,
        content: args.content,
        createdAt: new Date().toISOString(),
        notice: args.notice ?? null,
      };
    },
    emitChannel: (channelId, event, payload) => emitted.push({ channelId, event, payload }),
    emitRoomMessage: (roomId, message) => roomEmits.push({ roomId, message }),
  };
  return { deps, emitted, posted, roomEmits };
}

let eventSeq = 0;
function ev(input: Partial<PluginEvent> & { kind: PluginEvent["kind"] }): PluginEvent {
  return {
    id: input.id ?? `ev_${(eventSeq += 1)}`,
    ts: input.ts ?? Date.now(),
    kind: input.kind,
    board: input.board ?? BOARD,
    task_id: input.task_id,
    profile: input.profile,
    job_id: input.job_id,
    run_id: input.run_id,
    payload: input.payload ?? {},
  };
}

function statusEvent(input: {
  to: string;
  parent_count?: number;
  assignee?: string | null;
  title?: string;
  task_id?: string;
  id?: string;
}) {
  return ev({
    id: input.id,
    kind: "task.status",
    task_id: input.task_id ?? "task-1",
    payload: {
      from: "running",
      to: input.to,
      parent_count: input.parent_count ?? 0,
      title: input.title ?? "보고서 초안",
      assignee: input.assignee === undefined ? "sophie" : input.assignee,
    },
  });
}

function cronFinished(input: {
  profile?: string;
  job_id?: string;
  status?: "ok" | "error";
  result_text?: string;
  id?: string;
  run_id?: string;
}) {
  const profile = input.profile ?? "sophie";
  const job_id = input.job_id ?? "job-1";
  return ev({
    id: input.id,
    kind: "cron.run.finished",
    board: undefined,
    profile,
    job_id,
    run_id: input.run_id ?? "run-1",
    payload: {
      job_id,
      job_name: "아침 브리핑",
      profile,
      session_id: "sess-1",
      started_at: "2026-09-14T00:00:00Z",
      status: input.status ?? "ok",
      ended_at: "2026-09-14T00:01:00Z",
      result_text: input.result_text ?? "오늘의 브리핑입니다",
    },
  });
}

const SOPHIE_ACTIVE: ChannelNpcLookup = {
  profileName: "sophie",
  displayName: "소피",
  npc: { id: "npc-sophie", active: true },
};
const SOPHIE_ASLEEP: ChannelNpcLookup = {
  ...SOPHIE_ACTIVE,
  npc: { id: "npc-sophie", active: false },
};
const SOPHIE_ABSENT: ChannelNpcLookup = { ...SOPHIE_ACTIVE, npc: null };

const workingEvents = (emitted: Emitted[]) =>
  emitted
    .filter((e) => e.event === AUTOMATION_SOCKET_EVENTS.working)
    .map((e) => e.payload as NpcWorkingPayload);

/** Some notice kinds (meeting results) carry no employee name, so it cannot be read straight off the union. */
function noticeNpcName(notice: { kind: string } | null | undefined): string | undefined {
  return notice && "npcName" in notice ? (notice as { npcName: string }).npcName : undefined;
}

test("a top-level card entering done posts 1 notice to the office room under the assigned NPC's name — with notice", async () => {
  const h = harness({ npcs: { sophie: SOPHIE_ACTIVE } });
  await ingest(CHANNEL, [statusEvent({ to: "done", parent_count: 0 })], h.deps);

  assert.equal(h.posted.length, 1);
  const post = h.posted[0];
  assert.equal(post.roomId, "office-room");
  assert.equal(post.senderKind, "npc");
  assert.equal(post.senderId, "npc-sophie");
  assert.equal(post.senderName, "소피");
  assert.equal(post.content, "보고서 초안", "content 는 로케일 무관 폴백 = 카드 제목");
  assert.deepEqual(post.notice, {
    kind: "card_done",
    cardId: "task-1",
    cardTitle: "보고서 초안",
    boardSlug: BOARD,
    npcName: "소피",
  });
  assert.equal(h.roomEmits.length, 1, "저장한 메시지를 방 소켓으로 방송한다");
  assert.equal(h.roomEmits[0].roomId, "office-room");
  assert.equal(h.roomEmits[0].message.notice?.kind, "card_done");
});

test("done of a subcard (parent_count > 0) is not posted", async () => {
  const h = harness({ npcs: { sophie: SOPHIE_ACTIVE } });
  await ingest(CHANNEL, [statusEvent({ to: "done", parent_count: 2 })], h.deps);
  assert.equal(h.posted.length, 0);
});

test("a card in an approval bundle posts done even with a parent — it is independent work linked by order", async () => {
  // Meeting follow-ups carry "must finish first" as a parent link. The parent link is execution order, not a bundle, so
  // the second card was treated as a subcard and nobody reported it when it finished (measured on staging).
  const h = harness({ npcs: { sophie: SOPHIE_ACTIVE } });
  const asked: string[] = [];
  await ingest(
    CHANNEL,
    [
      statusEvent({ to: "done", parent_count: 1, task_id: "followup-2" }),
      statusEvent({ to: "done", parent_count: 1, task_id: "swarm-child" }),
      statusEvent({ to: "done", parent_count: 0, task_id: "root" }),
    ],
    {
      ...h.deps,
      isApprovalBatchCard: async (_channelId, taskId) => {
        asked.push(taskId);
        return taskId === "followup-2";
      },
    },
  );
  assert.deepEqual(
    h.posted.map((p) => [p.notice?.kind, (p.notice as { cardId: string }).cardId]),
    [
      ["card_done", "followup-2"],
      ["card_done", "root"],
    ],
  );
  // Swarm/decomposition children skip approval, so they stay quiet — 10 children do not become 10 notices.
  // A card without a parent need not be asked about.
  assert.deepEqual(asked, ["followup-2", "swarm-child"]);
});

test("without the approval-bundle lookup, done with a parent is not posted, as before", async () => {
  const h = harness({ npcs: { sophie: SOPHIE_ACTIVE } });
  await ingest(CHANNEL, [statusEvent({ to: "done", parent_count: 1 })], h.deps);
  assert.equal(h.posted.length, 0);
});

test("entering blocked is posted even for a subcard", async () => {
  const h = harness({ npcs: { sophie: SOPHIE_ACTIVE } });
  await ingest(
    CHANNEL,
    [
      statusEvent({ to: "blocked", parent_count: 3, task_id: "child" }),
      statusEvent({ to: "blocked", parent_count: 0, task_id: "root" }),
      statusEvent({ to: "running", parent_count: 0, task_id: "other" }),
    ],
    h.deps,
  );
  assert.deepEqual(
    h.posted.map((p) => [p.notice?.kind, (p.notice as { cardId: string }).cardId]),
    [
      ["card_blocked", "child"],
      ["card_blocked", "root"],
    ],
  );
});

test("a card blocked because it awaits approval posts no blocked notice — the approval request line already says it", async () => {
  const h = harness({ npcs: { sophie: SOPHIE_ACTIVE } });
  const asked: string[] = [];
  await ingest(
    CHANNEL,
    [
      statusEvent({ to: "blocked", parent_count: 0, task_id: "waiting" }),
      statusEvent({ to: "blocked", parent_count: 0, task_id: "really-stuck" }),
    ],
    {
      ...h.deps,
      isAwaitingApproval: async (_channelId, taskId) => {
        asked.push(taskId);
        return taskId === "waiting";
      },
    },
  );
  assert.deepEqual(asked, ["waiting", "really-stuck"]);
  // A genuinely blocked card is still announced.
  assert.deepEqual(
    h.posted.map((p) => (p.notice as { cardId: string }).cardId),
    ["really-stuck"],
  );
});

test("entering review is posted even for a subcard — it is a spot waiting on human judgment", async () => {
  const h = harness({ npcs: { sophie: SOPHIE_ACTIVE } });
  await ingest(
    CHANNEL,
    [
      statusEvent({ to: "review", parent_count: 4, task_id: "child" }),
      statusEvent({ to: "review", parent_count: 0, task_id: "root" }),
    ],
    h.deps,
  );
  assert.deepEqual(
    h.posted.map((p) => [p.notice?.kind, (p.notice as { cardId: string }).cardId]),
    [
      ["card_review", "child"],
      ["card_review", "root"],
    ],
  );
  assert.equal(h.posted[0].senderKind, "npc");
  assert.equal(h.posted[0].content, "보고서 초안", "content 는 로케일 무관 폴백 = 카드 제목");
});

test("if the assigned NPC is asleep or not in the channel, a system message — NPC name before the body (R22)", async () => {
  for (const lookup of [SOPHIE_ASLEEP, SOPHIE_ABSENT]) {
    const h = harness({ npcs: { sophie: lookup } });
    await ingest(CHANNEL, [statusEvent({ to: "done" })], h.deps);
    assert.equal(h.posted.length, 1);
    const post = h.posted[0];
    assert.equal(post.senderKind, "system");
    assert.equal(post.senderId, null);
    assert.equal(post.senderName, "소피");
    assert.equal(post.content, "소피: 보고서 초안");
    assert.equal(noticeNpcName(post.notice), "소피");
  }
});

test("if the profile itself vanished from the gateway, the profile name is used as-is — nothing is missed", async () => {
  const h = harness({ npcs: {} });
  await ingest(CHANNEL, [statusEvent({ to: "blocked", assignee: "ghost" })], h.deps);
  assert.equal(h.posted.length, 1);
  assert.equal(h.posted[0].senderKind, "system");
  assert.equal(h.posted[0].content, "ghost: 보고서 초안");
});

test("a notice for an unassigned card is a nameless system message", async () => {
  const h = harness();
  await ingest(CHANNEL, [statusEvent({ to: "blocked", assignee: null })], h.deps);
  assert.equal(h.posted.length, 1);
  assert.equal(h.posted[0].senderKind, "system");
  assert.equal(h.posted[0].senderName, "");
  assert.equal(h.posted[0].content, "보고서 초안");
  assert.equal(noticeNpcName(h.posted[0].notice), "");
});

test("if the office room cannot be secured, posting is skipped but the broadcast still goes out", async () => {
  const h = harness({ npcs: { sophie: SOPHIE_ACTIVE }, officeRoomId: null });
  const result = await ingest(CHANNEL, [statusEvent({ to: "done" })], h.deps);
  assert.equal(h.posted.length, 0);
  assert.equal(result.processed, 1);
  assert.equal(h.emitted.filter((e) => e.event === AUTOMATION_SOCKET_EVENTS.kanban).length, 1);
});

test("cron.run.finished — if the origin is this channel, posts the result under the assigned NPC's name", async () => {
  const h = harness({
    npcs: { sophie: SOPHIE_ACTIVE },
    origins: { [`${GATEWAY}/sophie/job-1`]: { channelId: CHANNEL, gatewayId: GATEWAY } },
  });
  await ingest(CHANNEL, [cronFinished({})], h.deps);
  assert.equal(h.posted.length, 1);
  const post = h.posted[0];
  assert.equal(post.senderKind, "npc");
  assert.equal(post.senderName, "소피");
  assert.equal(post.content, "오늘의 브리핑입니다");
  assert.deepEqual(post.notice, {
    kind: "cron_result",
    jobId: "job-1",
    jobName: "아침 브리핑",
    npcName: "소피",
    status: "ok",
  });
});

test("cron result — not posted for another channel, no origin, or a different gateway", async () => {
  const cases: Array<{
    name: string;
    origins: Record<string, { channelId: string; gatewayId: string }>;
  }> = [
    {
      name: "다른 채널",
      origins: { [`${GATEWAY}/sophie/job-1`]: { channelId: "other", gatewayId: GATEWAY } },
    },
    { name: "출처 없음", origins: {} },
    {
      name: "다른 게이트웨이",
      origins: { [`${GATEWAY}/sophie/job-1`]: { channelId: CHANNEL, gatewayId: "gateway-old" } },
    },
  ];
  for (const c of cases) {
    const h = harness({ npcs: { sophie: SOPHIE_ACTIVE }, origins: c.origins });
    await ingest(CHANNEL, [cronFinished({})], h.deps);
    assert.equal(h.posted.length, 0, c.name);
    assert.equal(
      h.emitted.filter((e) => e.event === AUTOMATION_SOCKET_EVENTS.cron).length,
      1,
      `${c.name}: 방송은 나간다`,
    );
  }
});

test("cron result — error is the error summary, an empty result is stored empty, long result is truncated with '…' (E8)", async () => {
  const origins = { [`${GATEWAY}/sophie/job-1`]: { channelId: CHANNEL, gatewayId: GATEWAY } };
  const npcs = { sophie: SOPHIE_ACTIVE };

  let h = harness({ npcs, origins });
  await ingest(CHANNEL, [cronFinished({ status: "error", result_text: "API 429" })], h.deps);
  assert.equal(h.posted[0].content, "API 429");
  assert.equal(h.posted[0].notice?.kind === "cron_result" && h.posted[0].notice.status, "error");

  h = harness({ npcs, origins });
  await ingest(CHANNEL, [cronFinished({ status: "error", result_text: "  " })], h.deps);
  assert.equal(h.posted[0].content, "");
  assert.equal(h.posted[0].notice?.kind === "cron_result" && h.posted[0].notice.status, "error");

  h = harness({ npcs, origins });
  await ingest(CHANNEL, [cronFinished({ status: "ok", result_text: "" })], h.deps);
  assert.equal(h.posted[0].content, "");

  h = harness({ npcs, origins, maxResultLength: 10 });
  await ingest(CHANNEL, [cronFinished({ result_text: "가".repeat(25) })], h.deps);
  assert.equal(h.posted[0].content, "가".repeat(10) + "…");
});

test("cron result — if the assigned NPC is asleep, a system message + name prefix", async () => {
  const h = harness({
    npcs: { sophie: SOPHIE_ASLEEP },
    origins: { [`${GATEWAY}/sophie/job-1`]: { channelId: CHANNEL, gatewayId: GATEWAY } },
  });
  await ingest(CHANNEL, [cronFinished({})], h.deps);
  assert.equal(h.posted[0].senderKind, "system");
  assert.equal(h.posted[0].content, "소피: 오늘의 브리핑입니다");
});

test("cron result — an empty result from an asleep NPC gets no dangling name prefix", async () => {
  const h = harness({
    npcs: { sophie: SOPHIE_ASLEEP },
    origins: { [`${GATEWAY}/sophie/job-1`]: { channelId: CHANNEL, gatewayId: GATEWAY } },
  });
  await ingest(CHANNEL, [cronFinished({ status: "error", result_text: "" })], h.deps);
  assert.equal(h.posted[0].senderKind, "system");
  assert.equal(h.posted[0].content, "");
});

test("cron.run.started changes only map state, without a room post", async () => {
  const h = harness({ npcs: { sophie: SOPHIE_ACTIVE } });
  await ingest(
    CHANNEL,
    [
      ev({
        kind: "cron.run.started",
        board: undefined,
        profile: "sophie",
        job_id: "job-1",
        run_id: "r1",
      }),
    ],
    h.deps,
  );
  assert.equal(h.posted.length, 0);
  assert.deepEqual(workingEvents(h.emitted), [
    { npcId: "npc-sophie", working: true, sources: { runningCards: 0, cronRuns: 1 } },
  ]);
});

test("the same event ID is not processed twice — broadcast, post and state alike", async () => {
  const h = harness({ npcs: { sophie: SOPHIE_ACTIVE } });
  const done = statusEvent({ to: "done", id: "ev_dup" });
  await ingest(CHANNEL, [done], h.deps);
  const second = await ingest(CHANNEL, [done, { ...done }], h.deps);
  assert.equal(h.posted.length, 1);
  assert.equal(h.emitted.filter((e) => e.event === AUTOMATION_SOCKET_EVENTS.kanban).length, 1);
  assert.equal(second.processed, 0);
  assert.equal(second.duplicates, 2);
});

test("the dedup set respects its size cap — forgets the oldest IDs first", async () => {
  const h = harness({ dedupeLimit: 2 });
  await ingest(
    CHANNEL,
    [statusEvent({ to: "running", id: "a" }), statusEvent({ to: "running", id: "b" })],
    h.deps,
  );
  await ingest(CHANNEL, [statusEvent({ to: "running", id: "c" })], h.deps);
  const again = await ingest(CHANNEL, [statusEvent({ to: "running", id: "a" })], h.deps);
  assert.equal(again.processed, 1, "a 는 잊혔으므로 다시 처리된다");
  const stillB = await ingest(CHANNEL, [statusEvent({ to: "running", id: "c" })], h.deps);
  assert.equal(stillB.duplicates, 1);
});

test("ingest broadcasts task.* as kanban:event and cron.* as cron:event to the channel", async () => {
  const h = harness({
    npcs: { x: { profileName: "x", displayName: "엑스", npc: { id: "npc-x", active: true } } },
  });
  const taskEv = ev({ kind: "task.created", task_id: "t1" });
  const cronEv = ev({ kind: "cron.run.started", board: undefined, profile: "x", job_id: "j" });
  await ingest(CHANNEL, [taskEv, cronEv], h.deps);
  const byEvent = (name: string) => h.emitted.filter((e) => e.event === name);
  assert.deepEqual(byEvent(AUTOMATION_SOCKET_EVENTS.kanban), [
    { channelId: CHANNEL, event: "kanban:event", payload: { channelId: CHANNEL, event: taskEv } },
  ]);
  assert.deepEqual(byEvent(AUTOMATION_SOCKET_EVENTS.cron), [
    { channelId: CHANNEL, event: "cron:event", payload: { channelId: CHANNEL, event: cronEv } },
  ]);
});

test("cron.* is broadcast as cron:event only when the profile resolves to an NPC of this channel — other profiles do not leak", async () => {
  const cronOf = (profile: string | undefined) =>
    ev({
      kind: "cron.run.started",
      board: undefined,
      profile,
      job_id: "j",
      run_id: `r-${profile}`,
    });
  const cronEvents = (h: ReturnType<typeof harness>) =>
    h.emitted.filter((e) => e.event === AUTOMATION_SOCKET_EVENTS.cron);

  // The profile is on the gateway but has no NPC row in this channel → no broadcast.
  const stranger = harness({
    npcs: { noah: { profileName: "noah", displayName: "노아", npc: null } },
  });
  await ingest(CHANNEL, [cronOf("noah")], stranger.deps);
  assert.equal(cronEvents(stranger).length, 0, "채널 밖 프로필");

  // The profile itself is not on the gateway → no broadcast.
  const unknown = harness();
  await ingest(CHANNEL, [cronOf("ghost")], unknown.deps);
  assert.equal(cronEvents(unknown).length, 0, "모르는 프로필");

  // An event without a profile → no broadcast.
  const anonymous = harness({ npcs: { sophie: SOPHIE_ACTIVE } });
  await ingest(CHANNEL, [cronOf(undefined)], anonymous.deps);
  assert.equal(cronEvents(anonymous).length, 0, "프로필 없는 사건");

  // Even a sleeping NPC is broadcast if it is an NPC of this channel (same criterion as the working tally).
  const dormant = harness({
    npcs: { sophie: { ...SOPHIE_ACTIVE, npc: { id: "npc-sophie", active: false } } },
  });
  await ingest(CHANNEL, [cronOf("sophie")], dormant.deps);
  assert.equal(cronEvents(dormant).length, 1, "잠든 NPC");
});

test("npc:working — turns on/off with run started/finished, and is not re-sent without a change", async () => {
  const h = harness({ npcs: { sophie: SOPHIE_ACTIVE } });
  const started = (task: string, id?: string) =>
    ev({ kind: "task.run.started", id, task_id: task, profile: "sophie", run_id: `run-${task}` });
  const finished = (task: string) =>
    ev({
      kind: "task.run.finished",
      task_id: task,
      run_id: `run-${task}`,
      payload: { status: "ok" },
    });

  await ingest(CHANNEL, [started("t1")], h.deps);
  assert.deepEqual(workingEvents(h.emitted), [
    { npcId: "npc-sophie", working: true, sources: { runningCards: 1, cronRuns: 0 } },
  ]);

  // End of an unknown run, a card already gone — if the state is unchanged there is no broadcast either.
  await ingest(CHANNEL, [finished("unknown")], h.deps);
  assert.equal(workingEvents(h.emitted).length, 1);

  await ingest(CHANNEL, [started("t2")], h.deps);
  assert.deepEqual(workingEvents(h.emitted).at(-1), {
    npcId: "npc-sophie",
    working: true,
    sources: { runningCards: 2, cronRuns: 0 },
  });

  await ingest(CHANNEL, [finished("t1")], h.deps);
  assert.equal(workingEvents(h.emitted).at(-1)!.sources.runningCards, 1);
  assert.deepEqual(getWorkingSnapshot(CHANNEL, h.deps.state), [
    { npcId: "npc-sophie", working: true, sources: { runningCards: 1, cronRuns: 0 } },
  ]);

  await ingest(CHANNEL, [finished("t2")], h.deps);
  assert.deepEqual(workingEvents(h.emitted).at(-1), {
    npcId: "npc-sophie",
    working: false,
    sources: { runningCards: 0, cronRuns: 0 },
  });
  assert.deepEqual(getWorkingSnapshot(CHANNEL, h.deps.state), [], "끝난 NPC 는 스냅샷에서 빠진다");
  assert.equal(workingEvents(h.emitted).length, 4);
});

test("npc:working — with both a card and a cron, it turns off only when both finish; sleeping NPCs are counted too", async () => {
  const h = harness({ npcs: { sophie: SOPHIE_ASLEEP } });
  await ingest(
    CHANNEL,
    [
      ev({ kind: "task.run.started", task_id: "t1", profile: "sophie", run_id: "r1" }),
      ev({
        kind: "cron.run.started",
        board: undefined,
        profile: "sophie",
        job_id: "j1",
        run_id: "cr1",
      }),
    ],
    h.deps,
  );
  assert.deepEqual(workingEvents(h.emitted).at(-1), {
    npcId: "npc-sophie",
    working: true,
    sources: { runningCards: 1, cronRuns: 1 },
  });
  await ingest(
    CHANNEL,
    [
      ev({
        kind: "cron.run.finished",
        board: undefined,
        profile: "sophie",
        job_id: "j1",
        run_id: "cr1",
      }),
    ],
    h.deps,
  );
  assert.deepEqual(workingEvents(h.emitted).at(-1)!.sources, { runningCards: 1, cronRuns: 0 });
  assert.equal(workingEvents(h.emitted).at(-1)!.working, true);
});

test("even if a dependency throws, other events keep processing and the failure is recorded in the result", async () => {
  const h = harness({ npcs: { sophie: SOPHIE_ACTIVE } });
  let calls = 0;
  h.deps.appendRoomMessage = async () => {
    calls += 1;
    throw new Error("db down");
  };
  const result = await ingest(
    CHANNEL,
    [statusEvent({ to: "done", task_id: "a" }), statusEvent({ to: "done", task_id: "b" })],
    h.deps,
  );
  assert.equal(calls, 2);
  assert.equal(result.processed, 2);
  assert.deepEqual(result.errors.length, 2);
  assert.match(result.errors[0], /db down/);
});

// ---- card_proposal.created ------------------------------------------------
// A proposal is not a card — Hermes is the source of truth and DeskRPG keeps only one room notice.

function proposalEvent(
  payload: Record<string, unknown> = {},
  profile: string | undefined = "sophie",
) {
  return ev({
    kind: "card_proposal.created",
    profile,
    payload: {
      proposal_id: "0123456789abcdef0123456789abcdef",
      title: "주간 보고 정리",
      summary: "금요일마다 모은다",
      profile: profile ?? "sophie",
      ...payload,
    },
  });
}

test("card_proposal.created creates 1 office room notice — no socket event", async () => {
  const h = harness({ npcs: { sophie: SOPHIE_ACTIVE } });
  await ingest(CHANNEL, [proposalEvent()], h.deps);

  assert.equal(h.posted.length, 1);
  const post = h.posted[0];
  assert.equal(post.roomId, "office-room");
  assert.equal(post.senderKind, "npc");
  assert.equal(post.senderId, "npc-sophie");
  assert.equal(post.content, "주간 보고 정리", "content 는 로케일 무관 폴백 = 제안 제목");
  assert.deepEqual(post.notice, {
    kind: "card_proposal",
    proposalId: "0123456789abcdef0123456789abcdef",
    title: "주간 보고 정리",
    summary: "금요일마다 모은다",
    npcId: "npc-sophie",
    npcName: "소피",
  });
  assert.equal(post.notice?.kind === "card_proposal" && post.notice.resolved, undefined);
  assert.equal(h.emitted.length, 0, "새 소켓 이벤트를 만들지 않는다");
  assert.equal(h.roomEmits.length, 1, "저장한 메시지를 방 소켓으로 방송한다");
});

test("body·acceptance are included in the notice only when present", async () => {
  const h = harness({ npcs: { sophie: SOPHIE_ACTIVE } });
  await ingest(CHANNEL, [proposalEvent({ body: "본문", acceptance: "완료 조건" })], h.deps);
  const notice = h.posted[0].notice;
  assert.ok(notice?.kind === "card_proposal");
  assert.equal(notice.body, "본문");
  assert.equal(notice.acceptance, "완료 조건");
});

test("no proposal notice if the profile is not an NPC of this channel — not an error either", async () => {
  const h = harness({ npcs: {} });
  const result = await ingest(CHANNEL, [proposalEvent()], h.deps);
  assert.equal(h.posted.length, 0);
  assert.deepEqual(result.errors, []);
});

test("a sleeping NPC's proposal is not missed either — posted as a system message", async () => {
  const h = harness({ npcs: { sophie: SOPHIE_ASLEEP } });
  await ingest(CHANNEL, [proposalEvent()], h.deps);
  assert.equal(h.posted.length, 1);
  assert.equal(h.posted[0].senderKind, "system");
  assert.equal(h.posted[0].content, "소피: 주간 보고 정리");
  assert.equal(
    h.posted[0].notice?.kind === "card_proposal" && h.posted[0].notice.npcId,
    "npc-sophie",
  );
});

test("a proposal event without proposal_id or title is dropped", async () => {
  const h = harness({ npcs: { sophie: SOPHIE_ACTIVE } });
  const result = await ingest(
    CHANNEL,
    [proposalEvent({ proposal_id: undefined }), proposalEvent({ title: "" })],
    h.deps,
  );
  assert.equal(h.posted.length, 0);
  assert.deepEqual(result.errors, []);
});

// ---------------------------------------------------------------------------
// approval.blocked — a private notice for whoever ordered the blocked run
// ---------------------------------------------------------------------------

function blockedHarness(
  opts: {
    origin?: { channelId: string; gatewayId: string; createdByUserId?: string | null } | null;
    card?: { title: string; createdBy: string | null } | null;
    members?: string[];
    owner?: string | null;
  } = {},
) {
  const h = harness({
    npcs: {
      sophie: { profileName: "sophie", displayName: "Sophie", npc: { id: "npc-1", active: true } },
    },
  });
  const cardLookups: Array<{ taskId: string; board?: string }> = [];
  h.deps.findCronOriginChannel = async () =>
    opts.origin === undefined
      ? { channelId: CHANNEL, gatewayId: GATEWAY, createdByUserId: "user-creator" }
      : opts.origin;
  h.deps.findChannelCard = async (_c, taskId, board) => {
    cardLookups.push({ taskId, board });
    return opts.card === undefined
      ? { title: "Weekly report", createdBy: "deskrpg:user-requester" }
      : opts.card;
  };
  h.deps.isChannelMember = async (_c, userId) =>
    (opts.members ?? ["user-creator", "user-requester", "user-owner"]).includes(userId);
  h.deps.getChannelOwnerId = async () => (opts.owner === undefined ? "user-owner" : opts.owner);
  return { ...h, cardLookups };
}

function blocked(payload: Record<string, unknown>) {
  return ev({
    kind: "approval.blocked",
    profile: "sophie",
    payload: { profile: "sophie", ...payload },
  });
}

test("a blocked cron run notifies the cron's creator privately — no channel socket event", async () => {
  const h = blockedHarness();
  await ingest(
    CHANNEL,
    [
      blocked({
        source: "cron",
        kind: "command",
        jobId: "job-1",
        tool: "terminal",
        command: "rm -r /tmp/probe",
        patternKey: "recursive delete",
        patternDescription: "recursive delete",
      }),
    ],
    h.deps,
  );
  assert.equal(h.emitted.length, 0);
  assert.equal(h.posted.length, 1);
  assert.deepEqual(h.posted[0].notice, {
    kind: "approval_blocked",
    audience: "user-creator",
    npcId: "npc-1",
    npcName: "Sophie",
    source: "cron",
    blockKind: "command",
    tool: "terminal",
    jobId: "job-1",
    command: "rm -r /tmp/probe",
    patternKey: "recursive delete",
    patternDescription: "recursive delete",
  });
  assert.equal(h.roomEmits.length, 1);
});

test("a blocked cron run carries the job name the plugin read (0.18.1)", async () => {
  const h = blockedHarness();
  await ingest(
    CHANNEL,
    [
      blocked({
        source: "cron",
        kind: "command",
        jobId: "job-1",
        jobName: "야간 정리",
        tool: "terminal",
      }),
    ],
    h.deps,
  );
  assert.equal((h.posted[0].notice as { jobName?: string }).jobName, "야간 정리");
});

test("a blocked cron run from another channel or gateway is not announced here", async () => {
  for (const origin of [
    null,
    { channelId: "other-channel", gatewayId: GATEWAY, createdByUserId: "user-creator" },
    { channelId: CHANNEL, gatewayId: "other-gateway", createdByUserId: "user-creator" },
  ]) {
    const h = blockedHarness({ origin });
    await ingest(
      CHANNEL,
      [blocked({ source: "cron", kind: "command", jobId: "job-1", tool: "terminal" })],
      h.deps,
    );
    assert.equal(h.posted.length, 0, JSON.stringify(origin));
  }
});

test("a blocked kanban run notifies the card's requester, looking at the reported board first", async () => {
  const h = blockedHarness();
  await ingest(
    CHANNEL,
    [
      blocked({
        source: "kanban",
        kind: "mcp",
        taskId: "task-9",
        board: "team-board",
        tool: "mcp_call",
        mcpTool: "write_note",
        mcpServer: "notes",
      }),
    ],
    h.deps,
  );
  assert.deepEqual(h.cardLookups, [{ taskId: "task-9", board: "team-board" }]);
  const notice = h.posted[0].notice as Record<string, unknown>;
  assert.equal(notice.audience, "user-requester");
  assert.equal(notice.taskId, "task-9");
  assert.equal(notice.taskTitle, "Weekly report");
  assert.equal(notice.blockKind, "mcp");
  assert.equal(notice.tool, "write_note");
  assert.equal(notice.mcpServer, "notes");
  assert.equal(h.posted[0].content, "write_note");
});

test("a card without a DeskRPG requester, or whose requester left, notifies the channel owner", async () => {
  for (const [card, members] of [
    [{ title: "Old card", createdBy: null }, undefined],
    [{ title: "Profile card", createdBy: "sophie" }, undefined],
    [{ title: "Left", createdBy: "deskrpg:user-gone" }, ["user-owner"]],
  ] as const) {
    const h = blockedHarness({ card, members: members ? [...members] : undefined });
    await ingest(
      CHANNEL,
      [blocked({ source: "kanban", kind: "command", taskId: "t", tool: "terminal" })],
      h.deps,
    );
    assert.equal((h.posted[0].notice as { audience: string }).audience, "user-owner", card.title);
  }
});

test("a card that is not on this channel's boards is not announced; no owner means no notice", async () => {
  const notHere = blockedHarness({ card: null });
  await ingest(
    CHANNEL,
    [blocked({ source: "kanban", kind: "command", taskId: "t", tool: "terminal" })],
    notHere.deps,
  );
  assert.equal(notHere.posted.length, 0);

  const noOwner = blockedHarness({
    origin: { channelId: CHANNEL, gatewayId: GATEWAY, createdByUserId: null },
    owner: null,
  });
  await ingest(
    CHANNEL,
    [blocked({ source: "cron", kind: "command", jobId: "j", tool: "terminal" })],
    noOwner.deps,
  );
  assert.equal(noOwner.posted.length, 0);
});

test("an unknown source or a kanban block without a card lookup is dropped", async () => {
  const h = blockedHarness();
  await ingest(CHANNEL, [blocked({ source: "chat", kind: "command", tool: "terminal" })], h.deps);
  h.deps.findChannelCard = undefined;
  await ingest(
    CHANNEL,
    [blocked({ source: "kanban", kind: "command", taskId: "t", tool: "terminal" })],
    h.deps,
  );
  assert.equal(h.posted.length, 0);
});

test("npc:working counts running cards on every board of the channel, even when task ids repeat", async () => {
  const h = harness({ npcs: { sophie: SOPHIE_ACTIVE } });
  const research = { ...h.deps, boardSlug: "research-board" };
  const onBoard = (board: string, kind: "task.run.started" | "task.run.finished") =>
    ev({ kind, board, task_id: "t_0001", profile: "sophie", run_id: `run-${board}` });

  await ingest(CHANNEL, [onBoard(BOARD, "task.run.started")], h.deps);
  await ingest(CHANNEL, [onBoard("research-board", "task.run.started")], research);
  assert.equal(workingEvents(h.emitted).at(-1)!.sources.runningCards, 2);

  await ingest(CHANNEL, [onBoard("research-board", "task.run.finished")], research);
  assert.equal(
    workingEvents(h.emitted).at(-1)!.sources.runningCards,
    1,
    "finishing a card on one board leaves the same-id card on the other board running",
  );
});

test("a cron run clears working even when its session only shows up at the finish (the real plugin's events)", async () => {
  // The plugin names both halves of one execution `c:<profile>:<execution>:<phase>` and sends no run_id. The start is
  // read while the run is still going, before the session row exists — so only the finish carries a session_id.
  const h = harness({ npcs: { sophie: SOPHIE_ACTIVE } });
  await ingest(
    CHANNEL,
    [
      ev({
        id: "c:sophie:exec-7:started",
        kind: "cron.run.started",
        board: undefined,
        profile: "sophie",
        job_id: "job-1",
        payload: { job_id: "job-1", profile: "sophie", session_id: null },
      }),
    ],
    h.deps,
  );
  await ingest(
    CHANNEL,
    [
      ev({
        id: "c:sophie:exec-7:finished",
        kind: "cron.run.finished",
        board: undefined,
        profile: "sophie",
        job_id: "job-1",
        payload: { job_id: "job-1", profile: "sophie", session_id: "sess-9", status: "ok" },
      }),
    ],
    h.deps,
  );
  assert.deepEqual(workingEvents(h.emitted).at(-1), {
    npcId: "npc-sophie",
    working: false,
    sources: { runningCards: 0, cronRuns: 0 },
  });
});

test("two runs of the same cron job are counted apart", async () => {
  const h = harness({ npcs: { sophie: SOPHIE_ACTIVE } });
  const started = (exec: string) =>
    ev({
      id: `c:sophie:${exec}:started`,
      kind: "cron.run.started",
      board: undefined,
      profile: "sophie",
      job_id: "job-1",
      payload: { job_id: "job-1", profile: "sophie", session_id: null },
    });
  await ingest(CHANNEL, [started("exec-1"), started("exec-2")], h.deps);
  assert.equal((workingEvents(h.emitted).at(-1) as NpcWorkingPayload).sources.cronRuns, 2);
});
