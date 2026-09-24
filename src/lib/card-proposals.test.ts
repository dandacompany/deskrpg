// Resolve domain logic — ordering, exactly once, roll back on failure.
import assert from "node:assert/strict";
import test from "node:test";

import {
  ProposalStepError,
  resolveProposal,
  type CardProposalNotice,
  type ProposalAssigneeResult,
  type ProposalRecord,
  type ProposalTaskInput,
  type ResolveDeps,
} from "./card-proposals";

type Ctx = { channelId: string };

const NOTICE: CardProposalNotice = {
  kind: "card_proposal",
  proposalId: "p1",
  title: "청구서 정리",
  summary: "8월 청구서를 모아 달라",
  body: "본문",
  acceptance: "표로 정리",
  npcId: "npc-1",
  npcName: "노아",
};

type Stub = ResolveDeps<Ctx> & {
  createTaskCalls: number;
  noticeUpdates: number;
  /** Count of `unresolve` attempts — counted separately from success. */
  rollbacks: number;
  /** Count of rollbacks that actually succeeded. */
  rollbacksDone: number;
  tasks: ProposalTaskInput[];
  /** The `(proposalId, taskId)` pairs `recordTask` received. */
  recordedTasks: Array<{ proposalId: string; taskId: string }>;
  order: string[];
  resolvedWrites: NonNullable<CardProposalNotice["resolved"]>[];
};

function gateError(status: number, code: string): ProposalStepError {
  return new ProposalStepError(status, code);
}

function stubDeps(over: {
  gate?: ResolveDeps<Ctx>["gate"];
  proposal?: ProposalRecord | null;
  markResolved?: () => Promise<boolean>;
  unresolve?: () => Promise<void>;
  assignee?: ProposalAssigneeResult;
  createTask?: () => Promise<{ task: { id: string } }>;
  recordTask?: () => Promise<void>;
  writeResolved?: () => Promise<void>;
}): Stub {
  const stub: Stub = {
    createTaskCalls: 0,
    noticeUpdates: 0,
    rollbacks: 0,
    rollbacksDone: 0,
    tasks: [],
    recordedTasks: [],
    order: [],
    resolvedWrites: [],
    now: () => new Date("2026-09-21T00:00:00.000Z"),
    gate:
      over.gate ??
      (async ({ channelId }) => {
        stub.order.push("gate");
        return { ok: true, ctx: { channelId } };
      }),
    loadProposal: async () => {
      stub.order.push("loadProposal");
      return over.proposal === undefined ? { messageId: "m1", notice: NOTICE } : over.proposal;
    },
    markResolved: async () => {
      stub.order.push("markResolved");
      return over.markResolved ? await over.markResolved() : true;
    },
    unresolve: async () => {
      stub.rollbacks += 1;
      stub.order.push("unresolve");
      if (over.unresolve) await over.unresolve();
      stub.rollbacksDone += 1;
    },
    resolveAssignee: async () => {
      stub.order.push("resolveAssignee");
      return over.assignee ?? { ok: true, profileName: "noah" };
    },
    createTask: async ({ task }) => {
      stub.createTaskCalls += 1;
      stub.tasks.push(task);
      stub.order.push("createTask");
      if (over.createTask) return await over.createTask();
      return { task: { id: "t1" } };
    },
    recordTask: async ({ proposalId, taskId }) => {
      stub.recordedTasks.push({ proposalId, taskId });
      stub.order.push("recordTask");
      if (over.recordTask) await over.recordTask();
    },
    writeResolved: async ({ resolved }) => {
      stub.noticeUpdates += 1;
      stub.order.push("writeResolved");
      stub.resolvedWrites.push(resolved);
      if (over.writeResolved) await over.writeResolved();
    },
  };
  return stub;
}

const CARD = { channelId: "c1", userId: "u1", proposalId: "p1", choice: "card" } as const;

