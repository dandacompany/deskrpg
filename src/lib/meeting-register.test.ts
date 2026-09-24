import assert from "node:assert/strict";
import test from "node:test";

import type { MeetingOutcome } from "./meeting-outcome";
import {
  registerMeetingOutcome,
  type RegisterBatchInput,
  type RegisterMeetingDeps,
} from "./meeting-register";

const followUp = (title: string, after: number[] = [], assigneeNpcId: string | null = null) => ({
  title,
  summary: `${title} 요약`,
  acceptance: `${title} 완료 조건`,
  assigneeNpcId,
  assigneeName: null,
  after,
});

const outcome: MeetingOutcome = {
  decisions: ["A안 채택"],
  followUps: [followUp("조사", [], "npc-1"), followUp("초안", [0]), followUp("검토", [1])],
  project: { recommended: true, name: "가격 개편", reason: null },
};

const minutes = {
  id: "m1",
  channelId: "c1",
  topic: "가격 회의",
  initiatorId: "host",
  outcome,
};

type Recorded = {
  batches: RegisterBatchInput[];
  subprojects: Array<{ slug: string; name: string }>;
  saved: unknown[];
};

function deps(
  over: Partial<RegisterMeetingDeps> = {},
  ctx: { isChannelOwner: boolean; boardSlug: string } = { isChannelOwner: true, boardSlug: "b1" },
): RegisterMeetingDeps & Recorded {
  const rec: Recorded = { batches: [], subprojects: [], saved: [] };
  return {
    ...rec,
    loadMinutes: async () => minutes,
    loadChannelOwner: async () => "owner",
    resolveContext: async () => ({ ok: true, ctx }),
    ensureSubproject: async (_ctx, tenant) => {
      rec.subprojects.push(tenant);
    },
    createBatch: async (_ctx, input) => {
      rec.batches.push(input);
      return { ok: true, approvalId: "ap1", taskIds: input.items.map((_, i) => `t${i}`) };
    },
    saveRegistered: async (_id, registered) => {
      rec.saved.push(registered);
    },
    requesterForUser: (userId) => `user:${userId}`,
    now: () => "2026-09-21T00:00:00.000Z",
    ...over,
  };
}

const body = (
  items: Array<{ index: number; title?: string; npcId?: string | null; after?: number[] }>,
) => ({
  tenant: { slug: "가격-개편", name: "가격 개편" },
  items: items.map((item) => ({
    index: item.index,
    // Keeps the helper from blowing up first even when testing a nonexistent index — validation is the register function's job.
    title: item.title ?? outcome.followUps[item.index]?.title ?? "없는 항목",
    npcId: item.npcId ?? null,
    after: item.after ?? [],
  })),
});

test("passes the selected follow-ups as one approval batch and, once done, leaves a link in the minutes", async () => {
  const d = deps();
  const result = await registerMeetingOutcome(
    {
      minutesId: "m1",
      userId: "host",
      body: body([
        { index: 0, npcId: "npc-1" },
        { index: 1, after: [0] },
      ]),
    },
    d,
  );

  assert.equal(result.ok, true);
  const batch = d.batches[0];
  assert.equal(batch.type, "task_execution");
  assert.deepEqual(batch.source, { kind: "meeting", id: "m1" });
  assert.equal(batch.requestedBy, "user:host");
  assert.equal(batch.title, "가격 회의");
  assert.deepEqual(
    batch.items.map((item) => [
      item.title,
      item.npcId,
      item.tenant,
      item.parents,
      item.idempotencyKey,
    ]),
    [
      ["조사", "npc-1", "가격-개편", [], "meeting:m1:0"],
      // `after` is the meeting outcome's index (0), while `parents` is **the position within this batch** (0).
      ["초안", undefined, "가격-개편", [0], "meeting:m1:1"],
    ],
  );
  // The meeting decision must be findable from the card (D06 completion criterion).
  assert.match(batch.items[0].body ?? "", /조사 요약/);
  assert.match(batch.items[0].body ?? "", /조사 완료 조건/);
  assert.match(batch.items[0].body ?? "", /출처: 회의록 m1 — 가격 회의/);

  assert.deepEqual(d.saved, [
    {
      boardSlug: "b1",
      tenant: "가격-개편",
      taskIds: ["t0", "t1"],
      by: "host",
      at: "2026-09-21T00:00:00.000Z",
    },
  ]);
});

test("after is remapped to the batch's own position — still correct when only 1 and 2 are registered and 0 is excluded", async () => {
  const d = deps();
  await registerMeetingOutcome(
    { minutesId: "m1", userId: "host", body: body([{ index: 1 }, { index: 2, after: [1] }]) },
    d,
  );
  assert.deepEqual(
    d.batches[0].items.map((item) => item.parents),
    [[], [0]],
  );
});

