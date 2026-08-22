// NPC 하나가 스스로 담당하는 일: 프롬프트 조립, 턴 타임아웃, 스트리밍 정제, 멘션 파싱.
// conversation-engine.ts의 speak()/pollCandidates()에서 그대로 옮겼다(순수 이동, 동작 변경 없음).
// 트랜스크립트 기록과 콜백 방출은 채널(엔진)의 일이라 여기 없다 — SpeakOutcome이 그 경계다.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { formatPollMessage, formatSpeakMessage, parseHandRaise, sanitizeSpokenResponse, sanitizeStreamingSpokenResponse } = require("../meeting-formatter.js") as typeof import("../meeting-formatter.js");

import { parseMention } from "./mention";
import { Transcript } from "./transcript";
import { createTurnTimeout, type TurnTimeoutConfig } from "./turn-timeout";
import type { EngineParticipant } from "./channel-runtime";

/**
 * 신호(assistant delta / tool progress)가 이만큼 끊기면 턴을 끊는다.
 *
 * 이건 이식이 아니라 새 동작이다. meeting-broker.js:72의 turnTimeoutMs는 초기화 구문
 * 외에는 아무 데서도 읽히지 않는 죽은 설정이었고, 옛 브로커는 턴을 타임아웃시킨 적이 없다 —
 * 멈춘 에이전트는 회의를 영원히 붙잡았다. 값(180초)만 그 죽은 설정에서 가져왔다.
 *
 * 대가가 있다: idle 타이머는 onDelta/onToolProgress에서만 리셋되는데
 * OpenClawAdapter는 onToolProgress를 절대 호출하지 않는다(openclaw-adapter.ts:33,39 —
 * onDelta만 전달한다). 그래서 도구를 3분 넘게 조용히 돌리는 OpenClaw NPC는 예전이라면
 * 완주했을 턴이 지금은 중단되고 에러로 보고된다. 스펙의 "tool.progress 수신 시 idle
 * 타이머를 리셋한다"는 현재 Hermes 경로에만 구현돼 있다.
 */
export const DEFAULT_IDLE_MS = 180_000;
/** idle보다 넉넉히 큰 절대 상한. 정상적인 다중 도구 호출 턴을 죽이지 않으면서 폭주를 막는다. */
export const DEFAULT_MAX_MS = 600_000;

/**
 * 연속 실패 한도. 이 횟수만큼 턴이 연속으로 실패하면 엔진의 후보 필터에서 빠진다
 * (isBurnedOut()).
 *
 * 실패한 턴은 트랜스크립트에 아무것도 남기지 않으므로 maxTotalTurns·remainingTurns·
 * consecutivePasses 중 어느 것도 전진하지 않는다 — 폴링이 없는 peer 모드에서는 브레이크가
 * 하나도 없어 루프가 무한히 돈다(리뷰 실측: maxTotalTurns 3에 50회 이상).
 *
 * 3인 이유: 1이면 일시적인 네트워크 오류 한 번에 회의가 죽고, 크게 잡으면 백엔드가 완전히
 * 내려간 상황에서 사용자가 기다리는 시간만 길어진다. 3연속이면 "일시적"이라고 보기 어렵다.
 * 설정값으로 빼지 않는다 — 이 값을 읽는 설정 경로가 아직 없다.
 */
export const MAX_CONSECUTIVE_FAILURES = 3;

export type NpcRuntimeDeps = {
  transcript: Transcript;
  topic: string;
  allParticipants: EngineParticipant[];
  maxTotalTurns: number;
  historyLimit: number;
  turnTimeout: TurnTimeoutConfig;
  now: () => number;
};

export type SpeakOutcome =
  | { kind: "spoke"; text: string; mentionNpcId: string | null }
  // partialText: 스트리밍으로 이미 화면에 나간 텍스트. 실패한 턴에도 실어 보내는 이유는
  // 클라이언트의 말풍선이 onTurnEnd 없이는 닫히지 않기 때문이다 — 닫을 때 화면에 남은
  // 것과 같은 내용을 넘겨야 확정된 말풍선이 스트리밍 중과 달라 보이지 않는다.
  | { kind: "empty"; mentionNpcId: string | null; partialText: string }
  | { kind: "error"; error: unknown; partialText: string; timedOut: { kind: string } | null };