test("choosing card creates a card and returns taskId", async () => {
  const deps = stubDeps({ createTask: async () => ({ task: { id: "t1" } }) });
  const out = await resolveProposal(CARD, deps);
  assert.deepEqual(out, { ok: true, choice: "card", taskId: "t1", assigneeDropped: false });
  assert.deepEqual(deps.tasks, [
    { title: "청구서 정리", body: "본문", acceptance: "표로 정리", assignee: "noah" },
  ]);
  assert.deepEqual(deps.resolvedWrites, [
    { choice: "card", by: "u1", at: "2026-09-21T00:00:00.000Z", taskId: "t1" },
  ]);
  // The created card's id is recorded on the proposal — this is what keeps the plugin's "can't be unresolved" guard alive.
  assert.deepEqual(deps.recordedTasks, [{ proposalId: "p1", taskId: "t1" }]);
  // gate → mark resolved → assignee → card → notice. This order is the rule.
  assert.deepEqual(deps.order, [
    "gate",
    "loadProposal",
    "markResolved",
    "resolveAssignee",
    "createTask",
    "recordTask",
    "writeResolved",
  ]);
});

test("an already-resolved proposal is 409 and creates no card", async () => {
  const deps = stubDeps({ markResolved: async () => false });
  const out = await resolveProposal(CARD, deps);
  assert.deepEqual(out, { ok: false, status: 409, code: "already_resolved" });
  assert.equal(deps.createTaskCalls, 0);
  assert.equal(deps.noticeUpdates, 0);
});

test("a card-creation failure does not record the resolution", async () => {
  const deps = stubDeps({
    createTask: async () => {
      throw gateError(428, "plugin_required");
    },
  });
  const out = await resolveProposal(CARD, deps);
  assert.deepEqual(out, {
    ok: false,
    status: 428,
    code: "plugin_required",
    message: "plugin_required",
  });
  assert.equal(deps.noticeUpdates, 0); // notice_json.resolved was not written
  assert.equal(deps.rollbacks, 1); // the plugin-side resolved marker was also rolled back
});

test("if the rollback fails, that fact is surfaced in the error", async () => {
  const deps = stubDeps({
    createTask: async () => {
      throw gateError(503, "board_unavailable");
    },
    unresolve: async () => {
      throw new Error("gateway offline");
    },
  });
  const out = await resolveProposal(CARD, deps);
  assert.equal(out.ok, false);
  assert.equal(out.ok === false && out.status, 500);
  assert.equal(out.ok === false && out.code, "resolve_rollback_failed");
  const message = out.ok === false ? (out.message ?? "") : "";
  assert.match(message, /board_unavailable/);
  assert.match(message, /gateway offline/);
  assert.equal(deps.noticeUpdates, 0);
});

test("if the assignee has clocked out, creates the card with no assignee and flags the fact", async () => {
  const deps = stubDeps({
    assignee: { ok: false, code: "assignee_not_in_channel" },
    createTask: async () => ({ task: { id: "t1" } }),
  });
  const out = await resolveProposal(CARD, deps);
  assert.deepEqual(out, { ok: true, choice: "card", taskId: "t1", assigneeDropped: true });
  assert.deepEqual(deps.tasks, [{ title: "청구서 정리", body: "본문", acceptance: "표로 정리" }]);
});

test("even if recording the card id fails, the flow stays intact — all that's lost is a second line of defense", async () => {
  const deps = stubDeps({
    recordTask: async () => {
      throw new ProposalStepError(409, "card_proposal_task_not_recordable");
    },
  });
  const out = await resolveProposal(CARD, deps);
  assert.deepEqual(out, { ok: true, choice: "card", taskId: "t1", assigneeDropped: false });
  assert.equal(deps.noticeUpdates, 1); // notice_json.resolved is still written normally
  assert.equal(deps.rollbacks, 0);
});

