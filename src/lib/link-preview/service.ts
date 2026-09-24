/**
 * Link preview lookup — bundles guards, caps, parsing, and caching into one place. The route
 * should be a thin handler that just calls this function (the convention in `src/app/api/AGENTS`).
 *
 * The cache lives in process memory. A preview is a summary of someone else's public page, so
 * it isn't per-user, and losing it is fine — it's just refetched. Not worth a DB table. **Failure
 * is cached too**: so opening a report with a dead link in it doesn't hammer the same address
 * again every time.
 */
import { fetchGuarded, type FetchGuardedOptions } from "./fetch";
import { parseOpenGraph, type LinkPreview } from "./parse";
import { normalizePreviewUrl } from "./guard";

const HTML_MAX_BYTES = 512 * 1024;
const TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 500;
const MAX_ACTIVE_FETCHES = 8;
const slotState = globalThis as typeof globalThis & { __deskrpgPreviewSlots?: { active: number } };
const slots = (slotState.__deskrpgPreviewSlots ??= { active: 0 });

/** HTML and images share the same process budget. Once it's full, callers don't wait. */
export async function withPreviewSlot<T>(
  work: () => Promise<T>,
): Promise<{ admitted: true; value: T } | { admitted: false }> {
  if (slots.active >= MAX_ACTIVE_FETCHES) return { admitted: false };
  slots.active++;
  try {
    return { admitted: true, value: await work() };
  } finally {
    slots.active--;
  }
}

type Entry = { at: number; value: LinkPreview | null };
const cache = new Map<string, Entry>();

export function clearLinkPreviewCache(): void {
  cache.clear();
}

/** Routes images through our own route so the browser never hits someone else's CDN directly. */
export function proxiedImageUrl(imageUrl: string): string {
  return `/api/link-preview/image?url=${encodeURIComponent(imageUrl)}`;
}

function remember(key: string, value: LinkPreview | null): LinkPreview | null {
  if (cache.size >= CACHE_MAX) {
    // Insertion order is age order (a refresh deletes then re-sets). Evict the single oldest entry.
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.delete(key);
  cache.set(key, { at: Date.now(), value });
  return value;
}

export async function buildLinkPreview(
  rawUrl: string,
  options?: Pick<FetchGuardedOptions, "isAllowedUrl" | "isAllowedAddress">,
): Promise<LinkPreview | null> {
  // Where the address actually points is checked hop-by-hop by `fetchGuarded` — only the shape is checked here.
  const target = normalizePreviewUrl(rawUrl);
  if (!target) return null;
  const key = target.toString();

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const result = await withPreviewSlot(() =>
    fetchGuarded(target, {
      accept: "text/html",
      maxBytes: HTML_MAX_BYTES,
      isAllowedUrl: options?.isAllowedUrl,
      isAllowedAddress: options?.isAllowedAddress,
    }),
  );
  // Saturation is temporary. Caching it as a failure would keep it from recovering even after a slot frees up.
  if (!result.admitted) return null;
  const fetched = result.value;
  if (!fetched) return remember(key, null);

  const parsed = parseOpenGraph(fetched.body, fetched.url);
  if (!parsed) return remember(key, null);
  return remember(key, { ...parsed, image: parsed.image ? proxiedImageUrl(parsed.image) : null });
}