export class NpcRuntime {
  readonly npcId: string;
  readonly displayName: string;
  readonly participant: EngineParticipant;
  private readonly deps: NpcRuntimeDeps;
  private failures = 0;

  constructor(participant: EngineParticipant, deps: NpcRuntimeDeps) {
    this.participant = participant;
    this.npcId = participant.npcId;
    this.displayName = participant.displayName;
    this.deps = deps;
  }

  failureCount(): number {
    return this.failures;
  }

  noteFailure(): void {
    this.failures += 1;
  }

  noteSuccess(): void {
    this.failures = 0;
  }

  /** 이 NPC 가 실패 예산을 소진했는가. 소진한 NPC 는 후보에서 빠진다. */
  isBurnedOut(): boolean {
    return this.failures >= MAX_CONSECUTIVE_FAILURES;
  }

  /** 현재 발언 중인 이 NPC의 어댑터에 abort를 요청한다. meeting-broker.js:249-253 이식. */
  abort(): void {
    this.participant.adapter.abort?.(this.participant.sessionKey)?.catch(() => {});
  }

  /** 손들기 폴 하나를 실행한다. 실패(reject)는 호출자(pollCandidates)가 그대로 받는다
   * — 실패한 참가자를 raises/passes 어느 쪽에도 넣지 않는 처리는 엔진의 일이다. */
  async poll(remaining: number): Promise<{ wantsToSpeak: boolean; reason: string }> {
    const currentTurn = this.deps.transcript.all().length;
    const maxTurns = this.deps.maxTotalTurns;
    const recentTurns = this.deps.transcript.recent(3);
    const pollMsg = formatPollMessage(
      this.deps.topic,
      recentTurns,
      { displayName: this.participant.displayName },
      currentTurn,
      maxTurns,
      remaining,
      this.participant.passPolicy ?? null,
    );
    const { response } = await this.participant.adapter.execute({
      sessionKey: `${this.participant.sessionKey}-poll`,
      prompt: pollMsg,
      // 폴은 히스토리를 싣지 않지만 그래도 다자 대화다 — NPC의 영속 세션에
      // "SPEAK:/PASS" 문답이 쌓이면 안 된다.
      multiParty: true,
    });
    return parseHandRaise(response);
  }

