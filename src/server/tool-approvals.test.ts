import test from "node:test";
import assert from "node:assert/strict";

import type { AdapterExecuteOptions, NpcAdapter } from "@/lib/adapters/types";
import { HermesError } from "@/lib/hermes/hermes-client";
import type { ParsedApprovalEvent } from "@/lib/tool-approval-event";
import type { ToolApprovalChoice } from "@/lib/tool-approval-types";

import {
  createApprovalTimeoutLookup,
  createToolApprovalRegistry,
  withToolApprovals,
  type PendingApproval,
} from "./tool-approvals";

type Emit = { to: string; event: string; payload: unknown };

function harness(opts: { resolved?: number; throws?: unknown } = {}) {
  const userEmits: Emit[] = [];
  const meetingEmits: Emit[] = [];
  const calls: { npcId: string; runId: string; body: unknown }[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  let clock = 1_000;
  const registry = createToolApprovalRegistry({
    now: () => clock,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      (h as { cleared: boolean }).cleared = true;
    },
    emitToUser: (to, event, payload) => userEmits.push({ to, event, payload }),
    emitToMeeting: (to, event, payload) => meetingEmits.push({ to, event, payload }),
    clientFor: async (npcId) => ({
      resolveRunApproval: async (runId, body) => {
        calls.push({ npcId, runId, body });
        if (opts.throws) throw opts.throws;
        return { resolved: opts.resolved ?? 1 };
      },
    }),
  });
  return {
    registry,
    userEmits,
    meetingEmits,
    calls,
    timers,
    tick: (ms: number) => (clock += ms),
  };
}

function req(patch: Partial<PendingApproval> = {}): PendingApproval {
  const runId = patch.runId ?? "run_1";
  const requestId = patch.requestId === undefined ? "req_1" : patch.requestId;
  return {
    key: `${runId}:${requestId ?? "0"}`,
    runId,
    requestId,
    npcId: "npc-sophie",
    channelId: "ch-1",
    context: "dm",
    kind: "mcp",
    command: "MCP tool 'write_note' on UNTRUSTED server 'probe' wants to run.",
    description: "untrusted MCP write tool",
    choices: ["once", "session", "deny"],
    expiresAt: 1_000 + 300_000,
    approverUserId: "user-dante",
    approverName: "Dante",
    ...patch,
  };
}

test("add sends the card only to the approver, without internal fields", () => {
  const h = harness();
  h.registry.add(req());
  assert.equal(h.userEmits.length, 1);
  assert.equal(h.userEmits[0].to, "user-dante");
  assert.equal(h.userEmits[0].event, "tool-approval:request");
  const payload = h.userEmits[0].payload as Record<string, unknown>;
  assert.equal(payload.key, "run_1:req_1");
  assert.equal("approverUserId" in payload, false);
  assert.equal(h.meetingEmits.length, 0);
  assert.equal(h.timers[0].ms, 300_000);
});

test("the approver's decision is sent to Hermes with the request id and closes the card", async () => {
  const h = harness();
  h.registry.add(req());
  assert.equal(await h.registry.decide("user-dante", "run_1:req_1", "session"), "ok");
  assert.deepEqual(h.calls, [
    { npcId: "npc-sophie", runId: "run_1", body: { choice: "session", request_id: "req_1" } },
  ]);
  assert.deepEqual(h.userEmits.at(-1), {
    to: "user-dante",
    event: "tool-approval:resolved",
    payload: { key: "run_1:req_1", status: "approved_session" },
  });
  assert.equal(h.timers[0].cleared, true);
  assert.deepEqual(h.registry.pendingFor("user-dante"), []);
});

test("without a request id the body carries only the choice", async () => {
  const h = harness();
  h.registry.add(req({ requestId: null }));
  assert.equal(await h.registry.decide("user-dante", "run_1:0", "once"), "ok");
  assert.deepEqual(h.calls[0].body, { choice: "once" });
});

test("someone other than the approver cannot decide", async () => {
  const h = harness();
  h.registry.add(req());
  assert.equal(await h.registry.decide("user-other", "run_1:req_1", "once"), "not_approver");
  assert.equal(h.calls.length, 0);
  assert.equal(h.registry.pendingFor("user-dante").length, 1);
});

