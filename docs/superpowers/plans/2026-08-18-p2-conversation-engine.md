# P2 — 대화 엔진 일반화 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `MeetingBroker`가 게이트웨이를 직접 잡고 있는 결합을 끊어 `ConversationEngine`(peer / meeting / group 3모드)으로 일반화하고, 그 결과로 Hermes·CLI 어댑터 NPC가 회의에 참가할 수 있게 한다.

**Architecture:** 턴 루프는 하나만 존재하고 모드는 정책 객체로 갈아끼운다. 엔진은 `NpcAdapter`만 알고 `HermesClient`·`OpenClawGateway`를 모른다. 어댑터는 P1b의 판정대로 **디스패치마다 생성**되고 세션 연속성은 DB(`npc_sessions`)가 소유하므로, 엔진은 참가자별 어댑터를 인자로 받을 뿐 캐시하지 않는다.

**Tech Stack:** TypeScript(신규 엔진), 기존 `meeting-broker.js`는 CommonJS, Socket.io, `node:test` + `tsx --test`. 런타임 의존성 추가 없음.

**Spec:** `docs/superpowers/specs/2026-08-17-deskrpg-hermes-migration-design.md` — 특히 §3.5(ConversationEngine), §5(P2 정의), D9(meeting 모드 동작 보존), D10(peer 폴링 생략)

## Global Constraints

- **테스트 실행은 반드시** `npx tsx --test $(git ls-files 'src/**/*.test.ts' 'src/**/*.test.js' | tr '\n' ' ')`. `npm test`는 셸 글롭이 미추적 잔재 4파일(`src/lib/gateway-resources.test.ts`, `src/lib/gateway-runtime-cache.test.ts`, `src/lib/openclaw-gateway.test.js`, `src/components/openclaw/OpenClawPairingStatusCard.test.tsx`)을 쓸어담아 존재하지 않는 실패 17건을 보고한다. **현재 기준선: 445/445 통과.**
- **`.gitignore:69`가 `*.test.ts`를 무시한다.** 새 테스트 파일은 반드시 `git add -f`, `git ls-files`로 추적 확인. 이 함정은 P1에서 3회, P1b에서 1회 걸렸다.
- `npx tsc --noEmit`의 **프로덕션(비테스트) 코드 에러는 0건**이며 유지해야 한다.
- 런타임 의존성 추가 금지.
- **D9 — `meeting` 모드의 동작은 불변이어야 한다.** `auto`/`manual`/`directed` 하위 모드, hybrid 자동 재개, 할당량(`maxTurnsPerAgent` 20 / `maxTotalTurns` 50), 손들기 폴링, 연속 PASS 2회 종료, 사용자 개입 — 전부 그대로. 이관에서 동작이 달라지면 실패다.
- **D10 — `peer` 모드는 손들기 폴링을 생략한다.** 2인 대화에서 매 턴 "말할래?"를 묻는 것은 API 호출을 정확히 2배로 만드는 낭비다.
- **OpenClaw 경로는 계속 동작해야 한다.** P4까지 롤백 지점으로 유지된다.
- **어댑터는 공유 싱글턴이 아니다.** P1b 판정: `HermesAdapter`는 `sessionId`/`lastRunId`를 인스턴스 필드에 두므로 디스패치마다 생성되며, 세션 연속성은 `npc_sessions.session_ref`가 소유한다. 엔진이 어댑터를 캐시하면 이 판정이 무너진다.

---

## 이 계획이 P2 범위로 삼지 않는 것

P1·P1b에서 모인 후속 과제 중 아래는 **별도 계획**이다. 여기서 건드리면 D9의 "동작 불변" 검증이 오염된다.

- 태스크 자동화의 Hermes 배선 + `npcReports` 전달 경로
- 크로스 게이트웨이 프로필 목록 라우트(`GET /api/hermes/profiles`)
- 게이트웨이 캐시 일원화(P1b F1의 재바인딩 한계)
- `getNpcConfig` 캐시, 채널 비었을 때 연결 정리
- 동적 회의실(`conversation_rooms`)과 공간 기반 참여 — **스펙상 P3**

---

## File Structure

**신규**

| 파일 | 책임 |
|---|---|
| `src/lib/conversation/turn-policy.ts` | 3모드 정책. 순수 함수 — 참가자 목록과 상태를 받아 "다음 발언자는 누구인가 / 폴링이 필요한가 / 끝났는가"를 답한다. I/O 없음 |
| `src/lib/conversation/transcript.ts` | 턴 기록과 `conversation_history` 직렬화. 순수 |
| `src/lib/conversation/conversation-engine.ts` | 턴 루프. 어댑터만 알고 게이트웨이를 모른다 |
| `src/lib/conversation/conversation-engine.test.ts` | 3모드 정책 + 착석 게이트 + 폴링 청크 |
| `src/lib/meeting-broker-baseline.test.ts` | **회귀 기준선** — 이관 전 현재 동작을 고정 |

**수정**

| 파일 | 변경 |
|---|---|
| `src/server/meeting-discussion.ts:249` | `adapterResolver: (_npcId) => openclawAdapter` 하드코딩을 실제 어댑터 해석으로 교체 |
| `src/lib/meeting-broker.js` | 최종적으로 `ConversationEngine` 위임 껍데기가 되거나 삭제 |

---

## Task 1: 회귀 기준선 구축 — 이관 전에 현재 동작을 고정한다

**이 태스크가 P2에서 가장 중요하다.** D9는 "`meeting` 모드 동작 불변"을 성공 기준으로 삼는데, 현재 `src/lib/meeting-broker.test.ts`에는 **테스트가 1개뿐**이다(SPEAK 접두어 제거만 확인). 500줄 상태머신의 나머지 동작을 고정하는 것이 없다. 이 상태로 재작성하면 무엇이 깨졌는지 알 방법이 없다.

**Files:**
- Create: `src/lib/meeting-broker-baseline.test.ts`

**Interfaces:**
- Consumes: `MeetingBroker` from `src/lib/meeting-broker.js` (현행 그대로)
- Produces: 없음 (가드 전용). 이 테스트는 Task 4에서 `ConversationEngine`에 대해 **그대로 다시 통과해야 한다**

**현재 브로커의 공개 표면**(고정 대상):

| 종류 | 이름 |
|---|---|
| 메서드 | `run`, `addUserMessage`, `stop`, `isRunning`, `setMode`, `nextTurn`, `directSpeak`, `abortCurrentTurn`, `pollAgents`, `selectSpeaker`, `grantFloor`, `addTurn`, `isFinished`, `getRemainingTurns` |
| 콜백 | `onPollStart`, `onPollResult`, `onTurnStart`, `onTurnChunk`, `onTurnEnd`, `onMeetingEnd`, `onError`, `onModeChanged`, `onWaitingInput` |

