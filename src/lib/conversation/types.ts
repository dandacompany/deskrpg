// 대화 런타임 조각들이 공유하는 타입.
//
// 이 파일이 있는 이유는 의존 방향 하나 때문이다. `EngineParticipant` 는 원래
// `channel-runtime.ts` 에 있었고, `npc-runtime.ts` 가 거기서 가져왔다 —
// `channel-runtime` 이 `npc-runtime` 을 값으로 쓰므로 자식이 부모를 도로 가리키는 모양이다.
// `import type` 은 컴파일 시 지워져 런타임 순환은 아니지만, 나중에 값 import 를 하나만
// 추가하면 그 순간 진짜 순환이 되고 초기화 순서 문제로 나타난다 — 원인이 그 한 줄이라는
// 것이 드러나기까지 오래 걸리는 종류다.
//
// `turn-policy.ts` 옆에 두지 않은 이유: 그 파일은 스스로 "순수 함수 — I/O 없음, 어댑터도
// 소켓도 DB도 모른다"고 선언한다. 어댑터를 들고 있는 타입은 그 규약을 깬다.

import type { NpcAdapter } from "@/lib/adapters/types";
import type { Participant } from "./turn-policy";

export type EngineParticipant = Participant & {
  adapter: NpcAdapter;
  sessionKey: string;
  /** 발언 프롬프트의 참석자 목록에 `이름(역할)`로 실린다. 생략하면 "Participant". */
  role?: string | null;
  /** 폴링 프롬프트의 `[발언 지침]` 블록에 실린다(meeting-formatter.js:30-32). 옛 브로커는
   * agent.passPolicy를 그대로 넘겼다(meeting-broker.js:307) — 값이 없으면 블록 자체가 빠진다. */
  passPolicy?: string | null;
};
