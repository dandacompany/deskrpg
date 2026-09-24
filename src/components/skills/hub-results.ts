import type { HubSearchResult } from "@/lib/hermes/plugin-client-types";

/** Trust-level order — lower ranks first. Unknown levels sort after community. */
const TRUST_RANK: Record<string, number> = { builtin: 0, trusted: 1, community: 2 };
const rank = (trust: string) => TRUST_RANK[trust] ?? 3;

/**
 * Orders Hub search results by trust level (builtin > trusted > community). Within the same
 * level, the server's own order is preserved (`Array.prototype.sort` is stable). Does not mutate
 * the input array.
 */
export function sortHubResults(results: HubSearchResult[]): HubSearchResult[] {
  return [...results].sort((a, b) => rank(a.trustLevel) - rank(b.trustLevel));
}