- [ ] **Step 1: 목 게이트웨이 헬퍼를 만든다**

```typescript
// src/lib/meeting-broker-baseline.test.ts
//
// 회귀 기준선 — MeetingBroker의 현재 동작을 이관 전에 고정한다.
// P2에서 ConversationEngine으로 재작성한 뒤, 이 파일의 단언들이 새 구현에 대해
// 그대로 통과해야 한다(스펙 D9: meeting 모드 동작 불변).
// 이관이 끝나면 import 대상만 ConversationEngine으로 바꾸고 나머지는 유지한다.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { MeetingBroker } = require("./meeting-broker.js") as typeof import("./meeting-broker.js");

type Reply = { text: string };

/**
 * 대본대로 답하는 목 게이트웨이.
 * scripted[agentId]가 큐이며, 호출마다 앞에서 하나씩 꺼낸다.
 * 비면 마지막 값을 반복한다(폴링이 몇 번 도는지에 테스트가 결합되지 않게).
 */
function mockGateway(scripted: Record<string, Reply[]>) {
  const calls: Array<{ agentId: string; sessionKey: string; message: string }> = [];
  const queues = new Map(Object.entries(scripted).map(([k, v]) => [k, [...v]]));
  return {
    calls,
    async chatSend(
      agentId: string,
      sessionKey: string,
      message: string,
      onChunk: (c: string) => void,
    ) {
      calls.push({ agentId, sessionKey, message });
      const q = queues.get(agentId) ?? [{ text: "PASS" }];
      const reply = q.length > 1 ? q.shift()! : q[0];
      onChunk(reply.text);
      return reply.text;
    },
    async chatAbort() {},
  };
}

const participants = [
  { agentId: "a", displayName: "에이", role: "Participant" },
  { agentId: "b", displayName: "비", role: "Participant" },
];
```

- [ ] **Step 2: 손들기 폴링과 발언권 배분을 고정하는 테스트를 쓴다**

```typescript
describe("MeetingBroker 기준선 — 폴링과 발언권", () => {
  test("PASS만 나오면 연속 PASS 상한에서 회의가 끝난다", async () => {
    const gw = mockGateway({ a: [{ text: "PASS" }], b: [{ text: "PASS" }] });
    let ended = false;
    const broker = new MeetingBroker(
      { topic: "T", participants, gateway: gw, sessionKeyPrefix: "s", meetingId: "m",
        quota: { maxConsecutivePasses: 2, cooldownMs: 0 } },
      { onMeetingEnd: () => { ended = true; } },
    );
    await broker.run();
    assert.equal(ended, true, "onMeetingEnd가 호출되어야 한다");
    assert.equal(broker.isRunning(), false);
  });

  test("SPEAK한 참가자만 발언권 후보가 된다", async () => {
    const gw = mockGateway({
      a: [{ text: "SPEAK: 하고 싶습니다" }],
      b: [{ text: "PASS" }],
    });
    const broker = new MeetingBroker(
      { topic: "T", participants, gateway: gw, sessionKeyPrefix: "s", meetingId: "m",
        quota: { cooldownMs: 0 } },
      {},
    );
    const { raises, passes } = await broker.pollAgents();
    assert.deepEqual(raises.map((r: { agent: { agentId: string } }) => r.agent.agentId), ["a"]);
    assert.deepEqual(passes, ["b"]);
  });

  test("여러 명이 손들면 가장 오래 발언하지 않은 쪽이 뽑힌다", () => {
    const gw = mockGateway({});
    const broker = new MeetingBroker(
      { topic: "T", participants, gateway: gw, sessionKeyPrefix: "s", meetingId: "m" },
      {},
    );
    broker.addTurn("a", "에이", "먼저 말함");
    const selected = broker.selectSpeaker([
      { agent: participants[0], reason: "" },
      { agent: participants[1], reason: "" },
    ]);
    assert.equal(selected.agent.agentId, "b", "이미 말한 a보다 아직 안 말한 b가 우선");
  });
});
```

- [ ] **Step 3: 할당량과 종료 조건을 고정하는 테스트를 쓴다**

```typescript
describe("MeetingBroker 기준선 — 할당량", () => {
  test("getRemainingTurns가 참가자별 발언 수를 차감한다", () => {
    const broker = new MeetingBroker(
      { topic: "T", participants, gateway: mockGateway({}), sessionKeyPrefix: "s", meetingId: "m",
        quota: { maxTurnsPerAgent: 3 } },
      {},
    );
    assert.equal(broker.getRemainingTurns("a"), 3);
    broker.addTurn("a", "에이", "1");
    broker.addTurn("a", "에이", "2");
    assert.equal(broker.getRemainingTurns("a"), 1);
    assert.equal(broker.getRemainingTurns("b"), 3, "다른 참가자는 영향받지 않는다");
  });

  test("총 턴 상한에 도달하면 isFinished가 참이 된다", () => {
    const broker = new MeetingBroker(
      { topic: "T", participants, gateway: mockGateway({}), sessionKeyPrefix: "s", meetingId: "m",
        quota: { maxTotalTurns: 2 } },
      {},
    );
    assert.equal(broker.isFinished(), false);
    broker.addTurn("a", "에이", "1");
    broker.addTurn("b", "비", "2");
    assert.equal(broker.isFinished(), true);
  });

  test("할당량을 소진한 참가자는 폴링 대상에서 빠진다", async () => {
    const gw = mockGateway({ a: [{ text: "PASS" }], b: [{ text: "PASS" }] });
    const broker = new MeetingBroker(
      { topic: "T", participants, gateway: gw, sessionKeyPrefix: "s", meetingId: "m",
        quota: { maxTurnsPerAgent: 1 } },
      {},
    );
    broker.addTurn("a", "에이", "소진");
    await broker.pollAgents();
    const polled = new Set(gw.calls.map((c) => c.agentId));
    assert.equal(polled.has("a"), false, "할당량 소진자는 폴링되지 않아야 한다");
    assert.equal(polled.has("b"), true);
  });
});
```

- [ ] **Step 4: 모드 전환과 사용자 개입을 고정하는 테스트를 쓴다**

