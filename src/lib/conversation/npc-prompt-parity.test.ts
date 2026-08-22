import { test } from "node:test";
import assert from "node:assert/strict";
import { NpcRuntime } from "./npc-runtime";
import { Transcript } from "./transcript";
import type { EngineParticipant } from "./types";
import type { NpcAdapter, AdapterExecuteOptions } from "@/lib/adapters/types";

// 회의 프롬프트를 문자 단위로 붙든다.
//
// 회의가 "돌아가는지"는 다른 테스트들이 본다. 그러나 프롬프트가 미묘하게 달라진 것은
// 아무도 못 본다 — 에러가 나지 않고 답변 품질만 조용히 떨어진다. speakWithPrompt 를
// 갈라내면서 formatSpeakMessage 호출 인자를 하나라도 흘리면 여기서 잡힌다.

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

test("회의 발언 프롬프트가 문자 단위로 고정된다", async () => {
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

  // 폴이 아니라 발언 프롬프트만 본다(폴은 sessionKey 가 -poll 로 끝난다).
  assert.equal(cap.prompts.length, 1);
  const prompt = cap.prompts[0];

  // 회의 프롬프트가 반드시 담아야 하는 것들. 하나라도 빠지면 답변 품질이 조용히 바뀐다.
  assert.match(prompt, /점심 메뉴/, "주제가 빠졌습니다");
  assert.match(prompt, /하늘/, "다른 참가자 이름이 빠졌습니다");
  assert.match(prompt, /디자이너/, "참가자 역할이 빠졌습니다");
  assert.match(prompt, /저는 김치찌개요/, "최근 발언이 빠졌습니다");
  // passPolicy 는 발언 프롬프트가 아니라 폴 프롬프트(formatPollMessage)에만 실린다
  // (meeting-formatter.js) — 실제 출력 확인 결과 speak 프롬프트에는 없다.
  assert.match(prompt, /10/, "최대 턴 수가 빠졌습니다");
  assert.match(prompt, /4/, "남은 할당량이 빠졌습니다");
});
