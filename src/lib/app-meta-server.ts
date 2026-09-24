import { APP_VERSION } from "./app-meta";

export interface AppMeta {
  version: string;
  latestVersion: string | null;
  stars: number | null;
}

type FetchJson = (url: string) => Promise<unknown>;

const GITHUB_REPO_API = "https://api.github.com/repos/dandacompany/deskrpg";
const SIX_HOURS = 6 * 60 * 60 * 1000;
const TEN_MINUTES = 10 * 60 * 1000;

async function githubFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "deskrpg" },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  return res.json();
}

function field<T>(value: unknown, key: string, check: (v: unknown) => v is T): T | null {
  if (!value || typeof value !== "object") return null;
  const v = (value as Record<string, unknown>)[key];
  return check(v) ? v : null;
}

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const isTag = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/**
 * Caches GitHub's star count and latest release tag. The unauthenticated GitHub API is
 * limited to 60 requests per hour per IP, so successes are reused for 6 hours and
 * failures for 10 minutes, instead of asking every installation to hit it every time.
 */
export function createAppMetaCache({
  fetchJson = githubFetchJson,
  now = Date.now,
  ttlMs = SIX_HOURS,
  failureTtlMs = TEN_MINUTES,
}: {
  fetchJson?: FetchJson;
  now?: () => number;
  ttlMs?: number;
  failureTtlMs?: number;
} = {}) {
  let cached: { meta: AppMeta; expiresAt: number } | null = null;
  let inflight: Promise<AppMeta> | null = null;

  async function load(): Promise<AppMeta> {
    const [repo, release] = await Promise.allSettled([
      fetchJson(GITHUB_REPO_API),
      fetchJson(`${GITHUB_REPO_API}/releases/latest`),
    ]);
    const stars =
      repo.status === "fulfilled" ? field(repo.value, "stargazers_count", isCount) : null;
    const tag = release.status === "fulfilled" ? field(release.value, "tag_name", isTag) : null;
    const meta: AppMeta = {
      version: APP_VERSION,
      stars,
      latestVersion: tag ? tag.trim().replace(/^v/, "") : null,
    };
    const complete = meta.stars !== null && meta.latestVersion !== null;
    cached = { meta, expiresAt: now() + (complete ? ttlMs : failureTtlMs) };
    return meta;
  }

  return {
    async get(): Promise<AppMeta> {
      if (cached && now() < cached.expiresAt) return cached.meta;
      inflight ??= load().finally(() => {
        inflight = null;
      });
      return inflight;
    },
  };
}

export const appMetaCache = createAppMetaCache();
