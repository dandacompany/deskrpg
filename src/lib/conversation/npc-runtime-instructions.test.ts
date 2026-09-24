import { test } from "node:test";
import assert from "node:assert/strict";

import { NpcRuntime } from "./npc-runtime";
import { Transcript } from "./transcript";
import type { EngineParticipant } from "./types";
import type { NpcAdapter, AdapterExecuteOptions } from "@/lib/adapters/types";

// Pins that the meeting and channel-mention paths carry system instructions.
//
// This path was missed once before (2026-08-30). Only the 1:1 path got wired up and this
// one was overlooked, even though meetings are exactly where <team-instructions> matters
// most. **Both** poll and speak must be checked — carrying it on only one means the same
// NPC gets different rules when raising a hand versus when speaking.

function capturing(): { adapter: NpcAdapter; calls: AdapterExecuteOptions[] } {
  const calls: AdapterExecuteOptions[] = [];
  return {
    calls,
    adapter: {
      type: "mock",
      async execute(o: AdapterExecuteOptions) {
        calls.push(o);
        return { response: "SPEAK: 네", session: { sessionRef: o.sessionKey } };
      },
      async testConnection() {
        return { status: "ok" as const };
      },
    } as NpcAdapter,
  };
}

function participant(
  npcId: string,
  adapter: NpcAdapter,
  over: Partial<EngineParticipant> = {},
): EngineParticipant {
  return {
    npcId,
    displayName: npcId,
    seated: true,
    turnCount: 0,
    lastSpokeAt: 0,
    sessionKey: `sk-${npcId}`,
    adapter,
    role: "팀장",
    passPolicy: null,
    ...over,
  } as EngineParticipant;
}

function runtimeFor(p: EngineParticipant, transcript = new Transcript()) {
  return new NpcRuntime(p, {
    transcript,
    topic: "점심 메뉴",
    allParticipants: [p],
    maxTotalTurns: 10,
    historyLimit: 5,
    turnTimeout: { idleMs: 1000, maxMs: 2000 },
    now: () => 0,
  });
}

const INSTR = "<team-instructions>\n한 번에 한 명씩\n</team-instructions>";

test("a speaking turn carries instructions", async () => {
  const cap = capturing();
  const p = participant("a", cap.adapter, { instructions: INSTR });
  await runtimeFor(p).takeTurn(4, { onChunk: () => {} });
  const speak = cap.calls.find((c) => !c.sessionKey.endsWith("-poll"));
  assert.equal(speak?.instructions, INSTR);
});

test("polling (raising a hand) carries the same instructions", async () => {
  const cap = capturing();
  const p = participant("a", cap.adapter, { instructions: INSTR });
  await runtimeFor(p).poll(3);
  const poll = cap.calls.find((c) => c.sessionKey.endsWith("-poll"));
  assert.equal(poll?.instructions, INSTR);
});

test("no instructions field is created when there are none", async () => {
  const cap = capturing();
  const p = participant("a", cap.adapter);
  await runtimeFor(p).takeTurn(4, { onChunk: () => {} });
  await runtimeFor(p).poll(3);
  for (const c of cap.calls) assert.equal(c.instructions, undefined);
});
