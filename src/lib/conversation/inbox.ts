// 발언권 부여 큐. 순수 — 어댑터도 트랜스크립트도 시간도 모른다.
//
// 이 클래스가 대체하는 것: 예전 엔진은 커맨드 큐를 드레인할 때 지목 하나만 살리고
// 나머지를 로그도 없이 버렸다(conversation-engine.ts drainCommands). 호명된 NPC 는
// 자기가 불렸다는 사실 자체를 몰랐고, 사용자에게는 "단비를 불렀는데 하늘이 말한다"로
// 보였다. 여기서는 대기열에 남겨 순서대로 내보낸다.

export type GrantSource = "user" | "mention";

export class FloorInbox {
  /** FIFO. NPC 당 최대 하나 — 중복 지목은 접힌다. */
  private mentions: string[] = [];
  /** 사용자 지목은 하나만 유지한다(마지막이 이긴다). */
  private user: string | null = null;

  push(npcId: string, source: GrantSource): void {
    if (source === "user") {
      // 사람의 연속 클릭은 "둘 다 시켜라"가 아니라 "아니 이쪽"이다.
      this.user = npcId;
      // 같은 NPC 가 사용자 지목으로 한 번, 대기 중이던 멘션으로 또 한 번 말하지 않도록
      // 흡수한다.
      this.mentions = this.mentions.filter((id) => id !== npcId);
      return;
    }
    // 이미 대기 중이면 접는다 — 먼저 온 순서를 지킨다. 트랜스크립트가 공유라
    // 그 NPC 의 턴 프롬프트에는 두 지목이 모두 최근 발언으로 실린다.
    if (this.mentions.includes(npcId)) return;
    this.mentions.push(npcId);
  }

  /**
   * 다음 발언자를 꺼낸다. 없으면 null.
   *
   * 사용자 지목이 있으면 그것이 먼저이고 `isEligible` 검사를 받지 않는다 — 사람이
   * 명시적으로 지시한 것이므로 할당량을 우회한다.
   *
   * 멘션은 FIFO 로 꺼내되 자격 없는 것은 건너뛰고 `onSkipped` 로 알린다. 무음으로
   * 버리지 않는 것이 이 클래스의 존재 이유다.
   */
  take(isEligible: (npcId: string) => boolean, onSkipped: (npcId: string) => void): string | null {
    if (this.user !== null) {
      const npcId = this.user;
      this.user = null;
      return npcId;
    }
    while (this.mentions.length > 0) {
      const npcId = this.mentions.shift()!;
      if (isEligible(npcId)) return npcId;
      onSkipped(npcId);
    }
    return null;
  }

  pendingCount(): number {
    return this.mentions.length + (this.user === null ? 0 : 1);
  }

  clear(): void {
    this.mentions = [];
    this.user = null;
  }
}
