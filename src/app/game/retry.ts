/**
 * Runs `task`, and on failure tries again after each delay in turn. The last failure is thrown.
 * For reads whose silent failure leaves a list stale until the next event — one dropped
 * connection must not keep a clocked-out NPC in the meeting picker.
 */
export async function retryAfter<T>(
  task: () => Promise<T>,
  delaysMs: readonly number[],
): Promise<T> {
  for (const delay of delaysMs) {
    try {
      return await task();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  return task();
}
