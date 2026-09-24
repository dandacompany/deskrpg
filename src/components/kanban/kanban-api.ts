/**
 * Browser-side calls for the Kanban REST API (`/api/channels/:id/kanban/**`, `/automation/status`).
 *
 * The browser never calls Hermes directly — everything goes through same-origin DeskRPG routes,
 * and auth rides the session cookie like every other fetch in the app. Failures are thrown as-is
 * via `KanbanApiError` carrying the server's `{code, message, …}` (R32) — no translation or
 * folding happens here.
 *
 * No optimistic updates (R26). Mutation functions just return the response; the screen refetches
 * after success.
 */

import type {
  DispatchResult,
  KanbanAttachment,
  KanbanBoardAttachment,
  KanbanBoard,
  KanbanComment,
  KanbanTask,
  KanbanTaskAction,
  KanbanLinksPage,
  KanbanRunsPage,
  KanbanTaskDetail,
  OrchestrationSettings,
  SwarmCreated,
  WorkerLog,
} from "@/lib/hermes/deskrpg-plugin-types";

import type { BoardNpc, KanbanFailure } from "./kanban-view-model";

export class KanbanApiError extends Error implements KanbanFailure {
  readonly status: number;
  readonly code: string;
  readonly minVersion?: string;
  readonly extra: Record<string, unknown>;

  constructor(failure: KanbanFailure & { extra?: Record<string, unknown> }) {
    super(failure.message);
    this.name = "KanbanApiError";
    this.status = failure.status;
    this.code = failure.code;
    this.minVersion = failure.minVersion;
    this.extra = failure.extra ?? {};
  }
}

export type BoardResponse = KanbanBoard & { npcs: BoardNpc[] };

export type AutomationStatus = {
  pluginStatus: string | null;
  pluginVersion: string | null;
  capabilities: string[];
  timezone: string | null;
  boardSlug: string;
  dispatcherPresent: boolean;
  attachments: boolean;
  lastPolledAt: string | null;
  lastError: string | null;
  minVersion: string;
  working: Array<{
    npcId: string;
    working: boolean;
    sources: { runningCards: number; cronRuns: number };
  }>;
};

export type BoardSettings = {
  board: { slug: string; name: string | null; default_workdir: string | null; editable: boolean };
  orchestration: (OrchestrationSettings & { editable: boolean }) | null;
  hints: { default_assignee_recommend_empty?: boolean };
};

export type CreateTaskResponse = { task: KanbanTask; warning?: string };

/** The task detail response has no `warning` — the screen holds onto the create response's warning separately (R9). */

export type FetchLike = typeof fetch;

/** One row of the project list — only what the picker needs. Full shape is `ProjectView` (server). */
export type ProjectSummary = {
  id: string;
  boardSlug: string;
  name: string | null;
  status: string;
  isEventCarrier: boolean;
  /**
   * `YYYY-MM-DD` or null. The server (`ProjectView` in `project-registry.ts`) sent this from the
   * start; only this type had been narrowed for the picker. The timeline's target-date line reads
   * this value.
   */
  targetDate: string | null;
};

function base(channelId: string): string {
  return `/api/channels/${encodeURIComponent(channelId)}/kanban`;
}

async function parseFailure(res: Response): Promise<KanbanApiError> {
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await res.json();
    if (typeof parsed === "object" && parsed !== null) body = parsed as Record<string, unknown>;
  } catch {
    // If the body isn't JSON, build the failure from the status code alone.
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
  const { code: _c, message: _m, minVersion, ...extra } = body;
  return new KanbanApiError({
    status: res.status,
    code,
    message,
    minVersion: typeof minVersion === "string" ? minVersion : undefined,
    extra,
  });
}

