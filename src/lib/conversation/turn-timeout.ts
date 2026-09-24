// Two nested deadlines per turn.
//   idle — resets whenever a liveness signal arrives (tool.progress, assistant.delta).
//          Catches "did it stop?".
//   max  — an absolute cap regardless of activity. Catches "did it run away?".
// A single timer can't distinguish the two: set it generously and a stalled agent waits
// forever; set it tight and it kills normal work that legitimately takes long.

export type TurnTimeoutConfig = { idleMs: number; maxMs: number };

export function createTurnTimeout(
  config: TurnTimeoutConfig,
  onTimeout: (kind: "idle" | "max") => void,
): { touch(): void; clear(): void } {
  let done = false;
  let idleTimer: ReturnType<typeof setTimeout>;

  const fire = (kind: "idle" | "max") => {
    if (done) return;
    done = true;
    clearTimeout(idleTimer);
    clearTimeout(maxTimer);
    onTimeout(kind);
  };

  const maxTimer = setTimeout(() => fire("max"), config.maxMs);
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => fire("idle"), config.idleMs);
  };
  armIdle();

  return {
    touch() {
      if (!done) armIdle();
    },
    clear() {
      done = true;
      clearTimeout(idleTimer);
      clearTimeout(maxTimer);
    },
  };
}
