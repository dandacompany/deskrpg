// "다음 발언자가 누구인가"만 아는 정책 조각. conversation-engine.ts의 takeGrant()/pollCandidates()/
// run() 5번 블록(후보 산출·폴링·selectNextSpeaker)에서 그대로 옮겼다(순수 이동, 동작 변경 없음).
//
// 이름에 Meeting을 붙인 이유: 스펙 §6의 "3번 — 정책 교체점"이다. 지금은 이것이 유일한 발언권
// 정책이지만, 2단계(자유채팅 동시 발언)는 이 옆에 OpenFloorController를 두고 생성자에서
// 고르게 된다.
//
// 메서드 이름이 next()인 이유: select()/decide()는 부작용이 없다고 읽히는데, 이 메서드는
// 후보가 필요하면 실제로 폴링 LLM 호출을 한다.

import type { FloorInbox } from "./inbox";
import type { NpcRuntime } from "./npc-runtime";
import {
  eligibleParticipants,
  needsPolling,
  selectNextSpeaker,
  type ConversationMode,
  type Participant,
} from "./turn-policy";

/** 폴링이 실제로 일어났으면 그 결과, 아니면 null. null과 빈 결과는 다르다 — 폴링 참가자
 * 전원의 어댑터가 실패하면 raises/passes 가 둘 다 빈 배열이 되지만, 그래도 폴링은 일어난
 * 것이므로 pollResult는 null이 아니다. */
export type PollReport = {
  raises: Array<{ npcId: string; reason: string }>;
  passes: string[];
} | null;

export type FloorDecision =
  | { kind: "grant"; npcId: string }
  | { kind: "speaker"; npcId: string; pollResult: PollReport }
  | { kind: "all-passed"; pollResult: PollReport }
  | { kind: "no-candidates" };

/** 멘션 부여를 건너뛴 이유. 유니온으로 둔 이유: 나중에 사유가 늘 때 이 자리만 넓어진다
 * (스펙 §5.3). `isBurnedOut()` 이 참이면 게이트웨이가 죽은 것("backend_failing")이고,
 * 그렇지 않은데 자격이 없으면 발언 할당량 소진("quota_exhausted")이다. 둘 다 참이면
 * backend_failing 을 우선한다 — 운영자에게 더 시급한 사실이다. */
export type MentionSkipReason = "quota_exhausted" | "backend_failing";

/** 청크 단위로 나눠 순차 실행한다. Hermes의 max_concurrent_runs를 넘는 폴링이
 * 한꺼번에 발사되어 429로 조용히 유실되는 것을 막는다(스펙 §3.5). */
