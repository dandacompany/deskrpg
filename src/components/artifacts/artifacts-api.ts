/**
 * Browser-side calls to the artifacts REST API (`/api/channels/:id/artifacts/**`).
 *
 * The browser never calls Hermes directly — everything goes through same-origin DeskRPG
 * routes, and auth rides on the session cookie like any other fetch in the app. Failures are
 * thrown as-is inside `ArtifactsApiError`, carrying the `{code, message, …}` the server sent —
 * this layer doesn't translate or fold them.
 */

import type {
  ArtifactCategory,
  ArtifactDetail,
  ArtifactPage,
  ArtifactSource,
  ArtifactVersion,
} from "@/lib/hermes/deskrpg-plugin-types";
import type { ArtifactProvenance } from "@/lib/artifact-provenance";

export class ArtifactsApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly minVersion?: string;

  constructor(status: number, code: string, message: string, minVersion?: string) {
    super(message);
    this.name = "ArtifactsApiError";
    this.status = status;
    this.code = code;
    this.minVersion = minVersion;
  }
}

/**
 * The detail response. The server appends channel-scoped judgments to the plugin detail —
 * `modifiable` (editable/deletable in this channel), `sourceInChannel` (the source card is on
 * this channel's board). Permissions themselves are re-checked by the server on mutation routes.
 */
export type ArtifactDetailView = ArtifactDetail & {
  modifiable?: boolean;
  sourceInChannel?: boolean;
  /** The card, run and parent cards a board artifact of this channel came from. */
  provenance?: ArtifactProvenance;
};

export type ArtifactListFilter = {
  category?: ArtifactCategory;
  source?: ArtifactSource;
  profile?: string;
  q?: string;
  taskId?: string;
};

type FetchLike = typeof fetch;

function base(channelId: string): string {
  return `/api/channels/${encodeURIComponent(channelId)}/artifacts`;
}

async function parseFailure(res: Response): Promise<ArtifactsApiError> {
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await res.json();
    if (typeof parsed === "object" && parsed !== null) body = parsed as Record<string, unknown>;
  } catch {
    // If the body isn't JSON, build the error from the status code alone.
  }
  const code =
    typeof body.code === "string"
      ? body.code
      : typeof body.errorCode === "string"
        ? body.errorCode
        : typeof body.error === "string"
          ? body.error
          : `http_${res.status}`;
  const message =
    typeof body.message === "string" && body.message ? body.message : res.statusText || code;
  const minVersion = typeof body.minVersion === "string" ? body.minVersion : undefined;
  return new ArtifactsApiError(res.status, code, message, minVersion);
}

async function request<T>(fetchImpl: FetchLike, url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(url, init);
  } catch (err) {
    throw new ArtifactsApiError(
      0,
      "network_error",
      err instanceof Error ? err.message : String(err),
    );
  }
  if (!res.ok) throw await parseFailure(res);
  return (await res.json()) as T;
}

function json(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

/**
 * A set of calls bound to one channel. `fetchImpl` is for tests — by default it reads the
 * global fetch **at call time** (tests swap out the global, so it must not be captured at
 * creation time).
 */
export function createArtifactsApi(channelId: string, fetchImpl?: FetchLike) {
  const f: FetchLike = (input, init) => (fetchImpl ?? globalThis.fetch)(input, init);
  const root = base(channelId);
  const artifact = (id: string) => `${root}/${encodeURIComponent(id)}`;

  return {
    list: async (filter: ArtifactListFilter, cursor?: string): Promise<ArtifactPage> => {
      const qs = new URLSearchParams();
      if (filter.category) qs.set("category", filter.category);
      if (filter.source) qs.set("source", filter.source);
      if (filter.profile) qs.set("profile", filter.profile);
      if (filter.q) qs.set("q", filter.q);
      if (filter.taskId) qs.set("taskId", filter.taskId);
      if (cursor) qs.set("cursor", cursor);
      qs.set("limit", "50");
      const suffix = qs.size > 0 ? `?${qs}` : "";
      return request<ArtifactPage>(f, `${root}${suffix}`);
    },
    get: (id: string) => request<ArtifactDetailView>(f, artifact(id)),
    contentUrl: (id: string, version: number, download?: boolean): string => {
      const suffix = download ? "?download=1" : "";
      return `${artifact(id)}/versions/${version}/content${suffix}`;
    },
    fetchText: async (
      id: string,
      version: number,
      maxBytes: number,
    ): Promise<{ text: string; truncated: boolean }> => {
      let res: Response;
      try {
        res = await f(`${artifact(id)}/versions/${version}/content`, {
          headers: { range: `bytes=0-${maxBytes - 1}` },
        });
      } catch (err) {
        throw new ArtifactsApiError(
          0,
          "network_error",
          err instanceof Error ? err.message : String(err),
        );
      }
      if (!res.ok) throw await parseFailure(res);
      const text = await res.text();
      let truncated = false;
      if (res.status === 206) {
        const totalRaw = res.headers.get("content-range")?.split("/")[1]?.trim();
        const total = totalRaw && totalRaw !== "*" ? Number(totalRaw) : NaN;
        truncated = Number.isFinite(total) ? total > maxBytes : text.length === maxBytes;
      }
      return { text, truncated };
    },
    fetchBlob: async (id: string, version: number): Promise<Blob> => {
      let res: Response;
      try {
        res = await f(`${artifact(id)}/versions/${version}/content`);
      } catch (err) {
        throw new ArtifactsApiError(
          0,
          "network_error",
          err instanceof Error ? err.message : String(err),
        );
      }
      if (!res.ok) throw await parseFailure(res);
      return res.blob();
    },
    addVersion: async (
      id: string,
      body: { content: string; filename: string; note?: string },
    ): Promise<ArtifactVersion> => {
      const result = await request<{ version: ArtifactVersion }>(
        f,
        `${artifact(id)}/versions`,
        json("POST", body),
      );
      return result.version;
    },
    remove: (id: string): Promise<void> =>
      request<{ ok: true }>(f, artifact(id), { method: "DELETE" }).then(() => undefined),
  };
}

export type ArtifactsApi = ReturnType<typeof createArtifactsApi>;