```typescript
describe("MeetingBroker 기준선 — 모드와 개입", () => {
  test("setMode가 유효한 모드만 받아들인다", () => {
    const broker = new MeetingBroker(
      { topic: "T", participants, gateway: mockGateway({}), sessionKeyPrefix: "s", meetingId: "m" },
      {},
    );
    broker.setMode("manual");
    broker.setMode("존재하지-않는-모드");
    // 잘못된 모드는 커맨드 큐에 들어가지 않는다 — drain 후 mode가 manual로 유지되는지 확인
    const { directNpcId } = (broker as unknown as { _drainCommands(): { directNpcId: string | null } })._drainCommands();
    assert.equal(directNpcId, null);
    assert.equal((broker as unknown as { mode: string }).mode, "manual");
  });

  test("addUserMessage가 연속 PASS 카운터를 초기화한다", () => {
    const broker = new MeetingBroker(
      { topic: "T", participants, gateway: mockGateway({}), sessionKeyPrefix: "s", meetingId: "m" },
      {},
    );
    (broker as unknown as { consecutivePasses: number }).consecutivePasses = 1;
    broker.addUserMessage("단테", "계속하세요");
    assert.equal((broker as unknown as { consecutivePasses: number }).consecutivePasses, 0);
  });

  test("stop이 실행 상태를 내린다", () => {
    const broker = new MeetingBroker(
      { topic: "T", participants, gateway: mockGateway({}), sessionKeyPrefix: "s", meetingId: "m" },
      {},
    );
    (broker as unknown as { running: boolean }).running = true;
    broker.stop();
    assert.equal(broker.isRunning(), false);
  });
});
```

- [ ] **Step 5: 테스트를 실행해 전부 통과하는지 확인한다**

Run: `npx tsx --test src/lib/meeting-broker-baseline.test.ts`
Expected: 10개 전부 PASS. **여기서 실패하는 것이 있으면 그것은 현재 구현의 실제 동작이 내 예상과 다르다는 뜻이다** — 테스트를 현재 동작에 맞게 고치고, 무엇이 달랐는지 보고서에 적는다. 기준선은 "이래야 한다"가 아니라 "지금 이렇다"를 적는 것이다.

- [ ] **Step 6: 전체 스위트가 깨지지 않았는지 확인하고 커밋한다**

Run: `npx tsx --test $(git ls-files 'src/**/*.test.ts' 'src/**/*.test.js' | tr '\n' ' ')`
Expected: 455/455 (445 + 신규 10)

```bash
git add -f src/lib/meeting-broker-baseline.test.ts
git commit -m "test(meeting): pin current broker behavior as a pre-refactor baseline"
git ls-files src/lib/meeting-broker-baseline.test.ts   # 추적 확인
```

---

## Task 2: 턴 정책 — 3모드를 순수 함수로 분리

**Files:**
- Create: `src/lib/conversation/turn-policy.ts`
- Test: `src/lib/conversation/turn-policy.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `type ConversationMode = "peer" | "meeting" | "group"`
  - `type Participant = { npcId: string; displayName: string; seated: boolean; turnCount: number; lastSpokeAt: number }`
  - `function needsPolling(mode: ConversationMode): boolean`
  - `function eligibleParticipants(all: Participant[], remainingTurns: (npcId: string) => number): Participant[]`
  - `function selectNextSpeaker(mode: ConversationMode, candidates: Participant[], lastSpeakerId: string | null): Participant | null`

**설계 의도:** 정책은 I/O를 하지 않는다. 어댑터도 소켓도 DB도 모르고, 참가자 배열과 숫자만 받는다. 그래서 3모드의 차이를 테스트로 직접 고정할 수 있다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```typescript
// src/lib/conversation/turn-policy.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { needsPolling, eligibleParticipants, selectNextSpeaker } from "./turn-policy";
import type { Participant } from "./turn-policy";

function p(npcId: string, over: Partial<Participant> = {}): Participant {
  return { npcId, displayName: npcId, seated: true, turnCount: 0, lastSpokeAt: 0, ...over };
}

describe("needsPolling", () => {
  test("peer는 폴링하지 않는다 — 2인 대화에서 손들기는 호출을 2배로 만드는 낭비", () => {
    assert.equal(needsPolling("peer"), false);
  });
  test("meeting과 group은 폴링한다", () => {
    assert.equal(needsPolling("meeting"), true);
    assert.equal(needsPolling("group"), true);
  });
});

describe("eligibleParticipants", () => {
  test("착석하지 않은 참가자는 제외된다", () => {
    const all = [p("a"), p("b", { seated: false })];
    const got = eligibleParticipants(all, () => 5);
    assert.deepEqual(got.map((x) => x.npcId), ["a"]);
  });
  test("할당량을 소진한 참가자는 제외된다", () => {
    const all = [p("a"), p("b")];
    const got = eligibleParticipants(all, (id) => (id === "a" ? 0 : 3));
    assert.deepEqual(got.map((x) => x.npcId), ["b"]);
  });
  test("둘 다 만족하면 남는다", () => {
    const all = [p("a"), p("b")];
    assert.equal(eligibleParticipants(all, () => 1).length, 2);
  });
});