function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export class MeetingFloorController {
  private readonly inbox: FloorInbox;
  private readonly mode: ConversationMode;
  private readonly maxConcurrentPolls: number;
  private readonly onPollStart: () => void;

  constructor(deps: {
    inbox: FloorInbox;
    mode: ConversationMode;
    maxConcurrentPolls: number;
    onPollStart: () => void;
  }) {
    this.inbox = deps.inbox;
    this.mode = deps.mode;
    this.maxConcurrentPolls = deps.maxConcurrentPolls;
    this.onPollStart = deps.onPollStart;
  }

  /**
   * 다음 발언자를 인박스에서 꺼낸다.
   *
   * 멘션 부여만 자격 검사를 받는다 — 큐가 생긴 뒤로 지목 사슬이 한 NPC 를 할당량
   * 너머로 반복 호출할 수 있게 됐기 때문이다. 사용자 부여는 인박스가 검사 없이
   * 돌려주므로 여기 게이트가 걸리지 않는다.
   */
  private takeGrant(ctx: {
    runtimeFor: (npcId: string) => NpcRuntime | undefined;
    remainingTurns: (npcId: string) => number;
    onSkippedGrant: (npcId: string, reason: MentionSkipReason) => void;
  }): string | null {
    return this.inbox.take(
      (npcId) => !(ctx.runtimeFor(npcId)?.isBurnedOut() ?? false) && ctx.remainingTurns(npcId) > 0,
      (npcId) => {
        // isBurnedOut() 이 참이면 게이트웨이가 죽은 것이지 할당량 문제가 아니다 — 두 조건이
        // 둘 다 걸려 있어도 이쪽이 더 시급한 사실이므로 우선한다.
        const reason: MentionSkipReason = ctx.runtimeFor(npcId)?.isBurnedOut()
          ? "backend_failing"
          : "quota_exhausted";
        ctx.onSkippedGrant(npcId, reason);
      },
    );
  }

  async next(ctx: {
    participants: Participant[];
    runtimeFor: (npcId: string) => NpcRuntime | undefined;
    remainingTurns: (npcId: string) => number;
    lastSpeakerId: string | null;
    /** false 면 부여가 없을 때 폴링하지 않고 all-passed 를 돌려준다 — directed 모드 보존용. */
    pollingAllowed: boolean;
    onSkippedGrant: (npcId: string, reason: MentionSkipReason) => void;
  }): Promise<FloorDecision> {
    const grantedNpcId = this.takeGrant(ctx);
    if (grantedNpcId !== null) {
      return { kind: "grant", npcId: grantedNpcId };
    }

    if (!ctx.pollingAllowed) {
      return { kind: "all-passed", pollResult: null };
    }

    const candidates = eligibleParticipants(ctx.participants, (npcId) =>
      ctx.runtimeFor(npcId)?.isBurnedOut() ? 0 : ctx.remainingTurns(npcId),
    );
    if (candidates.length === 0) {
      return { kind: "no-candidates" };
    }

    if (!needsPolling(this.mode)) {
      const speaker = selectNextSpeaker(this.mode, candidates, ctx.lastSpeakerId);
      if (!speaker) return { kind: "no-candidates" };
      return { kind: "speaker", npcId: speaker.npcId, pollResult: null };
    }

    const { raises, passes } = await this.pollCandidates(
      candidates,
      ctx.runtimeFor,
      ctx.remainingTurns,
    );
    const pollResult: PollReport = {
      raises: raises.map((r) => ({ npcId: r.npcId, reason: r.reason })),
      passes,
    };

    if (raises.length === 0) {
      return { kind: "all-passed", pollResult };
    }

    const raisedCandidates = candidates.filter((c) => raises.some((r) => r.npcId === c.npcId));
    const speaker = selectNextSpeaker(this.mode, raisedCandidates, ctx.lastSpeakerId);
    if (!speaker) return { kind: "all-passed", pollResult };
    return { kind: "speaker", npcId: speaker.npcId, pollResult };
  }

  /**
   * 후보를 maxConcurrentPolls 크기로 나눠 청크마다 병렬 폴링한다(청크 사이는 순차).
   * 실패한 참가자는 raises/passes 어느 쪽에도 넣지 않는다 — 회의를 중단시키지 않되
   * 그 라운드에서는 사실상 PASS로 취급된다(현행 meeting-broker.js:322-325 동작 보존, 결함 보존).
   */
  private async pollCandidates(
    candidates: Participant[],
    runtimeFor: (npcId: string) => NpcRuntime | undefined,
    remainingTurns: (npcId: string) => number,
  ): Promise<{ raises: Array<{ npcId: string; reason: string }>; passes: string[] }> {
    this.onPollStart();

    const raises: Array<{ npcId: string; reason: string }> = [];
    const passes: string[] = [];

    for (const group of chunk(candidates, this.maxConcurrentPolls)) {
      const results = await Promise.allSettled(
        group.map(async (c) => {
          const runtime = runtimeFor(c.npcId)!;
          const remaining = remainingTurns(c.npcId);
          const parsed = await runtime.poll(remaining);
          return { npcId: c.npcId, parsed };
        }),
      );

      for (const result of results) {
        if (result.status === "rejected") {
          // 실패한 참가자는 조용히 건너뛴다 — 회의를 중단하지 않는다(보존된 결함 3).
          continue;
        }
        const { npcId, parsed } = result.value;
        if (parsed.wantsToSpeak) {
          raises.push({ npcId, reason: parsed.reason });
        } else {
          passes.push(npcId);
        }
      }
    }

    return { raises, passes };
  }
}
