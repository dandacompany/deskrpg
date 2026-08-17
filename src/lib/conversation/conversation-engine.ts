// 다자 대화 턴 루프. 어댑터만 알고 게이트웨이·소켓·DB를 모른다.
// MeetingBroker.run()(meeting-broker.js:78-184)의 루프 구조를 어댑터 위로 이식한 것 —
// 게이트웨이 호출을 NpcAdapter.execute() 호출로 바꾸고, 정책 판단은 turn-policy.ts에 위임한다.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  formatPollMessage,
  formatSpeakMessage,
  parseHandRaise,
  sanitizeSpokenResponse,
  sanitizeStreamingSpokenResponse,
} = require("../meeting-formatter.js") as typeof import("../meeting-formatter.js");

import type { NpcAdapter } from "@/lib/adapters/types";
import { Transcript, USER_SPEAKER_ID, type Turn } from "./transcript";
import {
  eligibleParticipants,
  needsPolling,
  selectNextSpeaker,
  type ConversationMode,
  type Participant,
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
  onEnd?: (turns: Turn[]) => void;
  onError?: (err: unknown, npcId: string) => void;
};

export type EngineQuota = {
  maxTurnsPerAgent: number;
  maxTotalTurns: number;
  /** peer 모드는 손들기가 없어 연속 PASS 개념이 없으므로 생략 가능. 기본 2(브로커 기본값과 동일). */
  maxConsecutivePasses?: number;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 청크 단위로 나눠 순차 실행한다. Hermes의 max_concurrent_runs를 넘는 폴링이
 * 한꺼번에 발사되어 429로 조용히 유실되는 것을 막는다(스펙 §3.5). */
function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export class ConversationEngine {
  private readonly config: EngineConfig;
  private readonly callbacks: EngineCallbacks;
  private readonly transcript = new Transcript();
  private readonly now: () => number;

  private running = false;
  private consecutivePasses = 0;
  private lastSpeakerId: string | null = null;
  private userMessageQueue: Array<{ userName: string; content: string }> = [];

  constructor(config: EngineConfig, callbacks: EngineCallbacks) {
    this.config = config;
    this.callbacks = callbacks;
    this.now = config.now ?? Date.now;
  }

  isRunning(): boolean {
    return this.running;
  }

  addUserMessage(userName: string, content: string): void {
    this.userMessageQueue.push({ userName, content });
    this.consecutivePasses = 0;
  }

  remainingTurns(npcId: string): number {
    return Math.max(0, this.config.quota.maxTurnsPerAgent - this.transcript.turnCountFor(npcId));
  }

  stop(): void {
    this.running = false;
  }

  async run(): Promise<void> {
    this.running = true;

    while (this.running && !this.isFinished()) {
      // 1. 사용자 메시지 큐 비우기
      while (this.userMessageQueue.length > 0) {
        const { userName, content } = this.userMessageQueue.shift()!;
        this.transcript.add(USER_SPEAKER_ID, userName, content, this.now());
        this.consecutivePasses = 0;
      }

      // 2. 후보 산출
      const candidates = eligibleParticipants(
        this.config.participants,
        (npcId) => this.remainingTurns(npcId),
      );
      if (candidates.length === 0) break;

      let speaker: Participant | null;

      if (needsPolling(this.config.mode)) {
        const { raises, passes } = await this.pollCandidates(candidates);
        this.callbacks.onPollResult?.(
          raises.map((r) => ({ npcId: r.npcId, reason: r.reason })),
          passes,
        );

        if (raises.length === 0) {
          this.consecutivePasses++;
          if (this.consecutivePasses >= this.maxConsecutivePasses()) break;
          await sleep(this.config.quota.cooldownMs);
          continue;
        }
        this.consecutivePasses = 0;

        const raisedCandidates = candidates.filter((c) => raises.some((r) => r.npcId === c.npcId));
        speaker = selectNextSpeaker(this.config.mode, raisedCandidates, this.lastSpeakerId);
      } else {
        speaker = selectNextSpeaker(this.config.mode, candidates, this.lastSpeakerId);
      }

      if (!speaker) continue;

      const engineSpeaker = this.findParticipant(speaker.npcId);
      if (!engineSpeaker) continue;

      await this.speak(engineSpeaker);
      await sleep(this.config.quota.cooldownMs);
    }

    this.running = false;
    this.callbacks.onEnd?.(this.transcript.all());
  }

  private maxConsecutivePasses(): number {
    return this.config.quota.maxConsecutivePasses ?? 2;
  }

  private findParticipant(npcId: string): EngineParticipant | undefined {
    return this.config.participants.find((p) => p.npcId === npcId);
  }

  private isFinished(): boolean {
    return (
      this.transcript.all().length >= this.config.quota.maxTotalTurns ||
      this.consecutivePasses >= this.maxConsecutivePasses()
    );
  }

  /**
   * 후보를 maxConcurrentPolls 크기로 나눠 청크마다 병렬 폴링한다(청크 사이는 순차).
   * 실패한 참가자는 raises/passes 어느 쪽에도 넣지 않는다 — 회의를 중단시키지 않되
   * 그 라운드에서는 사실상 PASS로 취급된다(현행 meeting-broker.js:322-325 동작 보존, 결함 보존).
   */
  private async pollCandidates(
    candidates: Participant[],
  ): Promise<{ raises: Array<{ npcId: string; reason: string }>; passes: string[] }> {
    this.callbacks.onPollStart?.();

    const raises: Array<{ npcId: string; reason: string }> = [];
    const passes: string[] = [];
    const currentTurn = this.transcript.all().length;
    const maxTurns = this.config.quota.maxTotalTurns;
    const recentTurns = this.transcript.recent(3);
    const maxConcurrentPolls = this.config.maxConcurrentPolls ?? 4;

    for (const group of chunk(candidates, maxConcurrentPolls)) {
      const results = await Promise.allSettled(
        group.map(async (c) => {
          const engineParticipant = this.findParticipant(c.npcId)!;
          const remaining = this.remainingTurns(c.npcId);
          const pollMsg = formatPollMessage(
            this.config.topic,
            recentTurns,
            { displayName: c.displayName },
            currentTurn,
            maxTurns,
            remaining,
            null,
          );
          const { response } = await engineParticipant.adapter.execute({
            sessionKey: `${engineParticipant.sessionKey}-poll`,
            prompt: pollMsg,
          });
          return { npcId: c.npcId, text: response };
        }),
      );

      for (const result of results) {
        if (result.status === "rejected") {
          // 실패한 참가자는 조용히 건너뛴다 — 회의를 중단하지 않는다(보존된 결함 3).
          continue;
        }
        const { npcId, text } = result.value;
        const parsed = parseHandRaise(text);
        if (parsed.wantsToSpeak) {
          raises.push({ npcId, reason: parsed.reason });
        } else {
          passes.push(npcId);
        }
      }
    }

    return { raises, passes };
  }

  /** 발언권을 부여하고 스트리밍 응답을 받아 트랜스크립트에 기록한다. */
  private async speak(participant: EngineParticipant): Promise<void> {
    this.callbacks.onTurnStart?.(participant.npcId, participant.displayName);

    const currentTurn = this.transcript.all().length;
    const maxTurns = this.config.quota.maxTotalTurns;
    const remaining = this.remainingTurns(participant.npcId);
    const historyLimit = this.config.historyLimit ?? 10;
    const recentTurns = this.transcript.recent(historyLimit);

    // 프롬프트/히스토리 중복에 대한 판단: formatSpeakMessage는 recentTurns를 그대로
    // 프롬프트 텍스트에 접어넣는다. conversationHistory도 함께 실어 보내면 같은 내용이
    // 프롬프트와 구조화 히스토리 양쪽에 중복된다. D9(동작 보존)가 이번 단계의 성공 기준이므로
    // 프롬프트는 오늘과 바이트 단위로 동일하게 유지하고(옵션 a), conversationHistory는
    // 별도 필드로 추가한다 — 토큰 낭비를 감수하는 대신 회귀 위험을 없앤다.
    const participantsForFormat = this.config.participants.map((p) => ({
      displayName: p.displayName,
      role: "Participant",
    }));
    const message = formatSpeakMessage(
      this.config.topic,
      participantsForFormat,
      recentTurns,
      { displayName: participant.displayName },
      currentTurn,
      maxTurns,
      remaining,
    );

    let rawText = "";
    let emittedText = "";
    try {
      const { response } = await participant.adapter.execute({
        sessionKey: participant.sessionKey,
        prompt: message,
        conversationHistory: this.transcript.toConversationHistory(historyLimit),
        onDelta: (chunk) => {
          rawText += chunk;
          const sanitizedText = sanitizeStreamingSpokenResponse(rawText);
          const delta = sanitizedText.slice(emittedText.length);
          emittedText = sanitizedText;
          if (delta) this.callbacks.onTurnChunk?.(participant.npcId, delta);
        },
      });
      const sanitizedResponse = sanitizeSpokenResponse(response || rawText);
      if (sanitizedResponse) {
        this.transcript.add(participant.npcId, participant.displayName, sanitizedResponse, this.now());
        this.lastSpeakerId = participant.npcId;
        this.callbacks.onTurnEnd?.(participant.npcId, sanitizedResponse);
      }
    } catch (err) {
      this.callbacks.onError?.(err, participant.npcId);
    }
  }
}