test("if the requester is neither the host nor the owner, it's 403 and creates nothing", async () => {
  const d = deps();
  const result = await registerMeetingOutcome(
    { minutesId: "m1", userId: "member", body: body([{ index: 0 }]) },
    d,
  );
  assert.deepEqual(result, { ok: false, status: 403, errorCode: "forbidden" });
  assert.equal(d.batches.length, 0);
});

test("an already-registered meeting is 409", async () => {
  const registered = { boardSlug: "b1", tenant: null, taskIds: ["t"], by: "host", at: "x" };
  const d = deps({
    loadMinutes: async () => ({ ...minutes, outcome: { ...outcome, registered } }),
  });
  const result = await registerMeetingOutcome(
    { minutesId: "m1", userId: "host", body: body([{ index: 0 }]) },
    d,
  );
  assert.deepEqual(result, { ok: false, status: 409, errorCode: "already_registered" });
});

test("an index absent from the meeting outcome, a duplicate index, an empty list, or an after pointing outside the batch is 400", async () => {
  const bad = [
    body([]),
    body([{ index: 9 }]),
    body([{ index: 0 }, { index: 0 }]),
    body([{ index: 1, after: [0] }]), // Index 0 is not being registered this time
    { ...body([{ index: 0 }]), tenant: { slug: "Bad Slug", name: "x" } },
    { ...body([{ index: 0 }]), items: [{ index: 0, title: "   ", npcId: null, after: [] }] },
  ];
  for (const b of bad) {
    const d = deps();
    const result = await registerMeetingOutcome({ minutesId: "m1", userId: "host", body: b }, d);
    assert.equal(result.ok, false, JSON.stringify(b));
    // Must be a body-validation 400, not a gate rejection (`response`).
    assert.equal(!result.ok && "status" in result && result.status, 400, JSON.stringify(b));
    assert.equal(d.batches.length, 0);
  }
});

test("a rejection from the Kanban gate (no gateway, outdated plugin, someone else's board) is passed through as-is", async () => {
  const response = { status: 428 } as unknown as Response;
  const d = deps({ resolveContext: async () => ({ ok: false, response }) });
  const result = await registerMeetingOutcome(
    { minutesId: "m1", userId: "host", body: body([{ index: 0 }]) },
    d,
  );
  assert.deepEqual(result, { ok: false, response });
  assert.equal(d.batches.length, 0);
});

test("a sub-project metadata row is created only when the channel owner registers", async () => {
  const owner = deps({}, { isChannelOwner: true, boardSlug: "b1" });
  await registerMeetingOutcome(
    { minutesId: "m1", userId: "owner", body: body([{ index: 0 }]) },
    owner,
  );
  assert.deepEqual(owner.subprojects, [{ slug: "가격-개편", name: "가격 개편" }]);

  // The host registers but doesn't touch project metadata — that's a table only the owner
  // changes. The tenant still attaches to the card as-is, and a tenant with no metadata still
  // shows up in the view by its slug.
  const host = deps({}, { isChannelOwner: false, boardSlug: "b1" });
  const result = await registerMeetingOutcome(
    { minutesId: "m1", userId: "host", body: body([{ index: 0 }]) },
    host,
  );
  assert.equal(result.ok, true);
  assert.deepEqual(host.subprojects, []);
  assert.equal(host.batches[0].items[0].tenant, "가격-개편");
});

test("registers fine without a sub-project too", async () => {
  const d = deps();
  const result = await registerMeetingOutcome(
    { minutesId: "m1", userId: "host", body: { ...body([{ index: 0 }]), tenant: null } },
    d,
  );
  assert.equal(result.ok, true);
  assert.equal(d.batches[0].items[0].tenant, undefined);
  assert.deepEqual(d.subprojects, []);
});

test("if only some were created, it's not marked as fully registered — the button stays and a retry is idempotent", async () => {
  const d = deps({
    createBatch: async () => ({
      ok: true,
      approvalId: "ap1",
      taskIds: ["t0", null],
      failed: [{ index: 1, errorCode: "assignee_not_in_channel" }],
    }),
  });
  const result = await registerMeetingOutcome(
    { minutesId: "m1", userId: "host", body: body([{ index: 0 }, { index: 1 }]) },
    d,
  );
  assert.deepEqual(result, {
    ok: false,
    status: 502,
    errorCode: "partially_registered",
    // A failure is returned by the meeting outcome's index — so the screen can point at which line it was.
    failed: [{ index: 1, errorCode: "assignee_not_in_channel" }],
  });
  assert.deepEqual(d.saved, []);
});

test("if not a single card was created, returns the reason and saves nothing", async () => {
  const d = deps({ createBatch: async () => ({ ok: false, errorCode: "no_tasks_created" }) });
  const result = await registerMeetingOutcome(
    { minutesId: "m1", userId: "host", body: body([{ index: 0 }]) },
    d,
  );
  assert.deepEqual(result, { ok: false, status: 502, errorCode: "no_tasks_created" });
  assert.deepEqual(d.saved, []);
});
