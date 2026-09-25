import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatResponseTracker, SessionQueue } from "./chat-response-tracker";
import { runTrackedDm } from "./dm-response-runtime";
import type { ChatResponse } from "@/lib/chat-response";
import type { ParsedApprovalEvent } from "@/lib/tool-approval-event";

const identity = (requestId: string) => ({
  requestId,
  sourceMessageId: `m-${requestId}`,
  npcId: "n",
  npcName: "Sophie",
});

test("DM emits receipt before work and uses returned answer even when no deltas arrive", async () => {
  const states: ChatResponse[] = [];
  const tracker = new ChatResponseTracker((r) => states.push(r));
  await runTrackedDm({
    tracker,
    queue: new SessionQueue(),
    queueKey: "scope",
    identity: identity("r"),
    work: async () => {
      assert.equal(states.at(-1)?.status, "thinking");
      return "final answer";
    },
  });
  assert.deepEqual(
    states.map((r) => r.status),
    ["queued", "thinking", "complete"],
  );
  assert.equal(states.at(-1)?.content, "final answer");
});

test("DM captures answer deltas, not tool text, and closes failures without overwriting another request", async () => {
  const states: ChatResponse[] = [];
  const tracker = new ChatResponseTracker((r) => states.push(r));
  await runTrackedDm({
    tracker,
    queue: new SessionQueue(),
    queueKey: "scope",
    identity: identity("r"),
    work: async (capture) => {
      capture("npc:activity", { npcId: "n", activityKey: "search", chunk: "private tool text" });
      capture("npc:response", { npcId: "n", chunk: "hello", done: false });
      assert.equal(states.at(-1)?.content, "hello");
      throw new Error("backend down");
    },
  });
  assert.equal(states.at(-1)?.status, "failed");
  assert.equal(states.at(-1)?.content, "hello");
  assert.ok(states.every((s) => !s.content.includes("private")));
});

test("DM adapter timeout closes the turn and suppresses late callbacks", async () => {
  const { executeDmAdapter } = await import("./dm-response-runtime");
  let delayed!: () => void;
  let aborts = 0;
  const chunks: string[] = [];
  const adapter = {
    type: "fake",
    execute: async (opts: { onDelta?: (delta: string) => void }) =>
      new Promise<never>(() => {
        delayed = () => opts.onDelta?.("late");
      }),
    abort: async () => {
      aborts++;
    },
    testConnection: async () => ({ status: "ok" as const }),
  };
  await assert.rejects(
    executeDmAdapter(
      adapter,
      { sessionKey: "s", prompt: "hi", onDelta: (s) => chunks.push(s) },
      { idleMs: 10, maxMs: 50 },
    ),
    /timeout/,
  );
  delayed();
  assert.equal(aborts, 1);
  assert.deepEqual(chunks, []);
});

const approvalEvent: ParsedApprovalEvent = {
  runId: "run_1",
  requestId: "req_1",
  command: "mcp_probe_write_note",
  description: "write-capable MCP tool",
  kind: "mcp",
  choices: ["once", "session", "deny"],
};

test("a DM waiting on a tool approval does not expire on idle", async () => {
  const { executeDmAdapter } = await import("./dm-response-runtime");
  const forwarded: string[] = [];
  const adapter = {
    type: "fake",
    execute: async (opts: {
      onApprovalRequest?: (event: ParsedApprovalEvent) => void;
      onToolProgress?: (name: string, delta: string) => void;
    }) => {
      opts.onApprovalRequest?.(approvalEvent);
      // Silent for 3x idleMs, as a run is while a person decides.
      await new Promise((r) => setTimeout(r, 60));
      opts.onToolProgress?.("mcp_probe_write_note", "");
      return { response: "done", session: { sessionRef: "s" } };
    },
    testConnection: async () => ({ status: "ok" as const }),
  };
  const result = await executeDmAdapter(
    adapter,
    {
      sessionKey: "s",
      prompt: "hi",
      onApprovalRequest: (event) => forwarded.push(event.runId),
    },
    { idleMs: 20, maxMs: 1000 },
  );
  assert.equal(result.response, "done");
  assert.deepEqual(forwarded, ["run_1"]);
});

test("cancelling an active DM aborts its adapter and releases the next request", async () => {
  const { executeDmAdapter } = await import("./dm-response-runtime");
  const tracker = new ChatResponseTracker(() => {});
  const queue = new SessionQueue();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let aborts = 0;
  const work = runTrackedDm({
    tracker,
    queue,
    queueKey: "s",
    identity: identity("cancel"),
    work: async (_capture, _active, signal) => {
      await executeDmAdapter(
        {
          type: "fake",
          execute: async () => {
            started();
            return new Promise<never>(() => {});
          },
          abort: async () => {
            aborts++;
          },
          testConnection: async () => ({ status: "ok" as const }),
        },
        { sessionKey: "s", prompt: "hi" },
        { idleMs: 1000, maxMs: 1000 },
        signal,
      );
      return "late";
    },
  });
  await ready;
  tracker.cancelAll();
  const settled = await Promise.race([
    work.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 50)),
  ]);
  assert.equal(settled, true, "cancellation must settle before backend idle timeout");
  await work;
  assert.equal(aborts, 1);
  assert.equal(queue.size("s"), 0);
  assert.equal(tracker.snapshot()[0].status, "cancelled");
});

test("slow source persistence cannot reorder admitted DMs, and failed source writes never execute", async () => {
  const tracker = new ChatResponseTracker(() => {});
  const queue = new SessionQueue();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const order: string[] = [];
  const first = runTrackedDm({
    tracker,
    queue,
    queueKey: "s",
    identity: identity("first"),
    prepare: () => gate,
    work: async () => {
      order.push("first");
      return "one";
    },
  });
  const second = runTrackedDm({
    tracker,
    queue,
    queueKey: "s",
    identity: identity("second"),
    prepare: async () => {},
    work: async () => {
      order.push("second");
      return "two";
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(order.length, 0);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first", "second"]);
  await runTrackedDm({
    tracker,
    queue,
    queueKey: "s",
    identity: identity("failed"),
    prepare: async () => {
      throw new Error("write failed");
    },
    work: async () => {
      order.push("bad");
      return "bad";
    },
  });
  assert.deepEqual(order, ["first", "second"]);
  assert.equal(tracker.snapshot().at(-1)?.error, "persistence_error");
});
