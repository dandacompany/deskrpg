// 다자 대화 턴 루프. 어댑터만 알고 게이트웨이·소켓·DB를 모른다.
// MeetingBroker.run()(meeting-broker.js:78-184)의 루프 구조를 어댑터 위로 이식한 것 —
// 게이트웨이 호출을 NpcAdapter.execute() 호출로 바꾸고, 정책 판단은 turn-policy.ts에 위임한다.

import type { NpcAdapter } from "@/lib/adapters/types";
import { Transcript, USER_SPEAKER_ID, type Turn } from "./transcript";
import type { TurnTimeoutConfig } from "./turn-timeout";
import { FloorInbox } from "./inbox";
import { DEFAULT_IDLE_MS, DEFAULT_MAX_MS, NpcRuntime } from "./npc-runtime";
import { MeetingFloorController } from "./floor-controller";
import type { ConversationMode, Participant } from "./turn-policy";

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
  /**
   * 지목받았지만 발언 할당량이 없어 건너뛴 NPC. 조용히 빼지 않고 알린다
   * (meeting-discussion 의 onParticipantsExcluded 와 같은 계열).
   *
   * 트랜스크립트 턴이 아니라 콜백인 이유: 턴으로 넣으면 maxTotalTurns 예산을 갉아먹고,
   * totalTurns 집계를 부풀리고, 프롬프트 히스토리에 실려 NPC 들이 할당량 이야기를
   * 연기하기 시작한다.
   *
   * 완성된 문장이 아니라 (npcId, reason) 을 넘기는 이유: 엔진에는 사용자용 문자열이
   * 하나도 없다. 표시 문구는 i18n 로케일에 있고 클라이언트가 렌더한다.
   */
  onMentionSkipped?: (npcId: string, reason: "quota_exhausted") => void;
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

export class ConversationEngine {
  private readonly config: EngineConfig;
  private readonly callbacks: EngineCallbacks;
  private readonly transcript = new Transcript();
  private readonly now: () => number;

  private running = false;
  private consecutivePasses = 0;
  /**
   * npcId별 NpcRuntime. 프롬프트 조립·타임아웃·스트리밍 정제·멘션 파싱과 함께
   * 연속 실패 카운터(NPC 별로 소유 — 예전에는 엔진 전역이라 NPC 하나의 백엔드가 죽으면
   * 3연속 실패로 회의 전체가 끝났다)도 여기 산다.
   */
  private readonly runtimes: Map<string, NpcRuntime>;
  private endReason: EngineEndReason | null = null;
  private lastSpeakerId: string | null = null;
  private userMessageQueue: Array<{ userName: string; content: string }> = [];

  // 컨트롤 서페이스 상태 — meeting-broker.js:52-66 이식
  private runMode: RunMode;
  private readonly hybridMode: boolean;
  private readonly hybridAutoResumeMs: number | null;
  private autoResumeTimer: ReturnType<typeof setTimeout> | null = null;
  private commandQueue: Array<{ type: "setMode"; mode: string }> = [];
  /** 발언권 부여 대기열. 예전 단일 슬롯을 대체한다 — 지목이 더는 무음으로 사라지지 않는다. */
  private readonly inbox = new FloorInbox();
  /** "다음 발언자가 누구인가" 정책. 스펙 §6의 정책 교체점 — floor-controller.ts 참고. */
  private readonly floor: MeetingFloorController;
  private waitResolve: (() => void) | null = null;
  /** abortCurrentTurn 대상 — speak() 진행 중에만 채워진다. meeting-broker.js:_currentSessionKey/_currentAgentId. */
  private current: NpcRuntime | null = null;

