// 한 턴에 두 겹의 시한을 건다.
//   idle — 에이전트가 살아 있다는 신호(tool.progress, assistant.delta)가 오면 리셋.
//          "멈췄나"를 잡는다.
//   max  — 활동과 무관한 절대 상한. "폭주하나"를 잡는다.
// 하나의 타이머로는 이 둘을 구분할 수 없다: 넉넉히 잡으면 멈춘 에이전트를 오래 기다리고,
// 짧게 잡으면 오래 걸리는 정상 작업을 죽인다.

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
