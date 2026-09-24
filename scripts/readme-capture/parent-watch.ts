/**
 * Keep the capture server from outliving the process that started it.
 *
 * The capture server starts `detached` so it can be cleaned up as a process group. So when the parent dies
 * by SIGKILL or Ctrl-C and `finally`/`t.after` cannot run, the server stays — every time the test runner was interrupted
 * `server-launcher.ts` orphans piled up (2026-09-21 measurement: 7 in one checkout, the oldest 1 day 5 hours).
 * Parent-side cleanup only runs while the parent is alive. The reliable side is the child watching the parent.
 */
export const PARENT_WATCH_INTERVAL_MS = 1_000;

/** `kill(pid, 0)` sends no signal and only checks existence. Only ESRCH means "gone"; EPERM means alive. */
export function processAlive(pid: number, kill: typeof process.kill = process.kill): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Call `onGone` once when the parent disappears. The returned function stops watching. */
export function watchParent(
  parentPid: number,
  onGone: () => void,
  options: { intervalMs?: number; isAlive?: (pid: number) => boolean } = {},
): () => void {
  const isAlive = options.isAlive ?? ((pid: number) => processAlive(pid));
  const timer = setInterval(() => {
    if (isAlive(parentPid)) return;
    clearInterval(timer);
    onGone();
  }, options.intervalMs ?? PARENT_WATCH_INTERVAL_MS);
  // Watching must never keep the server from ending on its own.
  timer.unref();
  return () => clearInterval(timer);
}