  constructor(config: EngineConfig, callbacks: EngineCallbacks) {
    this.config = config;
    this.callbacks = callbacks;
    this.now = config.now ?? Date.now;
    this.runMode = config.initialRunMode ?? "auto";
    this.hybridMode = config.hybridMode ?? false;
    this.hybridAutoResumeMs = config.hybridAutoResumeMs ?? null;
    this.runtimes = new Map(
      config.participants.map((p) => [
        p.npcId,
        new NpcRuntime(p, {
          transcript: this.transcript,
          topic: config.topic,
          allParticipants: config.participants,
          maxTotalTurns: config.quota.maxTotalTurns,
          historyLimit: config.historyLimit ?? 10,
          turnTimeout: {
            idleMs: config.turnTimeout?.idleMs ?? DEFAULT_IDLE_MS,
            maxMs: config.turnTimeout?.maxMs ?? DEFAULT_MAX_MS,
          },
          now: this.now,
        }),
      ]),
    );
    this.floor = new MeetingFloorController({
      inbox: this.inbox,
      mode: config.mode,
      maxConcurrentPolls: config.maxConcurrentPolls ?? 4,
      onPollStart: () => this.callbacks.onPollStart?.(),
    });
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
   *
   * setMode()처럼 clearAutoResumeTimer()를 호출 즉시 부른다(드레인을 기다리지 않는다).
   * manual 대기가 풀릴 때마다 run()이 무조건 새 자동 복귀 타이머를 재장전하므로(위 run() 5번
   * 참고), 여기서 미리 지우지 않으면 이전 타이머의 핸들을 그 새 타이머가 덮어써 이전 타이머가
   * 필드 참조를 잃은 채 고아로 계속 돌다가, 뒤이어 사용자가 만든 개입과 무관하게 만료되어
   * auto로 튄다(takeGrant()가 발언권을 소비할 때 거는 clearAutoResumeTimer()만으로는 이 경합을
   * 못 막는다 — 그 시점엔 이미 새 타이머로 필드가 덮인 뒤다).
   */
  directSpeak(npcId: string): void {
    this.inbox.push(npcId, "user");
    this.abortCurrentTurn();
    this.clearAutoResumeTimer();
    if (this.hybridMode && this.runMode === "auto") {
      this.runMode = "manual";
      this.callbacks.onModeChanged?.("manual", "system");
    }
    this.releaseWait();
  }

  /** 발언권을 쥔 런타임에 abort 를 요청한다. 회의 정책에서 이 포인터는 항상 0개나 1개다.
   * meeting-broker.js:249-253 이식. */
  abortCurrentTurn(): void {
    this.current?.abort();
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
   * setMode 커맨드만 소비한다. 발언권 부여는 FloorInbox 가 따로 들고 있다.
   *
   * 예전에는 여기서 부여도 함께 드레인하면서 "하나만 살아남는" 슬롯 역할을 했다.
   * 그 구조에서는 지목이 로그도 없이 버려졌다 — 이제 인박스가 순서대로 보관한다.
   */
  private drainCommands(): void {
    let modeChanged = false;
    while (this.commandQueue.length > 0) {
      const cmd = this.commandQueue.shift()!;
      if (cmd.type === "setMode") {
        this.runMode = cmd.mode as RunMode;
        modeChanged = true;
      }
    }
    if (modeChanged) this.callbacks.onModeChanged?.(this.runMode, "user");
  }

  async run(): Promise<void> {
    this.running = true;
    this.endReason = null;
    // 이전 run()이 남긴 실패 카운터를 물려받으면 두 번째 run()은 예산 3이 아니라 1로 시작한다.
    for (const r of this.runtimes.values()) r.noteSuccess();

    while (this.running && !this.isFinished()) {
      // 1. 커맨드 큐 비우기(setMode)
      this.drainCommands();

      // 2. 사용자 메시지 큐 비우기
      while (this.userMessageQueue.length > 0) {
        const { userName, content } = this.userMessageQueue.shift()!;
        this.transcript.add(USER_SPEAKER_ID, userName, content, this.now());
        this.consecutivePasses = 0;
      }

      // 3+5. 다음 발언자 결정 — 지정 발언(어느 runMode 에서든 최우선) 또는 후보 산출 →
      //    (필요 시) 폴링 → 선발. MeetingFloorController.next()에 위임한다(floor-controller.ts).
      //    보존된 결함: npcId 를 참가자 목록에서 못 찾으면 조용히 아무도 발언하지 않는다.
      //
      // directed 이고 인박스가 완전히 비어 있으면 floor.next()를 부르지 않고 곧장 대기를
      // 건다. next()는 async라 그 결과를 await하면 반드시 마이크로태스크 한 틱이 끼는데,
      // 원본 코드(동기 takeGrant())는 그 틱 없이 같은 이벤트 루프 턴 안에서 armWait()까지
      // 도달했다 — directSpeak()가 run()과 같은 동기 구간에서 호출되는 테스트가 이 틱에
      // 의존한다(그 틱이 생기면 push 가 armWait() 이전에 일어나 releaseWait()가 무효화된다).
      // 인박스가 비어 있지 않을 때는 이 최적화가 필요 없다 — 부여가 이미 쌓여 있으므로
      // 이번 틱이든 다음 틱이든 next()가 그것을 집어간다.
      if (this.runMode === "directed" && this.inbox.pendingCount() === 0) {
        const waiting = this.armWait();
        this.callbacks.onWaitingInput?.(null);
        await waiting;
        continue;
      }

      const decision = await this.floor.next({
        participants: this.participantsView(),
        runtimeFor: (npcId) => this.runtimes.get(npcId),
        remainingTurns: (npcId) => this.remainingTurns(npcId),
        lastSpeakerId: this.lastSpeakerId,
        // directed 는 폴링 없이 지정 발언만 받는다. 부여를 먼저 보는 구조이므로 이 플래그가
        // 없으면 부여가 없을 때 없던 LLM 폴링 호출이 매 라운드 생긴다.
        pollingAllowed: this.runMode !== "directed",
        onSkippedGrant: (npcId) => this.callbacks.onMentionSkipped?.(npcId, "quota_exhausted"),
      });

      if (decision.kind === "grant") {
        this.clearAutoResumeTimer();
        const runtime = this.runtimes.get(decision.npcId);
        if (runtime) {
          await this.speak(runtime);
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

      if (decision.kind === "no-candidates") {
        // 왜 아무도 없는가를 구분한다. 전원이 실패 예산을 소진한 것과, 다들 할당량을
        // 다 쓴 것은 운영상 전혀 다른 상황이다 — 전자는 백엔드가 죽었다는 뜻이다.
        const seated = this.config.participants.filter((p) => p.seated);
        const allBurnedOut = seated.length > 0 && seated.every((p) => this.runtimes.get(p.npcId)?.isBurnedOut() ?? false);
        this.endReason = allBurnedOut ? "consecutive_failures" : "no_candidates";
        break;
      }

      // pollResult !== null 일 때만, 그리고 그때는 내용과 무관하게 통지한다 — 폴링 참가자
      // 전원의 어댑터가 실패하면 raises/passes 가 둘 다 빈 배열이 되지만, 그래도 폴링은
      // 일어났다는 사실 자체를 클라이언트가 알아야 한다. all-passed/speaker 두 갈래가
      // 같은 필드(decision.pollResult)를 쓰므로 kind 와 무관하게 갈래 앞으로 뺀다 — 한쪽만
      // 고치다 다른 쪽에 남는 사고를 구조적으로 없앤다.
      if (decision.pollResult) {
        this.callbacks.onPollResult?.(decision.pollResult.raises, decision.pollResult.passes);
      }

      if (decision.kind === "all-passed") {
        this.consecutivePasses++;
        if (this.consecutivePasses >= this.maxConsecutivePasses()) {
          this.endReason = "consecutive_passes";
          break;
        }
      } else {
        this.consecutivePasses = 0;
        const runtime = this.runtimes.get(decision.npcId);
        if (runtime) {
          await this.speak(runtime);
          // 실패한 턴은 트랜스크립트에 아무것도 남기지 않아 다른 어떤 종료 조건도 전진시키지
          // 못한다 — 소진된 NPC 는 다음 루프의 후보 필터에서 빠진다(peer/group/meeting 모두 적용).
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

  private resolveEndReason(): EngineEndReason {
    if (this.endReason) return this.endReason;
    if (this.transcript.all().length >= this.config.quota.maxTotalTurns) return "max_turns";
    if (this.consecutivePasses >= this.maxConsecutivePasses()) return "consecutive_passes";
    return "stopped";
  }

  private maxConsecutivePasses(): number {
    return this.config.quota.maxConsecutivePasses ?? 2;
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

  /** 발언권을 부여하고 스트리밍 응답을 받아 트랜스크립트에 기록한다. */
  private async speak(runtime: NpcRuntime): Promise<void> {
    this.callbacks.onTurnStart?.(runtime.npcId, runtime.displayName);
    this.current = runtime;

    // takeTurn 은 throw 하지 않는다 — 모든 실패를 SpeakOutcome 으로 돌려준다.
    // 그래야 콜백 호출 조건이 한곳(여기)에 모인다.
    const outcome = await runtime.takeTurn(this.remainingTurns(runtime.npcId), {
      onChunk: (chunk) => this.callbacks.onTurnChunk?.(runtime.npcId, chunk),
    });
    this.current = null;

    if (outcome.kind === "spoke") {
      runtime.noteSuccess();
      this.transcript.add(runtime.npcId, runtime.displayName, outcome.text, this.now());
      this.lastSpeakerId = runtime.npcId;
      this.callbacks.onTurnEnd?.(runtime.npcId, outcome.text);
      // directSpeak() 메서드를 부르지 않는다 — 그쪽은 사용자 지목용이라
      // abortCurrentTurn() 으로 진행 중인 턴을 끊고 hybridMode 를 manual 로 승격시킨다.
      // 멘션은 발언이 끝난 뒤의 힌트일 뿐이므로 인박스에만 넣는다.
      if (outcome.mentionNpcId) this.inbox.push(outcome.mentionNpcId, "mention");
      return;
    }

    runtime.noteFailure();

    if (outcome.kind === "empty") {
      // "TO: 이름"만 있고 본문이 없는 응답이거나, 쓸 만한 텍스트가 하나도 없는 턴이다.
      // onTurnEnd 를 부르지 않는다 — 현행 동작 그대로다. 본문이 비어 실패로 처리되는
      // 경우에도 지목 자체는 유효한 의사표시이므로 인박스에는 넣는다.
      if (outcome.mentionNpcId) this.inbox.push(outcome.mentionNpcId, "mention");
      return;
    }

    this.callbacks.onError?.(outcome.error, runtime.npcId);
    if (outcome.timedOut) {
      // 타임아웃으로 끊은 턴만 닫아준다 — onError 만 보내면 클라이언트의 스트리밍
      // 말풍선(done:true 를 기다린다)이 영영 열린 채로 남는다.
      this.callbacks.onTurnEnd?.(runtime.npcId, outcome.timedOut.partialText, {
        aborted: true,
        reason: `timeout:${outcome.timedOut.kind}`,
      });
    }
  }
}
