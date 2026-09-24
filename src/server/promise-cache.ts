/**
 * Caches the **in-flight promise** per key — not the finished value.
 *
 * Caching the finished value opens a window while creation is async. Two calls arrive side by side,
 * both see a cache miss, both create, and the later one overwrites the earlier — but **the earlier instance
 * keeps living** and doing its work. In the free-chat runtime that meant the same NPC speaking twice at once
 * (the in-flight guard is per instance) and the budget doubling.
 *
 * So the promise itself is registered **synchronously**. The second call receives the first call's promise.
 */
export function getOrCreateCached<T>(
  cache: Map<string, Promise<T | null>>,
  key: string,
  create: () => Promise<T | null>,
): Promise<T | null> {
  const existing = cache.get(key);
  if (existing) return existing;

  const creating = create().then(
    (value) => {
      // null is not cached — it means "cannot create yet", not "does not exist".
      // (In free chat, the channel has no NPC yet. Once one is placed we must try again.)
      if (value === null && cache.get(key) === creating) cache.delete(key);
      return value;
    },
    (err) => {
      if (cache.get(key) === creating) cache.delete(key);
      throw err;
    },
  );

  // Why the `=== creating` guard appears twice: a late failure must not delete **another entry registered
  // in the meantime**. Only delete what we put there ourselves.
  cache.set(key, creating);
  return creating;
}
