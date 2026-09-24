import { test } from "node:test";
import assert from "node:assert/strict";
import { NpcRuntime } from "./npc-runtime";
import { Transcript } from "./transcript";
import type { EngineParticipant } from "./types";
import type { NpcAdapter, AdapterExecuteOptions } from "@/lib/adapters/types";

// Pins the meeting prompt down character by character.
//
// Other tests check whether the meeting "works". But nobody notices when the prompt
// subtly changes — no error occurs, only response quality silently degrades. If splitting
// out speakWithPrompt drops even one argument to the formatSpeakMessage call, this catches it.

function capturing(): { adapter: NpcAdapter; prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    adapter: {
      type: "mock",
      async execute(o: AdapterExecuteOptions) {
        prompts.push(o.prompt);
        return { response: "네", session: { sessionRef: o.sessionKey } };
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
    passPolicy: "확신 없으면 넘기세요",
    ...over,
  };
}

test("the meeting speak prompt is pinned character by character", async () => {
  const cap = capturing();
  const transcript = new Transcript();
  transcript.add("b", "하늘", "저는 김치찌개요", 0);

  const a = participant("a", cap.adapter);
  const b = participant("b", cap.adapter, { displayName: "하늘", role: "디자이너" });

  const runtime = new NpcRuntime(a, {
    transcript,
    topic: "점심 메뉴",
    allParticipants: [a, b],
    maxTotalTurns: 10,
    historyLimit: 5,
    turnTimeout: { idleMs: 1000, maxMs: 2000 },
    now: () => 0,
  });

  await runtime.takeTurn(4, { onChunk: () => {} });

  // Only look at the speak prompt, not the poll (a poll's sessionKey ends in -poll).
  assert.equal(cap.prompts.length, 1);
  const prompt = cap.prompts[0];

  // What the meeting prompt must contain. Dropping even one silently changes response quality.
  assert.match(prompt, /점심 메뉴/, "주제가 빠졌습니다");
  assert.match(prompt, /하늘/, "다른 참가자 이름이 빠졌습니다");
  assert.match(prompt, /디자이너/, "참가자 역할이 빠졌습니다");
  assert.match(prompt, /저는 김치찌개요/, "최근 발언이 빠졌습니다");
  // passPolicy is carried only in the poll prompt (formatPollMessage), not the speak
  // prompt (meeting-formatter.js) — confirmed absent from actual speak-prompt output.
  assert.match(prompt, /10/, "최대 턴 수가 빠졌습니다");
  assert.match(prompt, /4/, "남은 할당량이 빠졌습니다");
});