test("choosing inline creates no card", async () => {
  const deps = stubDeps({});
  const out = await resolveProposal({ ...CARD, choice: "inline" }, deps);
  assert.deepEqual(out, { ok: true, choice: "inline" });
  assert.equal(deps.createTaskCalls, 0);
  assert.deepEqual(deps.order, ["gate", "loadProposal", "markResolved", "writeResolved"]);
  assert.deepEqual(deps.recordedTasks, []); // no card, so nothing to record
  assert.deepEqual(deps.resolvedWrites, [
    { choice: "inline", by: "u1", at: "2026-09-21T00:00:00.000Z" },
  ]);
});

test("if the gate blocks, the plugin is never touched", async () => {
  const deps = stubDeps({
    gate: async () => ({ ok: false, status: 409, code: "gateway_not_bound" }),
  });
  const out = await resolveProposal(CARD, deps);
  assert.deepEqual(out, { ok: false, status: 409, code: "gateway_not_bound" });
  assert.deepEqual(deps.order, []);
  assert.equal(deps.createTaskCalls, 0);
});

test("a missing proposal is 404 and doesn't mark resolved", async () => {
  const deps = stubDeps({ proposal: null });
  const out = await resolveProposal(CARD, deps);
  assert.deepEqual(out, { ok: false, status: 404, code: "card_proposal_not_found" });
  assert.deepEqual(deps.order, ["gate", "loadProposal"]);
});

test("a notice already carrying resolved gets 409 before the plugin is even called", async () => {
  const deps = stubDeps({
    proposal: {
      messageId: "m1",
      notice: {
        ...NOTICE,
        resolved: { choice: "card", by: "u1", at: "2026-09-20T00:00:00.000Z", taskId: "t0" },
      },
    },
  });
  const out = await resolveProposal(CARD, deps);
  assert.deepEqual(out, { ok: false, status: 409, code: "already_resolved" });
  assert.deepEqual(deps.order, ["gate", "loadProposal"]);
});

test("a notice-write failure leaves the fact that the card was created in the error", async () => {
  const deps = stubDeps({
    writeResolved: async () => {
      throw new Error("db down");
    },
  });
  const out = await resolveProposal(CARD, deps);
  assert.equal(out.ok, false);
  assert.equal(out.ok === false && out.code, "notice_write_failed");
  assert.match(out.ok === false ? (out.message ?? "") : "", /t1/);
  // The asymmetry is intentional — the card is not rolled back because it's Hermes's source of truth.
  assert.equal(deps.rollbacks, 0);
});

test("inline + a notice-write failure rolls back so the user can choose again", async () => {
  const deps = stubDeps({
    writeResolved: async () => {
      throw new Error("db down");
    },
  });
  const out = await resolveProposal({ ...CARD, choice: "inline" }, deps);
  assert.deepEqual(out, {
    ok: false,
    status: 500,
    code: "notice_write_failed",
    message: "db down",
  });
  assert.equal(deps.createTaskCalls, 0);
  assert.equal(deps.rollbacks, 1); // no card exists, so it can be rolled back
  assert.equal(deps.rollbacksDone, 1);
  assert.deepEqual(deps.order, [
    "gate",
    "loadProposal",
    "markResolved",
    "writeResolved",
    "unresolve",
  ]);
});

test("if the inline rollback fails, that fact is surfaced in the error", async () => {
  const deps = stubDeps({
    writeResolved: async () => {
      throw new Error("db down");
    },
    unresolve: async () => {
      throw new Error("gateway offline");
    },
  });
  const out = await resolveProposal({ ...CARD, choice: "inline" }, deps);
  assert.equal(out.ok === false && out.code, "resolve_rollback_failed");
  assert.equal(out.ok === false && out.status, 500);
  const message = out.ok === false ? (out.message ?? "") : "";
  assert.match(message, /notice_write_failed/);
  assert.match(message, /gateway offline/);
  assert.equal(deps.rollbacks, 1);
  assert.equal(deps.rollbacksDone, 0); // it was attempted but did not succeed
});