describe("selectNextSpeaker", () => {
  test("peer는 직전 발언자가 아닌 쪽으로 교대한다", () => {
    const cands = [p("a"), p("b")];
    assert.equal(selectNextSpeaker("peer", cands, "a")?.npcId, "b");
    assert.equal(selectNextSpeaker("peer", cands, "b")?.npcId, "a");
  });
  test("peer에서 직전 발언자가 없으면 첫 참가자가 시작한다", () => {
    assert.equal(selectNextSpeaker("peer", [p("a"), p("b")], null)?.npcId, "a");
  });
  test("meeting은 가장 오래 발언하지 않은 쪽을 고른다", () => {
    const cands = [p("a", { lastSpokeAt: 100 }), p("b", { lastSpokeAt: 50 })];
    assert.equal(selectNextSpeaker("meeting", cands, null)?.npcId, "b");
  });
  test("group도 같은 공정성 규칙을 쓴다", () => {
    const cands = [p("a", { lastSpokeAt: 10 }), p("b", { lastSpokeAt: 99 })];
    assert.equal(selectNextSpeaker("group", cands, null)?.npcId, "a");
  });
  test("후보가 없으면 null", () => {
    assert.equal(selectNextSpeaker("meeting", [], null), null);
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `npx tsx --test src/lib/conversation/turn-policy.test.ts`
Expected: FAIL — `Cannot find module './turn-policy'`

- [ ] **Step 3: 최소 구현을 쓴다**

```typescript
// src/lib/conversation/turn-policy.ts
// 대화 모드별 턴 정책. 순수 함수 — I/O 없음, 어댑터도 소켓도 DB도 모른다.

export type ConversationMode = "peer" | "meeting" | "group";

export type Participant = {
  npcId: string;
  displayName: string;
  /** 대화 영역 안에 있어 발언 자격이 있는가 (스펙 §3.5 착석 게이트) */
  seated: boolean;
  turnCount: number;
  lastSpokeAt: number;
};

/** peer는 2인 교대라 손들기가 불필요하다 (스펙 D10). */
export function needsPolling(mode: ConversationMode): boolean {
  return mode !== "peer";
}

export function eligibleParticipants(
  all: Participant[],
  remainingTurns: (npcId: string) => number,
): Participant[] {
  return all.filter((x) => x.seated && remainingTurns(x.npcId) > 0);
}

export function selectNextSpeaker(
  mode: ConversationMode,
  candidates: Participant[],
  lastSpeakerId: string | null,
): Participant | null {
  if (candidates.length === 0) return null;

  if (mode === "peer") {
    const other = candidates.find((c) => c.npcId !== lastSpeakerId);
    return other ?? candidates[0];
  }

  // meeting / group — 가장 오래 발언하지 않은 참가자 (공정성)
  return candidates.reduce((oldest, c) => (c.lastSpokeAt < oldest.lastSpokeAt ? c : oldest));
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `npx tsx --test src/lib/conversation/turn-policy.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/conversation/turn-policy.ts
git add -f src/lib/conversation/turn-policy.test.ts
git commit -m "feat(conversation): add pure turn policy for peer/meeting/group modes"
git ls-files src/lib/conversation/   # 두 파일 모두 추적 확인
```

---

## Task 3: 트랜스크립트 — 턴 기록과 conversation_history 직렬화

**Files:**
- Create: `src/lib/conversation/transcript.ts`
- Test: `src/lib/conversation/transcript.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `type Turn = { seq: number; speakerId: string; displayName: string; content: string; timestamp: number }`
  - `class Transcript` — `add(speakerId, displayName, content, now): Turn`, `all(): Turn[]`, `recent(n): Turn[]`, `turnCountFor(speakerId): number`, `lastSpokeAt(speakerId): number`, `toConversationHistory(limit): Array<{ role: string; content: string }>`

**왜 분리하나:** P1의 `HermesClient`가 `conversation_history`를 구조화 배열로 받는다(`api_server.py:6668`). 지금 브로커는 트랜스크립트를 문자열로 프롬프트에 우겨넣는데, 직렬화를 여기로 떼어내면 그 개선을 한 곳에서 하고 테스트할 수 있다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```typescript
// src/lib/conversation/transcript.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Transcript } from "./transcript";

describe("Transcript", () => {
  test("턴을 순번과 함께 기록한다", () => {
    const t = new Transcript();
    const first = t.add("a", "에이", "안녕", 1000);
    const second = t.add("b", "비", "반가워", 2000);
    assert.equal(first.seq, 1);
    assert.equal(second.seq, 2);
    assert.equal(t.all().length, 2);
  });

  test("참가자별 발언 수를 센다", () => {
    const t = new Transcript();
    t.add("a", "에이", "1", 1);
    t.add("a", "에이", "2", 2);
    t.add("b", "비", "3", 3);
    assert.equal(t.turnCountFor("a"), 2);
    assert.equal(t.turnCountFor("b"), 1);
    assert.equal(t.turnCountFor("없음"), 0);
  });

  test("마지막 발언 시각을 기억한다", () => {
    const t = new Transcript();
    t.add("a", "에이", "x", 500);
    assert.equal(t.lastSpokeAt("a"), 500);
    assert.equal(t.lastSpokeAt("b"), 0, "발언한 적 없으면 0");
  });

  test("recent는 뒤에서 n개만 준다", () => {
    const t = new Transcript();
    for (let i = 1; i <= 5; i++) t.add("a", "에이", String(i), i);
    assert.deepEqual(t.recent(2).map((x) => x.content), ["4", "5"]);
  });

  test("conversation_history는 role/content 배열로 나온다", () => {
    const t = new Transcript();
    t.add("user", "단테", "주제는 배포입니다", 1);
    t.add("a", "에이", "제 의견은", 2);
    const hist = t.toConversationHistory(10);
    assert.deepEqual(hist, [
      { role: "user", content: "단테: 주제는 배포입니다" },
      { role: "assistant", content: "에이: 제 의견은" },
    ]);
  });

  test("conversation_history가 limit을 지킨다", () => {
    const t = new Transcript();
    for (let i = 1; i <= 5; i++) t.add("a", "에이", String(i), i);
    assert.equal(t.toConversationHistory(2).length, 2);
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `npx tsx --test src/lib/conversation/transcript.test.ts`
Expected: FAIL — `Cannot find module './transcript'`

- [ ] **Step 3: 최소 구현을 쓴다**

```typescript
// src/lib/conversation/transcript.ts
// 대화 턴 기록. 순수 — 시각은 호출자가 주입한다(테스트 결정성).

export type Turn = {
  seq: number;
  speakerId: string;
  displayName: string;
  content: string;
  timestamp: number;
};

/** 사용자 발언의 speakerId. Hermes conversation_history의 role 판정에 쓴다. */
export const USER_SPEAKER_ID = "user";

export class Transcript {
  private readonly turns: Turn[] = [];
  private readonly counts = new Map<string, number>();
  private readonly lastSpoke = new Map<string, number>();

  add(speakerId: string, displayName: string, content: string, now: number): Turn {
    const turn: Turn = { seq: this.turns.length + 1, speakerId, displayName, content, timestamp: now };
    this.turns.push(turn);
    this.counts.set(speakerId, (this.counts.get(speakerId) ?? 0) + 1);
    this.lastSpoke.set(speakerId, now);
    return turn;
  }

  all(): Turn[] {
    return [...this.turns];
  }

  recent(n: number): Turn[] {
    return this.turns.slice(-n);
  }

  turnCountFor(speakerId: string): number {
    return this.counts.get(speakerId) ?? 0;
  }

  lastSpokeAt(speakerId: string): number {
    return this.lastSpoke.get(speakerId) ?? 0;
  }

  /**
   * Hermes /v1/runs 의 conversation_history 형태로 직렬화한다.
   * 사용자 발언은 role="user", NPC 발언은 role="assistant".
   * 발언자 이름을 content에 접두하는 이유: 다자 대화에서 모델이 누가 말했는지
   * 알아야 하는데 role만으로는 NPC들을 구분할 수 없다.
   */
  toConversationHistory(limit: number): Array<{ role: string; content: string }> {
    return this.recent(limit).map((t) => ({
      role: t.speakerId === USER_SPEAKER_ID ? "user" : "assistant",
      content: `${t.displayName}: ${t.content}`,
    }));
  }
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `npx tsx --test src/lib/conversation/transcript.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/conversation/transcript.ts
git add -f src/lib/conversation/transcript.test.ts
git commit -m "feat(conversation): add transcript with Hermes conversation_history serialization"
```

---

## Task 4: ConversationEngine — 턴 루프를 어댑터 위로 올린다

**이 태스크가 P2의 본체다.** 기존 `MeetingBroker`가 `this.gateway.chatSend(...)`를 4곳에서 직접 부르는 결합(`meeting-broker.js:251,309,386,433`)을 끊고, 엔진이 `NpcAdapter`만 알게 만든다.

**Files:**
- Create: `src/lib/conversation/conversation-engine.ts`
- Test: `src/lib/conversation/conversation-engine.test.ts`

**Interfaces:**
- Consumes: `ConversationMode`/`Participant`/`needsPolling`/`eligibleParticipants`/`selectNextSpeaker` (Task 2), `Transcript`/`USER_SPEAKER_ID` (Task 3), `NpcAdapter`/`AdapterExecuteOptions` from `src/lib/adapters/types`
- Produces:
  - `type EngineParticipant = Participant & { adapter: NpcAdapter; sessionKey: string }`
  - `type EngineCallbacks` — `onPollStart?`, `onPollResult?`, `onTurnStart?`, `onTurnChunk?`, `onTurnEnd?`, `onEnd?`, `onError?` (기존 브로커 콜백과 같은 이름·같은 인자)
  - `class ConversationEngine` — `constructor(config, callbacks)`, `run(): Promise<void>`, `stop(): void`, `isRunning(): boolean`, `addUserMessage(name, content): void`, `remainingTurns(npcId): number`

**어댑터 호출 규약:** 엔진은 `adapter.execute({ sessionKey, prompt, conversationHistory, onDelta })`만 부른다. `HermesAdapter`는 `conversationHistory`가 비어 있지 않으면 runs 경로를 타고(P1 설계 §3.4), OpenClaw 어댑터는 그 필드를 무시한다 — 둘 다 같은 인터페이스로 동작한다.

**폴링 청크 분할:** 스펙 §3.5가 요구한다. 지금 브로커는 `Promise.allSettled`로 전원 동시 발사하는데(`meeting-broker.js:297`), Hermes의 `max_concurrent_runs`를 넘으면 뒤쪽이 429로 조용히 빠진다. 엔진은 `maxConcurrentPolls`를 받아 그 크기로 잘라 순차 실행한다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```typescript
// src/lib/conversation/conversation-engine.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ConversationEngine } from "./conversation-engine";
import type { EngineParticipant } from "./conversation-engine";
import type { NpcAdapter, AdapterExecuteOptions } from "@/lib/adapters/types";

/** 대본대로 답하는 목 어댑터. 호출 인자를 기록한다. */
function mockAdapter(replies: string[]): NpcAdapter & { calls: AdapterExecuteOptions[] } {
  const queue = [...replies];
  const calls: AdapterExecuteOptions[] = [];
  return {
    type: "mock",
    calls,
    async execute(options: AdapterExecuteOptions) {
      calls.push(options);
      const text = queue.length > 1 ? queue.shift()! : queue[0];
      options.onDelta?.(text);
      return { response: text, session: { sessionRef: options.sessionKey } };
    },
    async testConnection() {
      return { status: "ok" as const };
    },
  };
}

function participant(npcId: string, replies: string[], over: Partial<EngineParticipant> = {}): EngineParticipant {
  return {
    npcId, displayName: npcId, seated: true, turnCount: 0, lastSpokeAt: 0,
    adapter: mockAdapter(replies), sessionKey: `sk-${npcId}`, ...over,
  };
}

describe("ConversationEngine — peer 모드", () => {
  test("폴링 없이 교대로 발언한다", async () => {
    const a = participant("a", ["안녕"]);
    const b = participant("b", ["반가워"]);
    const spoken: string[] = [];
    const engine = new ConversationEngine(
      { mode: "peer", topic: "T", participants: [a, b],
        quota: { maxTotalTurns: 4, maxTurnsPerAgent: 10, cooldownMs: 0 } },
      { onTurnEnd: (npcId: string) => spoken.push(npcId) },
    );
    await engine.run();
    assert.deepEqual(spoken, ["a", "b", "a", "b"], "교대로 4턴");

    // 폴링이 없었음을 증명: 각 어댑터 호출 수 == 그 참가자의 발언 수
    const aCalls = (a.adapter as unknown as { calls: unknown[] }).calls.length;
    assert.equal(aCalls, 2, "peer는 발언당 1회만 호출한다(폴링 호출 없음)");
  });
});

describe("ConversationEngine — meeting 모드", () => {
  test("전원 PASS가 상한만큼 반복되면 종료한다", async () => {
    const a = participant("a", ["PASS"]);
    const b = participant("b", ["PASS"]);
    let ended = false;
    const engine = new ConversationEngine(
      { mode: "meeting", topic: "T", participants: [a, b],
        quota: { maxConsecutivePasses: 2, cooldownMs: 0, maxTotalTurns: 50, maxTurnsPerAgent: 20 } },
      { onEnd: () => { ended = true; } },
    );
    await engine.run();
    assert.equal(ended, true);
    assert.equal(engine.isRunning(), false);
  });

  test("SPEAK한 참가자에게만 발언권이 간다", async () => {
    const a = participant("a", ["SPEAK: 하겠습니다", "말합니다", "PASS"]);
    const b = participant("b", ["PASS"]);
    const spoken: string[] = [];
    const engine = new ConversationEngine(
      { mode: "meeting", topic: "T", participants: [a, b],
        quota: { maxConsecutivePasses: 2, cooldownMs: 0, maxTotalTurns: 2, maxTurnsPerAgent: 20 } },
      { onTurnEnd: (npcId: string) => spoken.push(npcId) },
    );
    await engine.run();
    assert.ok(spoken.includes("a"), "손든 a가 발언해야 한다");
    assert.equal(spoken.includes("b"), false, "PASS한 b는 발언하지 않는다");
  });
});

describe("ConversationEngine — 착석 게이트", () => {
  test("착석하지 않은 참가자는 폴링도 발언도 하지 않는다", async () => {
    const a = participant("a", ["PASS"]);
    const b = participant("b", ["SPEAK: 저요"], { seated: false });
    const engine = new ConversationEngine(
      { mode: "meeting", topic: "T", participants: [a, b],
        quota: { maxConsecutivePasses: 1, cooldownMs: 0, maxTotalTurns: 50, maxTurnsPerAgent: 20 } },
      {},
    );
    await engine.run();
    assert.equal((b.adapter as unknown as { calls: unknown[] }).calls.length, 0,
      "미착석 참가자는 어댑터가 한 번도 불리지 않아야 한다");
  });
});

describe("ConversationEngine — 폴링 청크", () => {
  test("maxConcurrentPolls보다 참가자가 많으면 나눠서 호출한다", async () => {
    const order: string[] = [];
    const many = ["a", "b", "c", "d"].map((id) => {
      const pt = participant(id, ["PASS"]);
      const inner = pt.adapter.execute.bind(pt.adapter);
      pt.adapter.execute = async (o: AdapterExecuteOptions) => { order.push(id); return inner(o); };
      return pt;
    });
    const engine = new ConversationEngine(
      { mode: "meeting", topic: "T", participants: many,
        quota: { maxConsecutivePasses: 1, cooldownMs: 0, maxTotalTurns: 50, maxTurnsPerAgent: 20 },
        maxConcurrentPolls: 2 },
      {},
    );
    await engine.run();
    assert.equal(order.length, 4, "네 명 모두 폴링된다");
  });
});

describe("ConversationEngine — 사용자 개입", () => {
  test("addUserMessage가 트랜스크립트에 들어가 다음 프롬프트에 실린다", async () => {
    const a = participant("a", ["SPEAK: 예", "답변"]);
    const engine = new ConversationEngine(
      { mode: "meeting", topic: "T", participants: [a],
        quota: { maxConsecutivePasses: 2, cooldownMs: 0, maxTotalTurns: 1, maxTurnsPerAgent: 20 } },
      {},
    );
    engine.addUserMessage("단테", "빨리 결론 내세요");
    await engine.run();
    const calls = (a.adapter as unknown as { calls: AdapterExecuteOptions[] }).calls;
    const withHistory = calls.find((c) => (c.conversationHistory?.length ?? 0) > 0);
    assert.ok(withHistory, "사용자 메시지가 conversationHistory로 전달되어야 한다");
    assert.ok(
      withHistory!.conversationHistory!.some((h) => h.content.includes("빨리 결론 내세요")),
      "사용자 발언 내용이 히스토리에 있어야 한다",
    );
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `npx tsx --test src/lib/conversation/conversation-engine.test.ts`
Expected: FAIL — `Cannot find module './conversation-engine'`

- [ ] **Step 3: 구현한다**

엔진은 다음 골격을 갖는다. `MeetingBroker.run()`(`meeting-broker.js:78-184`)의 루프 구조를 참조하되, 게이트웨이 호출을 어댑터 호출로 바꾸고 정책 판단을 Task 2의 함수에 위임한다.

```typescript
// src/lib/conversation/conversation-engine.ts
// 다자 대화 턴 루프. 어댑터만 알고 게이트웨이·소켓·DB를 모른다.

import type { NpcAdapter } from "@/lib/adapters/types";
import { Transcript, USER_SPEAKER_ID } from "./transcript";
import {
  eligibleParticipants, needsPolling, selectNextSpeaker,
  type ConversationMode, type Participant,
} from "./turn-policy";

export type EngineParticipant = Participant & {
  adapter: NpcAdapter;
  sessionKey: string;
};

export type EngineCallbacks = {
  onPollStart?: () => void;
  onPollResult?: (raises: Array<{ npcId: string; reason: string }>, passes: string[]) => void;
  onTurnStart?: (npcId: string, displayName: string) => void;
  onTurnChunk?: (npcId: string, chunk: string) => void;
  onTurnEnd?: (npcId: string, fullResponse: string) => void;
  onEnd?: (turns: ReturnType<Transcript["all"]>) => void;
  onError?: (err: unknown, npcId: string) => void;
};

export type EngineQuota = {
  maxTurnsPerAgent: number;
  maxTotalTurns: number;
  maxConsecutivePasses: number;
  cooldownMs: number;
};

export type EngineConfig = {
  mode: ConversationMode;
  topic: string;
  participants: EngineParticipant[];
  quota: EngineQuota;
  /** Hermes gateway.api_server.max_concurrent_runs 에 맞춘다. 기본 4. */
  maxConcurrentPolls?: number;
  /** 히스토리로 실어 보낼 최근 턴 수. 기본 10. */
  historyLimit?: number;
  now?: () => number;
};
```

구현 시 지켜야 할 것:

1. **`run()`의 루프**: 사용자 메시지 큐 비우기 → `eligibleParticipants`로 후보 산출 → `needsPolling(mode)`이면 폴링, 아니면 건너뛰기 → `selectNextSpeaker` → 발언 → 쿨다운. `isFinished()`(총 턴 상한 또는 연속 PASS 상한)에서 종료.
2. **폴링 청크**: 후보를 `maxConcurrentPolls` 크기로 잘라 청크마다 `Promise.allSettled`. 청크 사이는 순차. 실패한 참가자는 그 라운드에서 PASS로 취급하고 회의를 중단하지 않는다(현행 동작 보존 — `meeting-broker.js:322-325`).
3. **응답 해석**: `SPEAK`/`PASS` 판정과 접두어 제거는 **기존 `src/lib/meeting-formatter.js`의 `parseHandRaise`·`sanitizeSpokenResponse`·`sanitizeStreamingSpokenResponse`를 재사용한다.** 새로 만들지 말 것 — 기준선 테스트가 그 동작을 고정하고 있다.
4. **프롬프트**: 폴링·발언 프롬프트도 `meeting-formatter.js`의 `formatPollMessage`·`formatSpeakMessage`를 재사용한다. 다만 `conversationHistory`를 별도로 실어 보내므로, 프롬프트에 트랜스크립트를 통째로 넣는 기존 방식과 중복되지 않게 `recentTurns` 인자를 빈 배열로 넘기고 히스토리로 대체할지, 아니면 현행 유지할지 **판단해 보고서에 적는다**(D9의 동작 보존 관점에서는 현행 유지가 안전하다).
5. **중단**: `stop()`은 실행 플래그를 내리고, 진행 중인 턴이 있으면 그 참가자의 `adapter.abort?.(sessionKey)`를 부른다.

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `npx tsx --test src/lib/conversation/conversation-engine.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: 전체 스위트 확인**

Run: `npx tsx --test $(git ls-files 'src/**/*.test.ts' 'src/**/*.test.js' | tr '\n' ' ') && npx tsc --noEmit 2>&1 | rg "error TS" | rg -v '\.test\.' | wc -l`
Expected: 실패 0, 비테스트 타입 에러 0

- [ ] **Step 6: Commit**

```bash
git add src/lib/conversation/conversation-engine.ts
git add -f src/lib/conversation/conversation-engine.test.ts
git commit -m "feat(conversation): add adapter-backed ConversationEngine with three modes"
```

---

## Task 4.5: 두 겹 타임아웃 — "죽었나"와 "폭주하나"를 다른 장치로 잡는다

스펙 §3.5가 요구한다. 현재 브로커는 `turnTimeoutMs` 하나뿐이라(`meeting-broker.js:72`) **"긴 도구 작업 중"과 "멈춘 에이전트"를 구분하지 못한다.** 파일을 오래 읽는 NPC가 죽은 것으로 오인되어 잘리거나, 반대로 상한을 넉넉히 잡으면 진짜 멈춘 에이전트를 그만큼 기다린다.

[[buzz]]가 이 문제를 두 타이머로 푼다 — idle(기본 620초, 에이전트 stdout 활동이 있으면 리셋)과 max turn(기본 7200초 절대 상한). P1의 SSE 계약이 `tool.progress` 이벤트를 주므로(`api_server.py:3914`) 그것을 활동 신호로 쓸 수 있다.

**Files:**
- Create: `src/lib/conversation/turn-timeout.ts`
- Test: `src/lib/conversation/turn-timeout.test.ts`
- Modify: `src/lib/conversation/conversation-engine.ts` — 발언 시 타임아웃 적용

**Interfaces:**
- Consumes: 없음
- Produces:
  - `type TurnTimeoutConfig = { idleMs: number; maxMs: number }`
  - `function createTurnTimeout(config, onTimeout: (kind: "idle" | "max") => void): { touch(): void; clear(): void }`

**설계 의도:** 타이머 두 개를 한 객체가 소유한다. `touch()`는 idle 타이머만 재설정하고 max 타이머는 건드리지 않는다 — 그래야 활동이 계속돼도 절대 상한이 지켜진다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```typescript
// src/lib/conversation/turn-timeout.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createTurnTimeout } from "./turn-timeout";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createTurnTimeout", () => {
  test("활동이 없으면 idle로 만료된다", async () => {
    const fired: string[] = [];
    const t = createTurnTimeout({ idleMs: 30, maxMs: 5000 }, (kind) => fired.push(kind));
    await tick(60);
    t.clear();
    assert.deepEqual(fired, ["idle"]);
  });

  test("touch가 idle 타이머를 미룬다", async () => {
    const fired: string[] = [];
    const t = createTurnTimeout({ idleMs: 50, maxMs: 5000 }, (kind) => fired.push(kind));
    await tick(30); t.touch();
    await tick(30); t.touch();
    await tick(30);
    t.clear();
    assert.deepEqual(fired, [], "계속 활동하면 idle로 죽지 않는다");
  });

  test("touch를 반복해도 절대 상한은 지켜진다", async () => {
    const fired: string[] = [];
    const t = createTurnTimeout({ idleMs: 1000, maxMs: 60 }, (kind) => fired.push(kind));
    for (let i = 0; i < 5; i++) { await tick(20); t.touch(); }
    t.clear();
    assert.deepEqual(fired, ["max"], "활동이 있어도 max에서는 잘린다");
  });

  test("clear 이후에는 아무것도 발화하지 않는다", async () => {
    const fired: string[] = [];
    const t = createTurnTimeout({ idleMs: 20, maxMs: 20 }, (kind) => fired.push(kind));
    t.clear();
    await tick(60);
    assert.deepEqual(fired, []);
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `npx tsx --test src/lib/conversation/turn-timeout.test.ts`
Expected: FAIL — `Cannot find module './turn-timeout'`

- [ ] **Step 3: 구현한다**

```typescript
// src/lib/conversation/turn-timeout.ts
// 한 턴에 두 겹의 시한을 건다.
//   idle — 에이전트가 살아 있다는 신호(tool.progress, assistant.delta)가 오면 리셋.
//          "멈췄나"를 잡는다.
//   max  — 활동과 무관한 절대 상한. "폭주하나"를 잡는다.
// 하나의 타이머로는 이 둘을 구분할 수 없다: 넉넉히 잡으면 멈춘 에이전트를 오래 기다리고,
// 짧게 잡으면 오래 걸리는 정상 작업을 죽인다.

export type TurnTimeoutConfig = { idleMs: number; maxMs: number };

export function createTurnTimeout(
  config: TurnTimeoutConfig,
  onTimeout: (kind: "idle" | "max") => void,
): { touch(): void; clear(): void } {
  let done = false;
  let idleTimer: ReturnType<typeof setTimeout>;

  const fire = (kind: "idle" | "max") => {
    if (done) return;
    done = true;
    clearTimeout(idleTimer);
    clearTimeout(maxTimer);
    onTimeout(kind);
  };

  const maxTimer = setTimeout(() => fire("max"), config.maxMs);
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => fire("idle"), config.idleMs);
  };
  armIdle();

  return {
    touch() {
      if (!done) armIdle();
    },
    clear() {
      done = true;
      clearTimeout(idleTimer);
      clearTimeout(maxTimer);
    },
  };
}
```

- [ ] **Step 4: 엔진에 배선한다**

`ConversationEngine`의 발언 실행부에서 턴마다 타임아웃을 만들고, `onDelta`와 `onToolProgress` 양쪽에서 `touch()`를 부른다. 만료되면 그 참가자의 `adapter.abort?.(sessionKey)`를 호출하고 `onError`로 알린 뒤 다음 턴으로 넘어간다 — 회의 전체를 중단하지 않는다(현행 동작 보존).

`AdapterExecuteOptions.onToolProgress`는 P1에서 이미 인터페이스에 있다(`src/lib/adapters/types.ts`). `HermesAdapter`가 `tool.progress` SSE를 그 콜백으로 중계하므로(`hermes-adapter.ts`의 `relay`), 엔진은 그것만 소비하면 된다. OpenClaw 어댑터는 이 콜백을 부르지 않으므로 idle 리셋이 `onDelta`로만 일어난다 — **동작 차이가 아니라 신호 밀도 차이**이며, 기본값을 넉넉히 잡아 흡수한다.

기본값은 스펙에 없으므로 정한다: `idleMs: 180_000`(현행 `turnTimeoutMs`와 동일), `maxMs: 600_000`. 근거를 보고서에 적는다.

- [ ] **Step 5: 테스트가 통과하는지 확인한다**

Run: `npx tsx --test src/lib/conversation/turn-timeout.test.ts src/lib/conversation/conversation-engine.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/conversation/turn-timeout.ts src/lib/conversation/conversation-engine.ts
git add -f src/lib/conversation/turn-timeout.test.ts
git commit -m "feat(conversation): add two-tier turn timeout separating idle from runaway"
```

---

## Task 5: 회의 경로를 엔진으로 전환

**Files:**
- Modify: `src/server/meeting-discussion.ts` — `createMeetingBroker` 호출부(`:245-260`)와 `adapterResolver` 하드코딩(`:249`)
- Modify: `src/server/socket-handlers.ts` — `streamMeetingNpcResponse`(`:787` 부근)의 openclaw 전용 가드

**Interfaces:**
- Consumes: `ConversationEngine`/`EngineParticipant` (Task 4), `classifyNpcDispatch`/`createHermesAdapterForNpc` from `src/server/hermes-dispatch`
- Produces: 없음

**지금 무엇이 막고 있나:**

- `meeting-discussion.ts:249`가 `adapterResolver: (_npcId) => openclawAdapter`로 **하드코딩**돼 있다. 인자를 받으면서 무시한다 — 미완성 리팩터의 흔적이다.
- `socket-handlers.ts:787`의 가드가 `!adapterRegistry.has(adapterType) || adapterType !== openclawAdapter.type`이라 **openclaw가 아니면 전부 `unsupported_adapter`**로 떨어진다.

- [ ] **Step 1: 참가자 조립을 실제 어댑터 해석으로 바꾼다**

각 NPC에 대해 `classifyNpcDispatch({ adapterType, hermesProfileId })`로 갈래를 정하고, `"hermes"`면 `createHermesAdapterForNpc(npcId, userId, contextKey)`로, `"registry"`면 `adapterRegistry.get(adapterType)`으로, `"openclaw"`면 게이트웨이 기반 어댑터로 해석한다. `"unbound"`인 NPC는 참가자 목록에서 제외하고 그 사실을 회의 참가자들에게 알린다(조용히 빼지 말 것).

**P1b 판정을 지킬 것:** 어댑터는 회의 시작 시점에 참가자별로 한 번 만들고 그 회의 동안 재사용한다. 회의는 하나의 논리적 대화이므로 이는 "디스패치마다 생성"과 모순되지 않는다 — 금지되는 것은 **여러 대화가 한 인스턴스를 공유하는 것**이다. 보고서에 이 해석을 명시하라.

- [ ] **Step 2: 회의 스트리밍 가드를 완화한다**

`streamMeetingNpcResponse`의 openclaw 전용 가드를 `classifyNpcDispatch` 기반으로 바꾼다. P1b에서 `agentId` 가드를 어댑터 판정 뒤로 옮겨둔 구조(`socket-handlers.ts:787-800`)를 유지하면서, hermes 갈래가 실제로 동작하도록 배선한다.

- [ ] **Step 3: 기준선 테스트가 여전히 통과하는지 확인한다**

Run: `npx tsx --test src/lib/meeting-broker-baseline.test.ts src/server/meeting-discussion.test.ts src/server/meeting-socket.test.ts`
Expected: 전부 PASS. **여기서 깨지면 D9 위반이다** — 무엇이 달라졌는지 정확히 찾아 보고하고, 의도된 변경이 아니면 되돌린다.

- [ ] **Step 4: 전체 스위트와 타입 검사**

Run: `npx tsx --test $(git ls-files 'src/**/*.test.ts' 'src/**/*.test.js' | tr '\n' ' ') && npx tsc --noEmit 2>&1 | rg "error TS" | rg -v '\.test\.' | wc -l`
Expected: 실패 0, 비테스트 타입 에러 0

- [ ] **Step 5: Commit**

```bash
git add src/server/meeting-discussion.ts src/server/socket-handlers.ts
git commit -m "feat(meeting): route meetings through ConversationEngine so any adapter can join"
```

---

## Task 6: 최종 검증

- [ ] **Step 1: 추적 테스트 전체**

Run: `npx tsx --test $(git ls-files 'src/**/*.test.ts' 'src/**/*.test.js' | tr '\n' ' ')`
Expected: 실패 0. 기준선(445) + 신규 약 33개.

- [ ] **Step 2: 타입 검사와 린트**

Run: `npx tsc --noEmit`(비테스트 에러 0) 및 `npx eslint src/lib/conversation/ src/server/meeting-discussion.ts src/server/socket-handlers.ts`
Expected: 에러 0

- [ ] **Step 3: 프로덕션 빌드**

Run: `npm run build`
Expected: 성공

- [ ] **Step 4: Dockerfile COPY 목록 갱신**

`src/lib/conversation/` 세 파일이 `socket-handlers.ts`의 전이 폐포에 들어왔다. `Dockerfile`의 명시 COPY 목록에 추가하지 않으면 **이미지가 부팅에 실패한다**(P1b에서 실제로 걸린 함정). 폐포를 다시 계산해 누락이 없는지 확인한다:

```bash
# socket-handlers.ts에서 시작해 import/require를 재귀적으로 따라간 뒤
# Dockerfile의 COPY 목록과 대조한다
rg -o "COPY --from=builder /app/(src/[^ ]+)" -r '$1' Dockerfile | sort -u
```

- [ ] **Step 5: 수동 검증 항목 갱신**

`.superpowers/sdd/2026-08-17-p1-hermes-transport/manual-verification.md`의 "P1에서 안 되는 것" 표에서 **회의 참가**를 "동작"으로 정정하고, 확인 절차를 추가한다 — Hermes NPC 2명과 OpenClaw NPC 1명을 한 회의에 넣어 셋 다 발언하는지.

- [ ] **Step 6: Commit**

```bash
git add Dockerfile
git commit -m "build(docker): copy conversation engine files into the image"
```

---

## Self-Review 결과

**스펙 커버리지** — §3.5의 요구 중: 3모드 정책(Task 2) ✅, 착석 게이트(Task 2의 `eligibleParticipants` + Task 4 테스트) ✅, 폴링 청크 분할(Task 4) ✅, `conversation_history` 구조화(Task 3) ✅, 어댑터 위로 승격(Task 4·5) ✅, 두 겹 타임아웃(Task 4.5) ✅.

첫 점검에서 두 겹 타임아웃에 태스크가 없는 것을 발견해 Task 4.5로 추가했다. Task 4에 접어넣지 않고 분리한 이유: 타이머 로직은 순수 함수로 테스트 가능한데(`createTurnTimeout`) 엔진에 섞으면 시간 의존 테스트가 엔진 테스트 전체를 느리고 불안정하게 만든다.

**Buzz에서 가져오는 나머지 안전장치 중 이 계획에 없는 것** — owner 제어 명령 우선 처리(중단·전원 정지가 커맨드 큐를 건너뛰는 것)는 현행 `stop()`이 이미 큐를 우회하므로(`meeting-broker.js:196`) Task 4에서 그 동작을 옮기면 자동으로 만족된다. fail-closed(참가 자격 판정 실패 시 차단)는 `eligibleParticipants`가 `seated`를 요구하는 형태로 이미 반영돼 있다.

**범위 밖으로 명시한 것** — 태스크 자동화 Hermes 배선, 크로스 게이트웨이 프로필 라우트, 게이트웨이 캐시 일원화, `getNpcConfig` 캐시, 동적 회의실(P3).

**가장 위험한 지점** — Task 5 Step 3. 기준선 테스트가 깨지면 D9 위반이고, 그 판정이 "의도된 개선"으로 슬쩍 넘어가면 P2의 성공 기준이 무너진다. 그래서 Step 3을 별도 단계로 두고 전체 스위트(Step 4)보다 **먼저** 돌리게 했다.

**타입 일관성** — `Participant`(Task 2)를 `EngineParticipant`(Task 4)가 확장하며 `adapter`·`sessionKey`를 더한다. `Transcript`의 `USER_SPEAKER_ID`를 엔진이 `addUserMessage`에서 쓴다. 콜백 이름은 기존 브로커와 동일하게 유지하되 `onMeetingEnd` → `onEnd`로만 바꿨다(모드가 회의만이 아니므로) — Task 5의 호출부가 이 이름 변경을 흡수한다.