  /**
   * 발언권을 받아 스트리밍 응답을 받고 지목을 뽑는다. throw 하지 않는다 — 모든 실패를
   * SpeakOutcome 으로 돌려준다. 그래야 콜백 호출 조건(트랜스크립트 기록·onTurnEnd 등)이
   * 엔진 한 곳에 모인다.
   */
  async takeTurn(remaining: number, hooks: { onChunk: (chunk: string) => void }): Promise<SpeakOutcome> {
    const currentTurn = this.deps.transcript.all().length;
    const maxTurns = this.deps.maxTotalTurns;
    const historyLimit = this.deps.historyLimit;
    const recentTurns = this.deps.transcript.recent(historyLimit);

    // 프롬프트/히스토리 중복에 대한 판단: formatSpeakMessage는 recentTurns를 그대로
    // 프롬프트 텍스트에 접어넣는다. conversationHistory도 함께 실어 보내면 같은 내용이
    // 프롬프트와 구조화 히스토리 양쪽에 중복된다. D9(동작 보존)가 이번 단계의 성공 기준이므로
    // 프롬프트 조립 방식을 그대로 유지하고(옵션 a), conversationHistory는 별도 필드로 추가한다 —
    // 토큰 낭비를 감수하는 대신 회귀 위험을 없앤다. (초기 구현의 주석은 프롬프트가 "바이트 단위로
    // 동일"하다고 단언했지만, 그때 passPolicy와 role이 함께 빠져 있어 사실이 아니었다.)
    const participantsForFormat = this.deps.allParticipants.map((p) => ({
      displayName: p.displayName,
      role: p.role || "Participant",
    }));
    const message = formatSpeakMessage(
      this.deps.topic,
      participantsForFormat,
      recentTurns,
      { displayName: this.participant.displayName },
      currentTurn,
      maxTurns,
      remaining,
    );

    let rawText = "";
    let emittedText = "";
    // 두 겹 타임아웃(§3.5) — idle은 onDelta/onToolProgress(활동 신호)가 올 때마다 touch()로
    // 리셋되고, max는 아무것도 리셋하지 않는 절대 상한이다. 어느 쪽이 먼저 발화하든 adapter.abort()로
    // 이 턴을 끊고 execute()의 대기를 reject해서 회의 루프가 다음 턴으로 넘어가게 한다 —
    // 회의 전체는 멈추지 않는다(옛 turnTimeoutMs 실패 처리와 동일).
    let timedOutKind: string | null = null;
    try {
      const { response } = await new Promise<{ response: string }>((resolve, reject) => {
        const timeout = createTurnTimeout(this.deps.turnTimeout, (kind) => {
          timedOutKind = kind;
          this.participant.adapter.abort?.(this.participant.sessionKey)?.catch(() => {});
          reject(new Error(`turn timeout (${kind})`));
        });
        this.participant.adapter
          .execute({
            sessionKey: this.participant.sessionKey,
            prompt: message,
            // 트랜스크립트는 엔진이 소유한다. 첫 턴은 히스토리가 비지만 그것도 다자 대화의
            // 한 턴이므로 전송 경로가 2번째 턴부터와 달라지면 안 된다.
            multiParty: true,
            conversationHistory: this.deps.transcript.toConversationHistory(historyLimit),
            onDelta: (chunk) => {
              timeout.touch();
              rawText += chunk;
              const sanitizedText = sanitizeStreamingSpokenResponse(rawText);
              const delta = sanitizedText.slice(emittedText.length);
              emittedText = sanitizedText;
              if (delta) hooks.onChunk(delta);
            },
            onToolProgress: () => {
              timeout.touch();
            },
          })
          .then((result) => {
            timeout.clear();
            resolve(result);
          })
          .catch((err) => {
            timeout.clear();
            reject(err);
          });
      });

      const sanitizedResponse = sanitizeSpokenResponse(response || rawText);
      if (sanitizedResponse) {
        // 지목을 뽑고, 화면·트랜스크립트에는 제어 라인이 빠진 본문만 남긴다.
        const mention = parseMention(
          sanitizedResponse,
          this.deps.allParticipants.map((p) => ({ npcId: p.npcId, displayName: p.displayName })),
          this.participant.npcId,
        );

        if (mention.text) {
          return { kind: "spoke", text: mention.text, mentionNpcId: mention.npcId };
        }
        // "TO: 이름"만 있고 본문이 없는 응답 — parseMention이 지목 줄을 걷어내면 남는 텍스트가
        // 없다. sanitizedResponse 자체는 비어있지 않아 위 gate는 통과하지만, 화면에 보여줄
        // 말도, 트랜스크립트에 남길 발언도 없다. 아래 catch-all과 동일하게 "쓸 만한 텍스트가
        // 하나도 없는 턴"으로 취급한다. 다만 지목 자체는 유효한 의사표시이므로 mentionNpcId는
        // 그대로 돌려준다(엔진이 인박스에 넣는다).
        return { kind: "empty", mentionNpcId: mention.npcId, partialText: emittedText };
      }
      // 정상적으로 resolve했지만 쓸 만한 텍스트가 하나도 없는 턴은, 루프 입장에서는 실패한
      // 턴이다 — 트랜스크립트에 아무것도 안 실리므로 maxTotalTurns·remainingTurns·
      // consecutivePasses 중 무엇도 전진하지 않는다.
      return { kind: "empty", mentionNpcId: null, partialText: emittedText };
    } catch (err) {
      return {
        kind: "error",
        error: err,
        partialText: emittedText,
        timedOut: timedOutKind ? { kind: timedOutKind } : null,
      };
    }
  }
}
