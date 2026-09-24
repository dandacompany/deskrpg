// The budget for a chain of NPCs replying to each other in free chat. Pure — knows nothing about time or sockets.
//
// This class doesn't know "who called". The rule that a human calling doesn't spend the
// budget lives at the call site — if a human calls eight NPCs, all eight must answer,
// and the budget only counts chains between NPCs. Same rule as the meeting room (a
// user-granted turn bypasses quota, a mention-granted turn is respected).

export const DEFAULT_CHAT_BUDGET = 6;

export class ChatQuota {
  private readonly budget: number;
  private left: number;

  constructor(budget: number = DEFAULT_CHAT_BUDGET) {
    this.budget = budget;
    this.left = budget;
  }

  /** A human spoke — the chain can start fresh. */
  resetByHuman(): void {
    this.left = this.budget;
  }

  /** Deducts 1 and returns true if there's some left. Returns false otherwise and never goes negative. */
  spend(): boolean {
    if (this.left <= 0) return false;
    this.left -= 1;
    return true;
  }

  remaining(): number {
    return this.left;
  }
}
