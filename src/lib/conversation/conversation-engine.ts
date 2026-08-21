// 다자 대화 턴 루프. 어댑터만 알고 게이트웨이·소켓·DB를 모른다.
// MeetingBroker.run()(meeting-broker.js:78-184)의 루프 구조를 어댑터 위로 이식한 것 —
// 게이트웨이 호출을 NpcAdapter.execute() 호출로 바꾸고, 정책 판단은 turn-policy.ts에 위임한다.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { formatPollMessage, formatSpeakMessage, parseHandRaise, sanitizeSpokenResponse, sanitizeStreamingSpokenResponse } = require("../meeting-formatter.js") as typeof import("../meeting-formatter.js");

import type { NpcAdapter } from "@/lib/adapters/types";
import { parseMention } from "./mention";
import { Transcript, USER_SPEAKER_ID, type Turn } from "./transcript";
import { createTurnTimeout, type TurnTimeoutConfig } from "./turn-timeout";
import {
  eligibleParticipants,
  needsPolling,
  selectNextSpeaker,
  type ConversationMode,
  type Participant,
} from "./turn-policy";

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
const DEFAULT_IDLE_MS = 180_000;
/** idle보다 넉넉히 큰 절대 상한. 정상적인 다중 도구 호출 턴을 죽이지 않으면서 폭주를 막는다. */
const DEFAULT_MAX_MS = 600_000;

export type EngineParticipant = Participant & {
  adapter: NpcAdapter;
  sessionKey: string;
  /** 발언 프롬프트의 참석자 목록에 `이름(역할)`로 실린다. 생략하면 "Participant". */
  role?: string | null;
  /** 폴링 프롬프트의 `[발언 지침]` 블록에 실린다(meeting-formatter.js:30-32). 옛 브로커는
   * agent.passPolicy를 그대로 넘겼다(meeting-broker.js:307) — 값이 없으면 블록 자체가 빠진다. */
  passPolicy?: string | null;
};

/** 회의 런타임 컨트롤 서브모드. meeting-broker.js:53 이식 — EngineConfig.mode(peer/meeting/group,
 * 참가자 구조/정책 축)와는 별개 축이다. auto=자동 진행, manual=매 라운드 뒤 대기, directed=폴링 없이
 * directSpeak만 받는다. */
export type RunMode = "auto" | "manual" | "directed";

/** 루프가 왜 끝났는지. onEnd로 함께 통지한다. */
export type EngineEndReason =
  | "max_turns"
  | "consecutive_passes"
  | "consecutive_failures"
  | "no_candidates"
  | "stopped";

