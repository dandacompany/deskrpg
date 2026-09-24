import { test } from "node:test";
import assert from "node:assert/strict";

import { ChannelRuntime } from "./channel-runtime";
import { NpcRuntime, type NpcRuntimeDeps } from "./npc-runtime";
import { Transcript } from "./transcript";
import type { EngineParticipant } from "./types";
import type { NpcAdapter, AdapterExecuteOptions } from "@/lib/adapters/types";

// The meeting turn prompts follow the language of whoever opened the meeting (NpcRuntimeDeps.locale).
// Omitted means Korean, exactly as before locales existed.

function capturing(response = "SPEAK") {
  const calls: AdapterExecuteOptions[] = [];
  const adapter = {
    type: "mock",
    async execute(o: AdapterExecuteOptions) {
      calls.push(o);
      return { response, session: { sessionRef: o.sessionKey } };
    },
    async testConnection() {
      return { status: "ok" as const };
    },
  } as NpcAdapter;
  return { adapter, calls };
}

function participant(adapter: NpcAdapter): EngineParticipant {
  return {
    npcId: "a",
    displayName: "A",
    seated: true,
    turnCount: 0,
    lastSpokeAt: 0,
    sessionKey: "sk-a",
    adapter,
    role: "Lead",
    passPolicy: null,
  } as EngineParticipant;
}

function runtime(p: EngineParticipant, locale?: string | null) {
  const deps: NpcRuntimeDeps = {
    transcript: new Transcript(),
    topic: "Lunch",
    allParticipants: [p],
    maxTotalTurns: 10,
    historyLimit: 5,
    turnTimeout: { idleMs: 1000, maxMs: 2000 },
    now: () => 0,
  };
  return new NpcRuntime(p, locale === undefined ? deps : { ...deps, locale });
}

for (const locale of ["ja", null]) {
  test(`a ${String(locale)} meeting polls and speaks with the English templates`, async () => {
    const cap = capturing();
    const r = runtime(participant(cap.adapter), locale);
    const raise = await r.poll(3);
    await r.takeTurn(3, { onChunk: () => {} });
    assert.ok(cap.calls[0].prompt.startsWith("📋 [Meeting poll: Lunch]"));
    assert.ok(cap.calls[1].prompt.startsWith("📋 [Meeting: Lunch]"));
    assert.equal(raise.reason, "(wants to speak)");
  });
}

test("a meeting without a locale keeps the Korean templates", async () => {
  const cap = capturing();
  const r = runtime(participant(cap.adapter));
  await r.poll(3);
  await r.takeTurn(3, { onChunk: () => {} });
  assert.ok(cap.calls[0].prompt.startsWith("📋 [회의 알림: Lunch]"));
  assert.ok(cap.calls[1].prompt.startsWith("📋 [회의: Lunch]"));
});

test("the engine hands its locale to every participant runtime", async () => {
  const cap = capturing("PASS");
  const engine = new ChannelRuntime(
    {
      mode: "meeting",
      topic: "Lunch",
      participants: [participant(cap.adapter)],
      quota: { maxTurnsPerAgent: 1, maxTotalTurns: 1, maxConsecutivePasses: 1, cooldownMs: 0 },
      locale: "en",
    },
    {},
  );
  await engine.run();
  assert.ok(cap.calls[0]?.prompt.startsWith("📋 [Meeting poll: Lunch]"));
});
