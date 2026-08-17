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

  // meeting / group — 가장 오래 발언하지 않은 참가자 (공정성, D9)
  return candidates.reduce((oldest, c) => (c.lastSpokeAt < oldest.lastSpokeAt ? c : oldest));
}
