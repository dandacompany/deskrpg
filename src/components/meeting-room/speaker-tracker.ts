import type { MeetingSpeaker } from "@/game/three/meeting-camera";

type Schedule = (callback: () => void, delay: number) => () => void;
const scheduleTimeout: Schedule = (callback, delay) => {
  const timer = setTimeout(callback, delay);
  return () => clearTimeout(timer);
};

/** Creates a camera utterance only when actual output starts, and ignores chunks of the same utterance. */
export class MeetingSpeakerTracker {
  private serial = 0;
  private currentNpc: string | null = null;
  private focusGeneration = 0;
  private cancelFocusTimer: (() => void) | undefined;
  constructor(
    private emit: (speaker: MeetingSpeaker | null) => void,
    private schedule: Schedule = scheduleTimeout,
  ) {}
  private clearUserFocusTimer() {
    this.focusGeneration++;
    this.cancelFocusTimer?.();
    this.cancelFocusTimer = undefined;
  }
  turn(_npcId: string) {
    this.clearUserFocusTimer();
    this.currentNpc = null;
    this.emit(null);
  }
  stream(npcId: string, visibleText: string) {
    if (!visibleText.trim() || this.currentNpc === npcId) return;
    this.clearUserFocusTimer();
    this.currentNpc = npcId;
    this.emit({ kind: "npc", id: npcId, utteranceId: `npc:${npcId}:${++this.serial}` });
  }
  finish(npcId?: string) {
    if (npcId && npcId !== this.currentNpc) return;
    this.clearUserFocusTimer();
    this.currentNpc = null;
    this.emit(null);
  }
  user(socketId: string, utteranceId: string, roster: Array<{ id: string; userId?: string }>) {
    this.clearUserFocusTimer();
    this.currentNpc = null;
    const id = roster.find((participant) => participant.id === socketId)?.userId;
    this.emit(id ? { kind: "user", id, utteranceId } : null);
    if (id) {
      const generation = this.focusGeneration;
      this.cancelFocusTimer = this.schedule(() => {
        // Even a prior utterance's timer that entered the execution queue right before cancellation
        // must not clear the next utterance.
        if (generation !== this.focusGeneration) return;
        this.finish();
      }, 4000);
    }
  }
  dispose() {
    this.finish();
  }
}
