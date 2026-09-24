/** Delayed calls bound to the tick clock (rAF time). They stop when the loop stops — same as the old scene timers. */
export class Scheduler {
  private entries: { at: number; run: () => void }[] = [];

  delay(now: number, ms: number, run: () => void): void {
    this.entries.push({ at: now + ms, run });
  }

  tick(now: number): void {
    if (!this.entries.length) return;
    const due = this.entries.filter((entry) => entry.at <= now);
    if (!due.length) return;
    this.entries = this.entries.filter((entry) => entry.at > now);
    for (const entry of due) entry.run();
  }

  clear(): void {
    this.entries = [];
  }
}