test("always and unknown choices are refused before reaching Hermes", async () => {
  const h = harness();
  h.registry.add(req({ choices: ["once", "deny"] }));
  for (const choice of ["always", "yes", null, "session"]) {
    assert.equal(
      await h.registry.decide("user-dante", "run_1:req_1", choice as ToolApprovalChoice),
      "invalid_choice",
      String(choice),
    );
  }
  assert.equal(h.calls.length, 0);
});

test("a second decision on the same card is refused", async () => {
  const h = harness();
  h.registry.add(req());
  const [a, b] = await Promise.all([
    h.registry.decide("user-dante", "run_1:req_1", "once"),
    h.registry.decide("user-dante", "run_1:req_1", "deny"),
  ]);
  assert.deepEqual([a, b], ["ok", "closed"]);
  assert.equal(h.calls.length, 1);
});

test("two requests in one run are independent cards", async () => {
  const h = harness();
  h.registry.add(req({ requestId: "req_1" }));
  h.registry.add(req({ requestId: "req_2" }));
  assert.equal(await h.registry.decide("user-dante", "run_1:req_1", "deny"), "ok");
  const left = h.registry.pendingFor("user-dante");
  assert.deepEqual(
    left.map((r) => r.key),
    ["run_1:req_2"],
  );
});

test("the approval times out on its own timer", () => {
  const h = harness();
  h.registry.add(req());
  h.timers[0].fn();
  assert.deepEqual(h.userEmits.at(-1)?.payload, { key: "run_1:req_1", status: "expired" });
  assert.deepEqual(h.registry.pendingFor("user-dante"), []);
});

test("expireRun closes every card of that run and nothing else", () => {
  const h = harness();
  h.registry.add(req({ runId: "run_1", requestId: "a" }));
  h.registry.add(req({ runId: "run_1", requestId: "b" }));
  h.registry.add(req({ runId: "run_2", requestId: "a" }));
  h.registry.expireRun("run_1");
  assert.deepEqual(
    h.registry.pendingFor("user-dante").map((r) => r.key),
    ["run_2:a"],
  );
  const statuses = h.userEmits
    .filter((e) => e.event === "tool-approval:resolved")
    .map((e) => e.payload);
  assert.deepEqual(statuses, [
    { key: "run_1:a", status: "expired" },
    { key: "run_1:b", status: "expired" },
  ]);
});

test("Hermes with nothing waiting (resolved 0, 404, 409) closes the card as expired", async () => {
  for (const opts of [
    { resolved: 0 },
    { throws: new HermesError("unknown_profile", "gone", 404) },
    { throws: new HermesError("http_error", "conflict", 409) },
  ]) {
    const h = harness(opts);
    h.registry.add(req());
    assert.equal(await h.registry.decide("user-dante", "run_1:req_1", "once"), "closed");
    assert.deepEqual(h.userEmits.at(-1)?.payload, { key: "run_1:req_1", status: "expired" });
  }
});

test("any other Hermes failure closes the card as failed", async () => {
  const h = harness({ throws: new HermesError("unreachable", "down", 0) });
  h.registry.add(req());
  assert.equal(await h.registry.decide("user-dante", "run_1:req_1", "once"), "failed");
  assert.deepEqual(h.userEmits.at(-1)?.payload, { key: "run_1:req_1", status: "failed" });
});

test("a meeting card tells the meeting it is pending and clears it when decided", async () => {
  const h = harness();
  h.registry.add(req({ context: "meeting" }));
  assert.deepEqual(h.meetingEmits[0], {
    to: "ch-1",
    event: "tool-approval:pending",
    payload: { key: "run_1:req_1", npcId: "npc-sophie", approverName: "Dante" },
  });
  await h.registry.decide("user-dante", "run_1:req_1", "deny");
  assert.deepEqual(h.meetingEmits[1].payload, { key: "run_1:req_1", cleared: true });
});

