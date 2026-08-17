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
