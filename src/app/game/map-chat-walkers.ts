/**
 * 맵 채팅으로 불려 걸어오는 중인 NPC 들.
 *
 * 왜 필요한가: 지목받은 NPC 는 사람 곁으로 걸어오고, 도착하면 기본 동작이 1:1 대화창을
 * 여는 것이다. 그런데 맵 채팅으로 부른 NPC 는 **맵 채팅에서** 대답하므로, 그 대화창이
 * 정작 대답이 나오는 패널을 덮어 버린다. 그래서 "이 걷기가 맵 채팅에서 시작됐나"를
 * 도착 시점까지 들고 있어야 한다.
 *
 * 사유는 호출 시점에만 알 수 있고 판단은 도착 시점에 필요하다 — 그 간극이 이 클래스다.
 */
export class MapChatWalkers {
  private readonly waiting = new Set<string>();

  /**
   * NPC 호출을 기록한다. `reason` 이 없는 호출(컨텍스트 메뉴)은 이전 맵 채팅 대기를
   * **무효화한다** — 지우지 않으면 그 NPC 가 도착했을 때 사용자가 방금 명시적으로
   * 요청한 1:1 대화창이 삼켜진다. 게임 장면은 이미 걷고 있는 NPC 의 재호출을 조용히
   * 무시하므로, 도착은 원래 걷기로 일어나고 항목은 그때까지 살아 있다.
   */
  noteCall(npcId: string, reason?: string): void {
    if (reason === "map-chat") this.waiting.add(npcId);
    else this.waiting.delete(npcId);
  }

  /**
   * 도착 처리에서 한 번만 소비한다. `true` 면 이 걷기는 맵 채팅이 시작한 것이므로
   * 1:1 대화창을 열지 않는다. 소비이므로 같은 NPC 의 다음 도착은 `false` 다.
   */
  takeOnArrival(npcId: string): boolean {
    return this.waiting.delete(npcId);
  }

  /** 걷기가 도착 없이 끝났을 때(자리로 복귀 등) 대기를 버린다. */
  forget(npcId: string): void {
    this.waiting.delete(npcId);
  }
}
