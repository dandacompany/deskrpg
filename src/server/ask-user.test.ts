import assert from "node:assert/strict";
import { test } from "node:test";

import type { AdapterExecuteOptions, NpcAdapter } from "@/lib/adapters/types";
import type { UserQuestion } from "@/lib/npc-questions";

import { ASK_USER_TOOL, withAskUser, type AskUserDeps } from "./ask-user";

const ROUTE = { npcId: "npc-1", userId: "u-1", channelId: "ch-1" };

const question = (id: string): UserQuestion => ({
  id,
  npcId: "npc-1",
  npcName: "Noah",
  question: "Which format?",
  choices: ["Summary", "Table"],
  allowOther: true,
  createdAt: "2026-09-26T00:00:00.000Z",
});

/** An adapter whose run starts, then calls the given tools, then finishes. */
function fakeAdapter(tools: string[], pauseMs = 30): NpcAdapter {
  return {
    execute: async (options: AdapterExecuteOptions) => {
      options.onRunStarted?.("run_2");
      for (const tool of tools) {
        options.onToolProgress?.(tool, "");
        await new Promise((r) => setTimeout(r, pauseMs));
      }
      return { response: "ok", session: { sessionRef: "k" } };
    },
  } as unknown as NpcAdapter;
}

function deps(over: Partial<AskUserDeps> = {}) {
  const emitted: Array<[string, unknown]> = [];
  const registered: unknown[] = [];
  let polls = 0;
  const d: AskUserDeps = {
    canAsk: async () => true,
    sessionIdOf: async (_npcId, runId) => (runId === "run_2" ? "run_1" : null),
    register: async (input) => {
      registered.push(input);
      return true;
    },
    questions: async () => {
      polls += 1;
      return polls >= 2 ? [question("q1")] : [];
    },
    emit: (event, payload) => emitted.push([event, payload]),
    pollIntervalMs: 5,
    ...over,
  };
  return { d, emitted, registered, polls: () => polls };
}

const opts = (over: Partial<AdapterExecuteOptions> = {}): AdapterExecuteOptions =>
  ({ sessionKey: "k", prompt: "hi", ...over }) as AdapterExecuteOptions;

test("the run's Hermes session is registered with the user, NPC and channel", async () => {
  const { d, registered } = deps();
  await withAskUser(fakeAdapter([]), ROUTE, d).execute(opts());
  assert.deepEqual(registered, [{ ...ROUTE, sessionId: "run_1" }]);
});

test("the ask tool sends the waiting question to that user once, and closes it when the run ends", async () => {
  const { d, emitted } = deps();
  const seenTools: string[] = [];
  await withAskUser(fakeAdapter([ASK_USER_TOOL, "web_search"]), ROUTE, d).execute(
    opts({ onToolProgress: (name) => seenTools.push(name) }),
  );
  assert.deepEqual(
    seenTools,
    [ASK_USER_TOOL, "web_search"],
    "tool progress still reaches the caller",
  );
  const questions = emitted.filter(([e]) => e === "npc:question");
  assert.equal(questions.length, 1);
  assert.deepEqual(questions[0][1], { npcId: "npc-1", question: question("q1") });
  assert.deepEqual(emitted.at(-1), [
    "npc:questions-closed",
    { npcId: "npc-1", questionIds: ["q1"] },
  ]);
});

test("other tools never look for questions", async () => {
  const { d, emitted, polls } = deps();
  await withAskUser(fakeAdapter(["web_search", "terminal"]), ROUTE, d).execute(opts());
  assert.equal(polls(), 0);
  assert.equal(emitted.length, 0);
});

test("a gateway without ask_user registers nothing and never polls", async () => {
  const { d, emitted, registered, polls } = deps({ canAsk: async () => false });
  await withAskUser(fakeAdapter([ASK_USER_TOOL]), ROUTE, d).execute(opts());
  assert.deepEqual(registered, []);
  assert.equal(polls(), 0);
  assert.equal(emitted.length, 0);
});

test("a failed registration or session lookup never breaks the chat", async () => {
  const { d } = deps({
    sessionIdOf: async () => {
      throw new Error("down");
    },
  });
  const result = await withAskUser(fakeAdapter([ASK_USER_TOOL]), ROUTE, d).execute(opts());
  assert.equal(result.response, "ok");
});

test("a capable gateway gets the ask_user guidance on every run's instructions", async () => {
  const { d } = deps();
  const seen: Array<string | undefined> = [];
  const adapter = {
    execute: async (options: AdapterExecuteOptions) => {
      seen.push(options.instructions);
      return { response: "ok", session: { sessionRef: "k" } };
    },
  } as unknown as NpcAdapter;
  await withAskUser(adapter, ROUTE, d).execute(opts({ instructions: "You are Noah." }));
  await withAskUser(adapter, ROUTE, d).execute(opts());
  assert.ok(seen[0]?.startsWith("You are Noah.\n\n"), seen[0]);
  for (const text of seen) {
    assert.ok(text?.includes(ASK_USER_TOOL), "names the tool");
    assert.ok(text?.includes("tool_search"), "says how to reach it when deferred");
  }
});

test("without ask_user the instructions pass through untouched", async () => {
  const { d } = deps({ canAsk: async () => false });
  const seen: Array<string | undefined> = [];
  const adapter = {
    execute: async (options: AdapterExecuteOptions) => {
      seen.push(options.instructions);
      return { response: "ok", session: { sessionRef: "k" } };
    },
  } as unknown as NpcAdapter;
  await withAskUser(adapter, ROUTE, d).execute(opts({ instructions: "You are Noah." }));
  await withAskUser(adapter, ROUTE, d).execute(opts());
  assert.deepEqual(seen, ["You are Noah.", undefined]);
});
