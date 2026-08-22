// 맵 채팅에서 지명받은 NPC 들이 동시에 대답한다. 루프가 없다 — 사람의 말이 올 때만 깨어난다.
//
// 회의(ChannelRuntime)와 갈라 둔 이유: 회의는 매 라운드 "다음은 누구"를 정하는 박자로 돌지만
// 자유채팅에는 그 박자가 없다. 라운드 루프를 이벤트 구동에 맞추려면 빈 박자를 계속 돌게
// 해야 한다. 공유하는 것은 NpcRuntime.speakWithPrompt — 대본을 들고 가서 말을 시키고
// 답을 받아오는 기계다.

import { NpcRuntime } from "./npc-runtime";
import { Transcript } from "./transcript";
import { parseAllMentions } from "./mention";
import { ChatQuota, DEFAULT_CHAT_BUDGET } from "./chat-quota";
import { formatOpenChatMessage, type ChatLine } from "@/lib/open-chat-formatter";
import type { EngineParticipant } from "./types";

/** speakWithPrompt 는 이 둘을 읽지 않는다. 읽히면 테스트에서 드러나도록 눈에 띄는 값을 넣는다. */
const UNUSED_TOPIC = "__open_chat_topic_should_never_be_read__";
const UNUSED_MAX_TURNS = -1;

export type OpenChatCallbacks = {
  onTurnStart?: (npcId: string, displayName: string) => void;
  onTurnChunk?: (npcId: string, chunk: string) => void;
  onTurnEnd?: (npcId: string, fullResponse: string, meta?: { aborted: true; reason: string }) => void;
  /** 지명받았으나 게이트웨이가 죽어 건너뛴 NPC. 회의의 같은 이름 콜백과 짝이다. */
  onMentionSkipped?: (npcId: string, reason: "backend_failing") => void;
  onError?: (err: unknown, npcId: string) => void;
};

export type OpenChatDeps = {
  participants: EngineParticipant[];
  /** 프롬프트에 실을 최근 대화. 소켓 계층의 채널 히스토리를 그대로 넘긴다. */
  recent: () => ChatLine[];
  turnTimeout: { idleMs: number; maxMs: number };
  historyLimit?: number;
  budget?: number;
  now?: () => number;
};

export class OpenChatRuntime {
  private readonly deps: OpenChatDeps;
  private readonly callbacks: OpenChatCallbacks;
  private readonly runtimes = new Map<string, NpcRuntime>();
  private readonly quota: ChatQuota;
  /** 지금 말하는 중인 NPC. 한 NPC 는 한 번에 한 마디 — 사슬의 두 번째 브레이크다. */
  private readonly speaking = new Set<string>();

  constructor(deps: OpenChatDeps, callbacks: OpenChatCallbacks) {
    this.deps = deps;
    this.callbacks = callbacks;
    this.quota = new ChatQuota(deps.budget ?? DEFAULT_CHAT_BUDGET);

    const transcript = new Transcript();
    const now = deps.now ?? (() => Date.now());
    for (const participant of deps.participants) {
      this.runtimes.set(
        participant.npcId,
        new NpcRuntime(participant, {
          transcript,
          topic: UNUSED_TOPIC,
          allParticipants: deps.participants,
          maxTotalTurns: UNUSED_MAX_TURNS,
          historyLimit: deps.historyLimit ?? 10,
          turnTimeout: deps.turnTimeout,
          now,
        }),
      );
    }
  }

  isSpeaking(npcId: string): boolean {
    return this.speaking.has(npcId);
  }

  /** 사람이 말했다. 예산을 채우고, 지명된 NPC 들을 동시에 깨운다. */
  async handleHumanMessage(senderName: string, text: string): Promise<void> {
    this.quota.resetByHuman();
    const targets = parseAllMentions(text, this.participantsView(), null);
    await this.dispatch(targets, senderName, /* fromHuman */ true);
  }

  private participantsView(): Array<{ npcId: string; displayName: string }> {
    return this.deps.participants.map((p) => ({ npcId: p.npcId, displayName: p.displayName }));
  }

  /**
   * 지명된 NPC 들을 **동시에** 깨운다. 순서대로 돌지 않는 것이 회의와의 핵심 차이다.
   *
   * fromHuman 이면 예산을 쓰지 않는다 — 사람이 여덟 명을 부르면 여덟이 다 대답해야 한다.
   * 회의방의 규칙과 같다(user 부여는 쿼터 우회, mention 부여는 존중).
   */
  private async dispatch(targets: string[], calledBy: string, fromHuman: boolean): Promise<void> {
    const admitted: string[] = [];
    for (const npcId of targets) {
      if (this.speaking.has(npcId)) continue;
      const runtime = this.runtimes.get(npcId);
      if (!runtime) continue;
      if (runtime.isBurnedOut()) {
        this.callbacks.onMentionSkipped?.(npcId, "backend_failing");
        continue;
      }
      if (!fromHuman && !this.quota.spend()) break;
      admitted.push(npcId);
    }
    if (admitted.length === 0) return;

    await Promise.all(admitted.map((npcId) => this.speakOne(npcId, calledBy)));
  }

  private async speakOne(npcId: string, calledBy: string): Promise<void> {
    const runtime = this.runtimes.get(npcId);
    if (!runtime) return;

    this.speaking.add(npcId);
    this.callbacks.onTurnStart?.(npcId, runtime.displayName);

    const others = this.deps.participants
      .filter((p) => p.npcId !== npcId)
      .map((p) => ({ displayName: p.displayName, role: p.role || "동료" }));
    const prompt = formatOpenChatMessage(
      { displayName: runtime.displayName },
      others,
      this.deps.recent(),
      calledBy,
    );

    const outcome = await runtime.speakWithPrompt(prompt, {
      onChunk: (chunk) => this.callbacks.onTurnChunk?.(npcId, chunk),
    });
    this.speaking.delete(npcId);

    if (outcome.kind === "spoke") {
      this.callbacks.onTurnEnd?.(npcId, outcome.text);
      const next = parseAllMentions(outcome.text, this.participantsView(), npcId);
      if (next.length > 0) await this.dispatch(next, runtime.displayName, /* fromHuman */ false);
      return;
    }

    if (outcome.kind === "empty") {
      this.callbacks.onTurnEnd?.(npcId, outcome.partialText, {
        aborted: true,
        reason: outcome.mentionNpcId ? "empty_after_mention" : "empty_response",
      });
      return;
    }

    this.callbacks.onError?.(outcome.error, npcId);
    this.callbacks.onTurnEnd?.(npcId, outcome.partialText, {
      aborted: true,
      reason: outcome.timedOut ? `timeout:${outcome.timedOut.kind}` : "adapter_error",
    });
  }
}
