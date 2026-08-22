// 자유채팅에서 NPC 끼리 주고받는 사슬의 예산. 순수 — 시간도 소켓도 모른다.
//
// 이 클래스는 "누가 불렀는지" 모른다. 사람이 부른 것은 예산을 쓰지 않는다는 규칙은
// 호출부에 있다 — 사람이 여덟 명을 부르면 여덟이 다 대답해야 하고, 예산은 NPC 끼리의
// 사슬만 센다. 회의방의 규칙과 같다(user 부여는 쿼터 우회, mention 부여는 존중).

export const DEFAULT_CHAT_BUDGET = 6;

export class ChatQuota {
  private readonly budget: number;
  private left: number;

  constructor(budget: number = DEFAULT_CHAT_BUDGET) {
    this.budget = budget;
    this.left = budget;
  }

  /** 사람이 말했다 — 사슬을 새로 시작할 수 있다. */
  resetByHuman(): void {
    this.left = this.budget;
  }

  /** 남아 있으면 1 차감하고 true. 없으면 false 이고 음수로 내려가지 않는다. */
  spend(): boolean {
    if (this.left <= 0) return false;
    this.left -= 1;
    return true;
  }

  remaining(): number {
    return this.left;
  }
}