/**
 * 연속 실패 한도. 이 횟수만큼 턴이 연속으로 실패하면 루프를 끝낸다.
 *
 * 실패한 턴은 트랜스크립트에 아무것도 남기지 않으므로 maxTotalTurns·remainingTurns·
 * consecutivePasses 중 어느 것도 전진하지 않는다 — 폴링이 없는 peer 모드에서는 브레이크가
 * 하나도 없어 루프가 무한히 돈다(리뷰 실측: maxTotalTurns 3에 50회 이상).
 *
 * 3인 이유: 1이면 일시적인 네트워크 오류 한 번에 회의가 죽고, 크게 잡으면 백엔드가 완전히
 * 내려간 상황에서 사용자가 기다리는 시간만 길어진다. 3연속이면 "일시적"이라고 보기 어렵다.
 * 설정값으로 빼지 않는다 — 이 값을 읽는 설정 경로가 아직 없다.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

export type EngineCallbacks = {
  onPollStart?: () => void;
  onPollResult?: (raises: Array<{ npcId: string; reason: string }>, passes: string[]) => void;
  onTurnStart?: (npcId: string, displayName: string) => void;
  onTurnChunk?: (npcId: string, chunk: string) => void;
  /** meta는 턴이 중단되어 끝났을 때만 실린다 — 그 경우 fullResponse는 그때까지 스트리밍된
   * 부분 텍스트(없을 수도 있다)이며 트랜스크립트에는 기록되지 않는다. 중단이든 아니든 항상
   * 호출되어야 클라이언트의 스트리밍 말풍선이 닫힌다. */
  onTurnEnd?: (npcId: string, fullResponse: string, meta?: { aborted: true; reason: string }) => void;
  onEnd?: (turns: Turn[], reason: EngineEndReason) => void;
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
  /** 연속으로 실패한 턴 수. 성공한 턴 하나로 0으로 돌아간다. */
  private consecutiveFailures = 0;
  private endReason: EngineEndReason | null = null;
  private lastSpeakerId: string | null = null;
  private userMessageQueue: Array<{ userName: string; content: string }> = [];

  // 컨트롤 서페이스 상태 — meeting-broker.js:52-66 이식
  private runMode: RunMode;
  private readonly hybridMode: boolean;
  private readonly hybridAutoResumeMs: number | null;
  private autoResumeTimer: ReturnType<typeof setTimeout> | null = null;
  private commandQueue: Array<
    { type: "setMode"; mode: string } | { type: "directSpeak"; npcId: string; source: "user" | "mention" }
  > = [];
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
    this.commandQueue.push({ type: "directSpeak", npcId, source: "user" });
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

  /**
   * meeting-broker.js:259-279 이식.
   *
   * 큐에 여러 directSpeak가 섞여 있을 수 있다 — 사용자가 UI에서 지목한 것과, NPC가 발언 중
   * 멘션으로 다음 지목을 남긴 것. 사용자 지목은 abortCurrentTurn()으로 진행 중인 턴을 끊으려
   * 시도하지만 adapter.abort는 선택적이고 비동기라 못 먹을 수 있다 — 그러면 원래 턴이 정상
   * 종료하며 멘션을 나중에 push하고, "마지막 것이 이긴다"만으로는 사용자 지목이 무음으로
   * 덮인다. 그래서 한 번의 드레인에서 사용자 지목이 하나라도 있으면 그것을(마지막 것을) 채택하고,
   * 없을 때만 멘션(마지막 것을) 채택한다.
   */
  private drainCommands(): { directNpcId: string | null } {
    let lastUserNpcId: string | null = null;
    let lastMentionNpcId: string | null = null;
    let modeChanged = false;
    while (this.commandQueue.length > 0) {
      const cmd = this.commandQueue.shift()!;
      if (cmd.type === "setMode") {
        this.runMode = cmd.mode as RunMode;
        modeChanged = true;
      } else if (cmd.type === "directSpeak") {
        if (cmd.source === "user") {
          lastUserNpcId = cmd.npcId;
        } else {
          lastMentionNpcId = cmd.npcId;
        }
        this.clearAutoResumeTimer();
      }
    }
    if (modeChanged) this.callbacks.onModeChanged?.(this.runMode, "user");
    return { directNpcId: lastUserNpcId ?? lastMentionNpcId };
  }

  async run(): Promise<void> {
    this.running = true;
    this.endReason = null;
    // 이전 run()이 남긴 실패 카운터를 물려받으면 두 번째 run()은 예산 3이 아니라 1로 시작한다.
    this.consecutiveFailures = 0;

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
          if (this.failureBudgetExhausted()) break;
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
        this.participantsView(),
        (npcId) => this.remainingTurns(npcId),
      );
      if (candidates.length === 0) {
        this.endReason = "no_candidates";
        break;
      }

      let speaker: Participant | null = null;

      if (needsPolling(this.config.mode)) {
        const { raises, passes } = await this.pollCandidates(candidates);
        this.callbacks.onPollResult?.(
          raises.map((r) => ({ npcId: r.npcId, reason: r.reason })),
          passes,
        );

        if (raises.length === 0) {
          this.consecutivePasses++;
          if (this.consecutivePasses >= this.maxConsecutivePasses()) {
            this.endReason = "consecutive_passes";
            break;
          }
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
        if (engineSpeaker) {
          await this.speak(engineSpeaker);
          // 실패한 턴은 트랜스크립트에 아무것도 남기지 않아 다른 어떤 종료 조건도 전진시키지
          // 못한다 — 연속 실패 한도가 유일한 브레이크다(peer/group/meeting 모두 적용).
          if (this.failureBudgetExhausted()) break;
        }
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
    this.callbacks.onEnd?.(this.transcript.all(), this.resolveEndReason());
  }

  /** 연속 실패 한도에 도달했으면 종료 사유를 기록하고 true를 돌려준다. */
  private failureBudgetExhausted(): boolean {
    if (this.consecutiveFailures < MAX_CONSECUTIVE_FAILURES) return false;
    this.endReason = "consecutive_failures";
    return true;
  }

  private resolveEndReason(): EngineEndReason {
    if (this.endReason) return this.endReason;
    if (this.transcript.all().length >= this.config.quota.maxTotalTurns) return "max_turns";
    if (this.consecutivePasses >= this.maxConsecutivePasses()) return "consecutive_passes";
    return "stopped";
  }

  private maxConsecutivePasses(): number {
    return this.config.quota.maxConsecutivePasses ?? 2;
  }

  private findParticipant(npcId: string): EngineParticipant | undefined {
    return this.config.participants.find((p) => p.npcId === npcId);
  }

  /**
   * turn-policy(eligibleParticipants/selectNextSpeaker)에 넘길 참가자 스냅샷을 매 라운드
   * 새로 만든다. Transcript가 lastSpokeAt/turnCount의 유일한 출처다 — EngineParticipant 쪽
   * 필드는 생성 시 값(항상 0)에서 갱신되지 않으므로, 그걸 직접 참조하면 공정성 선택
   * (meeting/group의 "가장 오래 발언하지 않은 참가자")이 사실상 배열의 첫 후보로 고착된다.
   * 매번 파생시키면 갱신을 깜빡할 여지 자체가 없다.
   */
  private participantsView(): Participant[] {
    return this.config.participants.map((p) => ({
      npcId: p.npcId,
      displayName: p.displayName,
      seated: p.seated,
      turnCount: this.transcript.turnCountFor(p.npcId),
      lastSpokeAt: this.transcript.lastSpokeAt(p.npcId),
    }));
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
            engineParticipant.passPolicy ?? null,
          );
          const { response } = await engineParticipant.adapter.execute({
            sessionKey: `${engineParticipant.sessionKey}-poll`,
            prompt: pollMsg,
            // 폴은 히스토리를 싣지 않지만 그래도 다자 대화다 — NPC의 영속 세션에
            // "SPEAK:/PASS" 문답이 쌓이면 안 된다.
            multiParty: true,
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
    // 프롬프트 조립 방식을 그대로 유지하고(옵션 a), conversationHistory는 별도 필드로 추가한다 —
    // 토큰 낭비를 감수하는 대신 회귀 위험을 없앤다. (초기 구현의 주석은 프롬프트가 "바이트 단위로
    // 동일"하다고 단언했지만, 그때 passPolicy와 role이 함께 빠져 있어 사실이 아니었다.)
    const participantsForFormat = this.config.participants.map((p) => ({
      displayName: p.displayName,
      role: p.role || "Participant",
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
    let timedOutKind: string | null = null;
    try {
      const { response } = await new Promise<{ response: string }>((resolve, reject) => {
        const timeout = createTurnTimeout(timeoutConfig, (kind) => {
          timedOutKind = kind;
          participant.adapter.abort?.(participant.sessionKey)?.catch(() => {});
          reject(new Error(`turn timeout (${kind})`));
        });
        participant.adapter
          .execute({
            sessionKey: participant.sessionKey,
            prompt: message,
            // 트랜스크립트는 엔진이 소유한다. 첫 턴은 히스토리가 비지만 그것도 다자 대화의
            // 한 턴이므로 전송 경로가 2번째 턴부터와 달라지면 안 된다.
            multiParty: true,
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
        // 지목을 뽑고, 화면·트랜스크립트에는 제어 라인이 빠진 본문만 남긴다.
        const mention = parseMention(
          sanitizedResponse,
          this.config.participants.map((p) => ({ npcId: p.npcId, displayName: p.displayName })),
          participant.npcId,
        );

        if (mention.text) {
          this.consecutiveFailures = 0;
          this.transcript.add(participant.npcId, participant.displayName, mention.text, this.now());
          this.lastSpeakerId = participant.npcId;
          this.callbacks.onTurnEnd?.(participant.npcId, mention.text);
        } else {
          // "TO: 이름"만 있고 본문이 없는 응답 — parseMention이 지목 줄을 걷어내면 남는 텍스트가
          // 없다. sanitizedResponse 자체는 비어있지 않아 위 gate는 통과하지만, 화면에 보여줄
          // 말도, 트랜스크립트에 남길 발언도 없다. 아래 catch-all과 동일하게 "쓸 만한 텍스트가
          // 하나도 없는 턴"으로 취급해 실패 카운터만 올리고 transcript.add/onTurnEnd는 건너뛴다
          // (빈 턴이 maxTotalTurns를 소비하거나 화면에 빈 말풍선을 남기지 않도록).
          this.consecutiveFailures++;
        }

        // directSpeak() 메서드를 부르지 않는다 — 그쪽은 사용자 지목용이라
        // abortCurrentTurn() 으로 진행 중인 턴을 끊고 hybridMode 를 manual 로 승격시킨다.
        // 멘션은 발언이 끝난 뒤의 힌트일 뿐이므로 큐에만 넣는다. 본문이 비어 실패로 처리되는
        // 경우에도 지목 자체는 유효한 의사표시이므로 큐에는 넣는다(본문은 버리되 지목은 반영).
        if (mention.npcId) {
          this.commandQueue.push({ type: "directSpeak", npcId: mention.npcId, source: "mention" });
        }
      } else {
        // 정상적으로 resolve했지만 쓸 만한 텍스트가 하나도 없는 턴은, 루프 입장에서는 실패한
        // 턴이다 — 트랜스크립트에 아무것도 안 실리므로 maxTotalTurns·remainingTurns·
        // consecutivePasses 중 무엇도 전진하지 않는다. 여기서 카운터를 리셋해버리면 예외를
        // 던지는 어댑터에만 브레이크가 걸리고, 빈 응답을 돌려주는 어댑터는 그대로 무한 루프다
        // (프로덕션은 cooldownMs가 1000이라 바쁜 루프가 아니라 "끝나지 않는 회의"로 나타난다).
        this.consecutiveFailures++;
      }
    } catch (err) {
      this.currentSessionKey = null;
      this.currentAdapter = null;
      this.consecutiveFailures++;
      this.callbacks.onError?.(err, participant.npcId);
      if (timedOutKind) {
        // 타임아웃으로 끊은 턴도 반드시 닫아준다 — onError만 보내면 클라이언트의 스트리밍
        // 말풍선(done:true를 기다린다)이 영영 열린 채로 남는다.
        this.callbacks.onTurnEnd?.(participant.npcId, emittedText, {
          aborted: true,
          reason: `timeout:${timedOutKind}`,
        });
      }
    }
  }
}
