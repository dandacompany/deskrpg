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
import { createTurnTimeout, type TurnTimeoutConfig } from "./turn-timeout";
import {
  eligibleParticipants,
  needsPolling,
  selectNextSpeaker,
  type ConversationMode,
  type Participant,
} from "./turn-policy";

/** 옛 turnTimeoutMs(180초)와 같은 값 — 아무 신호도 없는 에이전트는 예전과 같은 시점에 실패한다. */
const DEFAULT_IDLE_MS = 180_000;
/** idle보다 넉넉히 큰 절대 상한. 정상적인 다중 도구 호출 턴을 죽이지 않으면서 폭주를 막는다. */
const DEFAULT_MAX_MS = 600_000;

export type EngineParticipant = Participant & {
  adapter: NpcAdapter;
  sessionKey: string;
};

/** 회의 런타임 컨트롤 서브모드. meeting-broker.js:53 이식 — EngineConfig.mode(peer/meeting/group,
 * 참가자 구조/정책 축)와는 별개 축이다. auto=자동 진행, manual=매 라운드 뒤 대기, directed=폴링 없이
 * directSpeak만 받는다. */
export type RunMode = "auto" | "manual" | "directed";

export type EngineCallbacks = {
  onPollStart?: () => void;
  onPollResult?: (raises: Array<{ npcId: string; reason: string }>, passes: string[]) => void;
  onTurnStart?: (npcId: string, displayName: string) => void;
  onTurnChunk?: (npcId: string, chunk: string) => void;
  onTurnEnd?: (npcId: string, fullResponse: string) => void;
  onEnd?: (turns: Turn[]) => void;
  onError?: (err: unknown, npcId: string) => void;
  /** RunMode가 바뀔 때. source: 사용자의 setMode 호출로 바뀌면 "user"(드레인 시점에 일괄 통지 —
   * hybridMode 자동 복귀도 setMode를 거치므로 "user"로 통지된다. meeting-broker.js:275-277 그대로
   * 이식한 특이 동작이며 고치지 않는다), directSpeak가 hybridMode에서 auto→manual로 승격시키면
   * 그 자리에서 "system"(meeting-broker.js:239-242). */
  onModeChanged?: (mode: RunMode, source: "user" | "system") => void;
  /** manual/directed 모드가 다음 입력을 기다리기 시작할 때. manual은 실제 폴링 결과가 아니라
   * 항상 고정된 빈 값 { raises: [], passes: [] }을 보낸다(meeting-broker.js:159 그대로 이식 — 실제
   * 폴 결과를 담지 않는 특이 동작). directed 및 direct-speak 이후 대기는 null. */
  onWaitingInput?: (pollResult: { raises: unknown[]; passes: string[] } | null) => void;
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
  /** 초기 RunMode. 기본 "auto" — 생략하면 컨트롤 서페이스 도입 이전과 동일하게 동작한다. */
  initialRunMode?: RunMode;
  /** manual 모드가 유휴 시간 후 auto로 자동 복귀. meeting-broker.js:54-55, 162-167 이식. */
  hybridMode?: boolean;
  hybridAutoResumeMs?: number | null;
  /** 두 겹 턴 타임아웃(§3.5). 생략 시 idleMs 180초(옛 turnTimeoutMs와 동일)/maxMs 600초. */
  turnTimeout?: Partial<TurnTimeoutConfig>;
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

  // 컨트롤 서페이스 상태 — meeting-broker.js:52-66 이식
  private runMode: RunMode;
  private readonly hybridMode: boolean;
  private readonly hybridAutoResumeMs: number | null;
  private autoResumeTimer: ReturnType<typeof setTimeout> | null = null;
  private commandQueue: Array<{ type: "setMode"; mode: string } | { type: "directSpeak"; npcId: string }> = [];
  private waitResolve: (() => void) | null = null;
  /** abortCurrentTurn 대상 — speak() 진행 중에만 채워진다. meeting-broker.js:_currentSessionKey/_currentAgentId. */
  private currentSessionKey: string | null = null;
  private currentAdapter: NpcAdapter | null = null;

  constructor(config: EngineConfig, callbacks: EngineCallbacks) {
    this.config = config;
    this.callbacks = callbacks;
    this.now = config.now ?? Date.now;
    this.runMode = config.initialRunMode ?? "auto";
    this.hybridMode = config.hybridMode ?? false;
    this.hybridAutoResumeMs = config.hybridAutoResumeMs ?? null;
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
    this.clearAutoResumeTimer();
    this.abortCurrentTurn();
    this.releaseWait();
  }

  /**
   * RunMode를 바꾼다. meeting-broker.js:213-225 이식.
   * 보존된 결함: mode가 "auto"/"manual"/"directed" 중 하나가 아니면 아무 일도 하지 않고 조용히
   * 무시한다 — 에러도, 콜백도 없어 호출자는 실패를 알 방법이 없다. 마이그레이션 단계에서는
   * 고치지 않고 그대로 옮긴다(별도 후속 수정 후보).
   */
  setMode(mode: string): void {
    if (mode !== "auto" && mode !== "manual" && mode !== "directed") return;
    this.commandQueue.push({ type: "setMode", mode });
    this.abortCurrentTurn();
    this.clearAutoResumeTimer();
    this.releaseWait();
  }

  /**
   * manual 모드의 대기를 해제해 다음 라운드로 진행시킨다. meeting-broker.js:227-234 이식.
   * commandQueue에 넣는 커맨드는 drainCommands가 소비하지 않는다 — 브로커 원본도 동일하게
   * "nextTurn" 타입을 무시하므로(broker.js:262-274), 실질 효과는 대기 해제뿐이다. 큐에 넣지 않아도
   * 관찰 가능한 동작은 동일하지만, 포트 대상 구조를 그대로 남기기 위해 큐잉은 생략한다.
   */
  nextTurn(): void {
    if (this.runMode !== "manual") return;
    this.releaseWait();
  }

  /**
   * 지정한 NPC에게 발언권을 강제로 준다. meeting-broker.js:236-247 이식.
   * 보존된 결함: npcId가 참가자 목록에 없어도 여기서는 검증하지 않는다. run()이 다음 루프에서
   * 그 npcId로 참가자를 찾다가 실패하면 조용히 아무도 발언하지 않고 대기로 돌아간다
   * (meeting-broker.js의 run()이 agent를 못 찾을 때와 동일한 무음 실패 — 고치지 않는다).
   */
  directSpeak(npcId: string): void {
    this.commandQueue.push({ type: "directSpeak", npcId });
    this.abortCurrentTurn();
    if (this.hybridMode && this.runMode === "auto") {
      this.runMode = "manual";
      this.callbacks.onModeChanged?.("manual", "system");
    }
    this.releaseWait();
  }

  /** 현재 발언 중인 참가자의 어댑터에 abort를 요청한다. meeting-broker.js:249-253 이식. */
  abortCurrentTurn(): void {
    if (this.currentSessionKey && this.currentAdapter) {
      this.currentAdapter.abort?.(this.currentSessionKey)?.catch(() => {});
    }
  }

  /** 대기 프라미스를 먼저 걸어둔 뒤(need) 콜백을 부른다 — 콜백이 동기적으로
   * stop()/nextTurn()/setMode()/directSpeak()를 호출해 대기를 즉시 해제해도 안전하게 걸리도록 하는
   * 순서다(원본은 콜백 호출 뒤에 대기를 걸어, 콜백에서 동기 해제를 시도하면 걸리지 않은 대기를
   * 풀려다 놓치고 다음에 새로 건 대기가 영영 안 풀리는 경합이 있다 — 테스트 결정성을 위해 이 순서만
   * 안전하게 조정했다. 관찰 가능한 타이밍/순서는 바뀌지 않는다).
   */
  private armWait(): Promise<void> {
    return new Promise((resolve) => {
      this.waitResolve = resolve;
    });
  }

  private releaseWait(): void {
    if (this.waitResolve) {
      this.waitResolve();
      this.waitResolve = null;
    }
  }

  private clearAutoResumeTimer(): void {
    if (this.autoResumeTimer) {
      clearTimeout(this.autoResumeTimer);
      this.autoResumeTimer = null;
    }
  }

  /** meeting-broker.js:259-279 이식. */
  private drainCommands(): { directNpcId: string | null } {
    let directNpcId: string | null = null;
    let modeChanged = false;
    while (this.commandQueue.length > 0) {
      const cmd = this.commandQueue.shift()!;
      if (cmd.type === "setMode") {
        this.runMode = cmd.mode as RunMode;
        modeChanged = true;
      } else if (cmd.type === "directSpeak") {
        directNpcId = cmd.npcId;
        this.clearAutoResumeTimer();
      }
    }
    if (modeChanged) this.callbacks.onModeChanged?.(this.runMode, "user");
    return { directNpcId };
  }

  async run(): Promise<void> {
    this.running = true;

    while (this.running && !this.isFinished()) {
      // 1. 커맨드 큐 비우기(setMode/directSpeak) — meeting-broker.js:84 이식
      const { directNpcId } = this.drainCommands();

      // 2. 사용자 메시지 큐 비우기
      while (this.userMessageQueue.length > 0) {
        const { userName, content } = this.userMessageQueue.shift()!;
        this.transcript.add(USER_SPEAKER_ID, userName, content, this.now());
        this.consecutivePasses = 0;
      }

      // 3. 지정 발언(directSpeak) — 어느 runMode에서든 최우선 처리된다. meeting-broker.js:93-111 이식.
      //    보존된 결함: npcId를 참가자 목록에서 못 찾으면 조용히 아무도 발언하지 않는다(위 directSpeak 참고).
      if (directNpcId !== null) {
        const engineSpeaker = this.findParticipant(directNpcId);
        if (engineSpeaker) {
          await this.speak(engineSpeaker);
        }
        if (this.runMode !== "auto") {
          const waiting = this.armWait();
          this.callbacks.onWaitingInput?.(null);
          await waiting;
        } else {
          await sleep(this.config.quota.cooldownMs);
        }
        continue;
      }

      // 4. directed: 폴링 없이 대기만 한다 — 다음 directSpeak은 다음 루프의 3번에서 처리된다.
      //    meeting-broker.js:169-173 이식.
      if (this.runMode === "directed") {
        const waiting = this.armWait();
        this.callbacks.onWaitingInput?.(null);
        await waiting;
        continue;
      }

      // 5. auto/manual 공통 — 후보 산출 → (필요 시) 폴링 → 발언. meeting-broker.js:114-157 이식.
      const candidates = eligibleParticipants(
        this.config.participants,
        (npcId) => this.remainingTurns(npcId),
      );
      if (candidates.length === 0) break;

      let speaker: Participant | null = null;

      if (needsPolling(this.config.mode)) {
        const { raises, passes } = await this.pollCandidates(candidates);
        this.callbacks.onPollResult?.(
          raises.map((r) => ({ npcId: r.npcId, reason: r.reason })),
          passes,
        );

        if (raises.length === 0) {
          this.consecutivePasses++;
          if (this.consecutivePasses >= this.maxConsecutivePasses()) break;
        } else {
          this.consecutivePasses = 0;
          const raisedCandidates = candidates.filter((c) => raises.some((r) => r.npcId === c.npcId));
          speaker = selectNextSpeaker(this.config.mode, raisedCandidates, this.lastSpeakerId);
        }
      } else {
        speaker = selectNextSpeaker(this.config.mode, candidates, this.lastSpeakerId);
      }

      if (speaker) {
        const engineSpeaker = this.findParticipant(speaker.npcId);
        if (engineSpeaker) await this.speak(engineSpeaker);
      }

      // 6. manual은 발언 여부와 무관하게 매 라운드 끝에 항상 대기한다(쿨다운 없음).
      //    auto만 쿨다운 후 계속 돈다. meeting-broker.js:159-167 이식.
      if (this.runMode === "manual") {
        const waiting = this.armWait();
        this.callbacks.onWaitingInput?.({ raises: [], passes: [] });
        await waiting;

        if (this.hybridMode && this.hybridAutoResumeMs && this.runMode === "manual") {
          this.autoResumeTimer = setTimeout(() => {
            this.autoResumeTimer = null;
            this.setMode("auto");
          }, this.hybridAutoResumeMs);
        }
      } else {
        await sleep(this.config.quota.cooldownMs);
      }
    }

    this.running = false;
    this.clearAutoResumeTimer();
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

    // abortCurrentTurn 대상 표시. meeting-broker.js:_speakWithAbort와 동일하게 메시지 조립 전부터
    // 표시해둔다.
    this.currentSessionKey = participant.sessionKey;
    this.currentAdapter = participant.adapter;

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
    // 두 겹 타임아웃(§3.5) — idle은 onDelta/onToolProgress(활동 신호)가 올 때마다 touch()로
    // 리셋되고, max는 아무것도 리셋하지 않는 절대 상한이다. 어느 쪽이 먼저 발화하든 adapter.abort()로
    // 이 턴을 끊고 execute()의 대기를 reject해서 회의 루프가 다음 턴으로 넘어가게 한다 —
    // 회의 전체는 멈추지 않는다(옛 turnTimeoutMs 실패 처리와 동일).
    const timeoutConfig: TurnTimeoutConfig = {
      idleMs: this.config.turnTimeout?.idleMs ?? DEFAULT_IDLE_MS,
      maxMs: this.config.turnTimeout?.maxMs ?? DEFAULT_MAX_MS,
    };
    try {
      const { response } = await new Promise<{ response: string }>((resolve, reject) => {
        const timeout = createTurnTimeout(timeoutConfig, (kind) => {
          participant.adapter.abort?.(participant.sessionKey)?.catch(() => {});
          reject(new Error(`turn timeout (${kind})`));
        });
        participant.adapter
          .execute({
            sessionKey: participant.sessionKey,
            prompt: message,
            conversationHistory: this.transcript.toConversationHistory(historyLimit),
            onDelta: (chunk) => {
              timeout.touch();
              rawText += chunk;
              const sanitizedText = sanitizeStreamingSpokenResponse(rawText);
              const delta = sanitizedText.slice(emittedText.length);
              emittedText = sanitizedText;
              if (delta) this.callbacks.onTurnChunk?.(participant.npcId, delta);
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
      this.currentSessionKey = null;
      this.currentAdapter = null;
      const sanitizedResponse = sanitizeSpokenResponse(response || rawText);
      if (sanitizedResponse) {
        this.transcript.add(participant.npcId, participant.displayName, sanitizedResponse, this.now());
        this.lastSpeakerId = participant.npcId;
        this.callbacks.onTurnEnd?.(participant.npcId, sanitizedResponse);
      }
    } catch (err) {
      this.currentSessionKey = null;
      this.currentAdapter = null;
      this.callbacks.onError?.(err, participant.npcId);
    }
  }
}