async function request<T>(fetchImpl: FetchLike, url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(url, init);
  } catch (err) {
    throw new KanbanApiError({
      status: 0,
      code: "network_error",
      message: err instanceof Error ? err.message : String(err),
    });
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
 * The set of calls bound to a single channel. `fetchImpl` is for tests — by default this reads
 * the global fetch **at call time** (must not capture it at creation time, since tests swap out
 * the global).
 *
 * When `boardSlug` is given, `?board=` is appended to **every** call that goes out a kanban path.
 * It isn't appended by hand at each call site because whoever adds a new call would forget — and
 * forgetting silently touches the default board, so the user ends up editing the wrong board while
 * a different project is open. The injection wraps fetch in one layer and does not apply to
 * non-kanban paths like `/automation/status`.
 *
 * If omitted, this uses the channel's event-carrier board (= default project).
 */
export function createKanbanApi(channelId: string, fetchImpl?: FetchLike, boardSlug?: string) {
  const root = base(channelId);
  const withBoard = (url: string) => {
    if (!boardSlug || !url.startsWith(root)) return url;
    return `${url}${url.includes("?") ? "&" : "?"}board=${encodeURIComponent(boardSlug)}`;
  };
  const f: FetchLike = (input, init) =>
    (fetchImpl ?? globalThis.fetch)(typeof input === "string" ? withBoard(input) : input, init);
  const task = (taskId: string) => `${root}/tasks/${encodeURIComponent(taskId)}`;

  return {
    status: () =>
      request<AutomationStatus>(
        f,
        `/api/channels/${encodeURIComponent(channelId)}/automation/status`,
      ),
    /**
     * The list of this channel's projects (= boards). This is outside kanban paths, so `?board=`
     * is not appended — appending it would lock every list read to the currently chosen board.
     */
    projects: () =>
      request<{ projects: ProjectSummary[] }>(
        f,
        `/api/channels/${encodeURIComponent(channelId)}/projects`,
      ),
    board: (includeArchived: boolean) =>
      request<BoardResponse>(f, `${root}/board${includeArchived ? "?include_archived=true" : ""}`),
    taskDetail: (taskId: string) => request<KanbanTaskDetail>(f, task(taskId)),
    /**
     * Bulk link lookup — parent/child pairs across the whole board. Fails with 404 if the plugin
     * lacks `kanban_views`. The screen then falls back to calling `taskDetail()` per card.
     */
    links: () => request<KanbanLinksPage>(f, `${root}/links`),
    /** Run history within a window. `from`/`to` are epoch seconds; if omitted, the plugin gives the last 7 days. */
    runs: (opts?: { from?: number; to?: number; limit?: number }) => {
      const qs = new URLSearchParams();
      for (const key of ["from", "to", "limit"] as const) {
        const value = opts?.[key];
        if (typeof value === "number") qs.set(key, String(value));
      }
      return request<KanbanRunsPage>(f, `${root}/runs${qs.size > 0 ? `?${qs}` : ""}`);
    },
    createTask: (body: Record<string, unknown>) =>
      request<CreateTaskResponse>(f, `${root}/tasks`, json("POST", body)),
    updateTask: (taskId: string, body: Record<string, unknown>) =>
      request<{ task: KanbanTask }>(f, task(taskId), json("PATCH", body)),
    deleteTask: (taskId: string) => request<{ ok: true }>(f, task(taskId), { method: "DELETE" }),
    addComment: (taskId: string, body: string) =>
      request<{ comment: KanbanComment }>(f, `${task(taskId)}/comments`, json("POST", { body })),
    /** `reassign` takes `{npcId}`, `request-changes`/`unblock` take `{comment}`, everything else has no body. */
    action: (taskId: string, action: KanbanTaskAction, body?: Record<string, unknown>) =>
      request<{ task: KanbanTask | Record<string, unknown> }>(
        f,
        `${task(taskId)}/${action}`,
        json("POST", body ?? {}),
      ),
    log: (taskId: string, tail = 16384) =>
      request<WorkerLog>(f, `${task(taskId)}/log?tail=${tail}`),
    attachments: (taskId: string) =>
      request<{ attachments: KanbanAttachment[] }>(f, `${task(taskId)}/attachments`),
    uploadAttachment: (taskId: string, file: File) => {
      const form = new FormData();
      form.append("file", file, file.name);
      return request<{ attachment: KanbanAttachment }>(f, `${task(taskId)}/attachments`, {
        method: "POST",
        body: form,
      });
    },
    deleteAttachment: (attachmentId: string) =>
      request<{ ok: true }>(f, `${root}/attachments/${encodeURIComponent(attachmentId)}`, {
        method: "DELETE",
      }),
    // This is a URL the browser opens directly, so it doesn't go through fetch — appended by hand only here.
    /** Board-wide attachments. If the plugin doesn't know the list, it returns `supported: false` (not an error). */
    boardAttachments: (cursor?: string) =>
      request<{
        supported: boolean;
        attachments: KanbanBoardAttachment[];
        next_cursor: string | null;
      }>(f, `${root}/attachments${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),
    attachmentUrl: (attachmentId: string) =>
      withBoard(`${root}/attachments/${encodeURIComponent(attachmentId)}`),
    addLink: (parentId: string, childId: string) =>
      request<{ ok: true }>(
        f,
        `${root}/links`,
        json("POST", { parent_id: parentId, child_id: childId }),
      ),
    removeLink: (parentId: string, childId: string) =>
      request<{ ok: true }>(
        f,
        `${root}/links`,
        json("DELETE", { parent_id: parentId, child_id: childId }),
      ),
    dispatch: (opts?: { max?: number }) => {
      const qs = new URLSearchParams();
      if (typeof opts?.max === "number") qs.set("max", String(opts.max));
      const suffix = qs.size > 0 ? `?${qs}` : "";
      return request<DispatchResult>(f, `${root}/dispatch${suffix}`, { method: "POST" });
    },
    createSwarm: (body: {
      goal: string;
      workers: Array<{ npcId: string; title: string; body?: string; skills?: string[] }>;
      verifierNpcId: string;
      synthesizerNpcId: string;
      idempotencyKey: string;
    }) => request<SwarmCreated>(f, `${root}/swarm`, json("POST", body)),
    blackboard: (taskId: string) =>
      request<{ blackboard: Record<string, unknown> }>(f, `${task(taskId)}/blackboard`),
    /**
     * Resolve a card proposal. 200 `{choice, taskId?, assigneeDropped?}`. Failures are a
     * `KanbanApiError` carrying the server code as-is — the screen can catch 409
     * `already_resolved` to show guidance.
     */
    resolveProposal: (proposalId: string, choice: "card" | "inline") =>
      request<{ choice: "card" | "inline"; taskId?: string; assigneeDropped?: boolean }>(
        f,
        `${root}/proposals/${encodeURIComponent(proposalId)}/resolve`,
        json("POST", { choice }),
      ),
    settings: () => request<BoardSettings>(f, `${root}/settings`),
    patchSettings: (body: {
      board?: { default_workdir: string };
      orchestration?: Record<string, unknown>;
    }) => request<BoardSettings>(f, `${root}/settings`, json("PATCH", body)),
  };
}

export type KanbanApi = ReturnType<typeof createKanbanApi>;

/** Coerces any exception into a `KanbanFailure`. If it's already a `KanbanApiError`, pass it through. */
export function toFailure(err: unknown): KanbanFailure {
  if (err instanceof KanbanApiError) {
    return { status: err.status, code: err.code, message: err.message, minVersion: err.minVersion };
  }
  return {
    status: 0,
    code: "unknown_error",
    message: err instanceof Error ? err.message : String(err),
  };
}
