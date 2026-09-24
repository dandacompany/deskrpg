/**
 * Rules for responding when the gateway says "can't take it right now".
 *
 * Hermes does not silently drop requests over the concurrent-run cap (`gateway.api_server.max_concurrent_runs`)
 * — it rejects them with `429` + `Retry-After` + `code: rate_limit_exceeded`
 * (`api_server.py:7154-7182`). The cap is **shared by every agent-driving endpoint**,
 * so callers that fire at N people at once, like meetings, hit it head-on.
 *
 * Matching the client-side cap to the gateway setting is one option, but it is not enough on its own —
 * other clients on the same gateway still cause 429s. Rather than mimicking the value,
 * **handling the rejection properly** is the real fix.
 */

/** Is this a state where waiting a moment and retrying might succeed? */
export function shouldRetryStatus(status: number): boolean {
  // Only 429. 503 means the gateway itself cannot accept, so repeating gets the same answer,
  // and 4xx means the request itself is wrong.
  return status === 429;
}

/** Maximum wait a single meeting turn can be held for. Longer than this and the user sees it as stuck. */
const MAX_RETRY_WAIT_MS = 10_000;

/**
 * Reads the `Retry-After` header (seconds) as milliseconds. `null` if missing or unparseable —
 * the caller then uses its own backoff.
 */
export function parseRetryAfterMs(header: string | null | undefined): number | null {
  if (header == null) return null;
  const trimmed = header.trim();
  if (!trimmed) return null;
  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1000, MAX_RETRY_WAIT_MS);
}

/**
 * How long to wait on this attempt.
 *
 * The server-provided value beats our guess — the gateway knows its own load and we do not.
 */
export function retryDelayMs(attempt: number, retryAfterMs: number | null): number {
  if (retryAfterMs !== null) return retryAfterMs;
  return Math.min(500 * 2 ** attempt, MAX_RETRY_WAIT_MS);
}