test("pendingFor lists only that approver's cards", () => {
  const h = harness();
  h.registry.add(req({ requestId: "a" }));
  h.registry.add(req({ requestId: "b", approverUserId: "user-other" }));
  assert.deepEqual(
    h.registry.pendingFor("user-other").map((r) => r.key),
    ["run_1:b"],
  );
});

// ---------------------------------------------------------------------------
// withToolApprovals — the adapter wrapper
// ---------------------------------------------------------------------------

const EVENT: ParsedApprovalEvent = {
  runId: "run_9",
  requestId: "req_9",
  command: "rm -r /tmp/probe",
  description: "recursive delete",
  kind: "command",
  choices: ["once", "session", "deny"],
};

function fakeAdapter(script: (o: AdapterExecuteOptions) => Promise<void>): NpcAdapter {
  return {
    type: "hermes",
    execute: async (o) => {
      await script(o);
      return { response: "done", session: { sessionRef: "s1" } as never };
    },
    abort: async () => {},
    testConnection: async () => ({ ok: true }) as never,
  };
}

test("the wrapper turns an approval event into a card and expires it when the run ends", async () => {
  const added: PendingApproval[] = [];
  const expired: string[] = [];
  const seen: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const adapter = withToolApprovals(
    fakeAdapter(async (o) => {
      o.onRunStarted?.("run_9");
      o.onApprovalRequest?.(EVENT);
      await gate;
    }),
    {
      npcId: "npc-sophie",
      channelId: "ch-1",
      context: "dm",
      approver: () => ({ userId: "user-dante", name: "Dante" }),
    },
    {
      registry: { add: (r) => added.push(r), expireRun: (id) => expired.push(id) },
      timeoutFor: async () => 60,
      now: () => 5_000,
    },
  );
  const run = adapter.execute({
    sessionKey: "k",
    prompt: "p",
    onRunStarted: (id) => seen.push(id),
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(added.length, 1);
  assert.equal(added[0].key, "run_9:req_9");
  assert.equal(added[0].approverUserId, "user-dante");
  assert.equal(added[0].expiresAt, 5_000 + 60_000);
  assert.deepEqual(expired, []);
  release();
  await run;
  assert.deepEqual(expired, ["run_9"]);
  assert.deepEqual(seen, ["run_9"], "the caller's onRunStarted still fires");
  assert.equal(typeof adapter.abort, "function");
});

test("the wrapper adds nothing when there is no approver or the run already ended", async () => {
  const added: PendingApproval[] = [];
  const noApprover = withToolApprovals(
    fakeAdapter(async (o) => o.onApprovalRequest?.(EVENT)),
    { npcId: "n", channelId: "c", context: "meeting", approver: () => null },
    { registry: { add: (r) => added.push(r), expireRun: () => {} }, timeoutFor: async () => 60 },
  );
  await noApprover.execute({ sessionKey: "k", prompt: "p" });

  let resolveTimeout!: (n: number) => void;
  const late = withToolApprovals(
    fakeAdapter(async (o) => o.onApprovalRequest?.(EVENT)),
    {
      npcId: "n",
      channelId: "c",
      context: "dm",
      approver: () => ({ userId: "u", name: "U" }),
    },
    {
      registry: { add: (r) => added.push(r), expireRun: () => {} },
      timeoutFor: () => new Promise((r) => (resolveTimeout = r)),
    },
  );
  await late.execute({ sessionKey: "k", prompt: "p" });
  resolveTimeout(60);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(added, []);
});

test("the timeout lookup caches per NPC for ten minutes and falls back to 300 seconds", async () => {
  let clock = 0;
  const reads: string[] = [];
  const lookup = createApprovalTimeoutLookup(
    async (npcId) => {
      reads.push(npcId);
      return npcId === "old" ? null : 120;
    },
    () => clock,
  );
  assert.equal(await lookup("new"), 120);
  assert.equal(await lookup("new"), 120);
  assert.equal(await lookup("old"), 300);
  clock += 10 * 60 * 1000;
  assert.equal(await lookup("new"), 120);
  assert.deepEqual(reads, ["new", "old", "new"]);
});
