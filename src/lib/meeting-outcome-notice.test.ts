// The meeting-outcome room notice — when to raise it (a pure judgment), and whether it stays
// in the room and gets rewritten after registration (a throwaway SQLite).
import assert from "node:assert/strict";
import test from "node:test";

import type { MeetingOutcome } from "@/lib/meeting-outcome";
import { seedChannel, seedUser, setupThrowawaySqlite } from "@/test-setup/npc-seed";

import { buildMeetingOutcomeNotice, shouldAnnounceOutcome } from "./meeting-outcome-notice";

setupThrowawaySqlite("meeting-outcome-notice-test");

const followUp = {
  title: "경쟁사 가격 조사",
  summary: null,
  acceptance: null,
  assigneeNpcId: null,
  assigneeName: null,
  after: [],
};

const outcome: MeetingOutcome = {
  decisions: ["A안 채택"],
  followUps: [followUp, { ...followUp, title: "초안 작성" }],
  project: { recommended: true, name: "가격 개편", reason: null },
};

test("announces only when there are follow-ups and the summary succeeded", () => {
  assert.equal(shouldAnnounceOutcome(outcome, "ok"), true);
  // Most meetings are short check-ins — leaving a row with nothing to propose would fill the room with noise.
  assert.equal(shouldAnnounceOutcome({ ...outcome, followUps: [] }, "ok"), false);
  assert.equal(shouldAnnounceOutcome(null, "ok"), false);
  // A summary failure differs from "nothing to propose." A failure prompts the meeting screen to retry — it doesn't stay in the room.
  assert.equal(shouldAnnounceOutcome(outcome, "failed"), false);
  assert.equal(shouldAnnounceOutcome(outcome, "skipped"), false);
});

test("the notice carries only the id and count — never a stale-prone copy like a project name", () => {
  assert.deepEqual(buildMeetingOutcomeNotice({ minutesId: "m-1", topic: "가격 개편", outcome }), {
    kind: "meeting_outcome",
    minutesId: "m-1",
    topic: "가격 개편",
    followUpCount: 2,
    recommended: true,
  });
});

async function officeNotices(channelId: string) {
  const { ensureOfficeRoom, recentRoomMessages, getChannelOwnerId } =
    await import("@/lib/chat-rooms");
  const ownerId = await getChannelOwnerId(channelId);
  assert.ok(ownerId);
  const room = await ensureOfficeRoom(channelId, ownerId!);
  const messages = await recentRoomMessages(room.id, 20);
  return messages.filter((m) => m.notice?.kind === "meeting_outcome");
}

async function seed() {
  const owner = await seedUser(`mon-${Math.random().toString(36).slice(2, 8)}`);
  const channel = await seedChannel(owner.id, "회의 알림 채널");
  return { ownerId: owner.id, channelId: channel.id };
}

test("announcing leaves a system notice in the office room and calls the broadcast hook", async () => {
  const { channelId } = await seed();
  const { registerAutomationHooks, resetAutomationHooksForTests } =
    await import("@/lib/automation-registry");
  const emitted: unknown[] = [];
  registerAutomationHooks({
    pollNow: async () => null,
    refreshPollers: async () => {},
    getWorkingSnapshot: () => [],
    emitRoomMessage: (_roomId: string, message: unknown) => {
      emitted.push(message);
    },
  });
  try {
    const { announceMeetingOutcome } = await import("./meeting-outcome-notice");
    await announceMeetingOutcome({
      channelId,
      minutesId: "m-2",
      topic: "가격 개편",
      outcome,
      summaryStatus: "ok",
    });
  } finally {
    resetAutomationHooksForTests();
  }

  const rows = await officeNotices(channelId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].senderKind, "system");
  assert.equal(rows[0].content, "가격 개편", "로케일 무관 폴백은 회의 주제다");
  assert.equal(emitted.length, 1, "저장만 하고 방송하지 않으면 새로고침 전까지 보이지 않는다");
});

test("if the conditions to announce aren't met, nothing is left in the room", async () => {
  const { channelId } = await seed();
  const { announceMeetingOutcome } = await import("./meeting-outcome-notice");
  await announceMeetingOutcome({
    channelId,
    minutesId: "m-3",
    topic: "확인",
    outcome: { ...outcome, followUps: [] },
    summaryStatus: "ok",
  });
  assert.equal((await officeNotices(channelId)).length, 0);
});

test("once registered, the result is rewritten into the same row — another meeting's notice is left untouched", async () => {
  const { channelId } = await seed();
  const { announceMeetingOutcome, markMeetingOutcomeNoticeRegistered } =
    await import("./meeting-outcome-notice");
  for (const minutesId of ["m-4", "m-40"])
    await announceMeetingOutcome({
      channelId,
      minutesId,
      topic: minutesId,
      outcome,
      summaryStatus: "ok",
    });

  const { registerAutomationHooks, resetAutomationHooksForTests } =
    await import("@/lib/automation-registry");
  const reEmitted: Array<{ id?: string; notice?: { minutesId?: string; resolved?: unknown } }> = [];
  registerAutomationHooks({
    pollNow: async () => null,
    refreshPollers: async () => {},
    getWorkingSnapshot: () => [],
    emitRoomMessage: (_roomId: string, message: unknown) => {
      reEmitted.push(message as (typeof reEmitted)[number]);
    },
  });
  try {
    await markMeetingOutcomeNoticeRegistered({
      channelId,
      minutesId: "m-4",
      registered: {
        boardSlug: "board-1",
        tenant: "가격-개편",
        taskIds: ["t1", "t2"],
        by: "user-1",
        at: "2026-09-21T00:00:00.000Z",
      },
    });
  } finally {
    resetAutomationHooksForTests();
  }
  // Rebroadcasts the rewritten row with the same id — otherwise an already-open screen keeps showing the register button until it's refreshed.
  assert.equal(reEmitted.length, 1);
  assert.equal(reEmitted[0].notice?.minutesId, "m-4");
  assert.ok(reEmitted[0].notice?.resolved);

  const byId = new Map(
    (await officeNotices(channelId)).map((m) => {
      assert.ok(m.notice?.kind === "meeting_outcome");
      return [m.notice.kind === "meeting_outcome" ? m.notice.minutesId : "", m.notice] as const;
    }),
  );
  const done = byId.get("m-4");
  assert.ok(done?.kind === "meeting_outcome");
  assert.deepEqual(done.kind === "meeting_outcome" ? done.resolved : null, {
    boardSlug: "board-1",
    tenant: "가격-개편",
    taskCount: 2,
    by: "user-1",
    at: "2026-09-21T00:00:00.000Z",
  });
  // `m-4` is a substring of `m-40` — after finding candidates with LIKE, the id must be matched exactly.
  const other = byId.get("m-40");
  assert.equal(other?.kind === "meeting_outcome" ? other.resolved : "x", undefined);
});

test("rewriting doesn't throw even with no notice row — it doesn't fail the registration", async () => {
  const { channelId } = await seed();
  const { markMeetingOutcomeNoticeRegistered } = await import("./meeting-outcome-notice");
  await markMeetingOutcomeNoticeRegistered({
    channelId,
    minutesId: "없는-회의",
    registered: { boardSlug: "b", tenant: null, taskIds: [], by: "u", at: "2026-09-21T00:00:00Z" },
  });
});
