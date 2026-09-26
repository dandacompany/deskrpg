import { transportFetch } from "./setup/transport";
/**
 * Wrapper for calling `deskrpg-hermes-plugin` routes.
 *
 * **Keeps token selection from leaking outside this file.** Hermes auth is
 * fail-closed per profile, so getting which key goes with which path wrong means 401 everywhere:
 *
 *     /deskrpg/*            → default (gateway) token
 *     /p/{name}/deskrpg/*   → that profile's token
 *
 * Making every call site remember this rule means it will be wrong someday. It is confined to this one place.
 *
 * No method **throws** — even network failures come back as `{ok:false}`.
 * That is because the proxy routes carry it over as 200 + errorCode.
 *
 * Review round 1:
 * - I-1: on a 200 with non-JSON (it really happened that something in front of the gateway served
 *   an HTML error page) we used to emit `{ok:true, data:null}`, and the caller threw on the very
 *   next line. Fold it by the same criterion as the sibling module `plugin-capability.ts` — do not
 *   claim success. (No route in this API uses 204.)
 * - I-3: `probeDeskrpgPlugin` has a timeout but this file, which actually exchanges data, did
 *   not, so when the gateway kept the socket open the route handler hung indefinitely. A problem
 *   to retry (`unreachable`) and a problem to check the address (`timeout`) call for different user
 *   actions, so the codes are separated.
 */

import { mapPluginFailure, type PluginFailure } from "./plugin-errors";

import type {
  ArtifactsApi,
  CardProposalsApi,
  CronApi,
  EventsApi,
  ApprovalPolicyApi,
  SessionApi,
  AskUserApi,
  KanbanApi,
  McpAdminApi,
  OwnerPluginClient,
  PluginClient,
  PluginResponse,
  ProfilePluginClient,
  RawPluginResponse,
  SkillAdminApi,
} from "./plugin-client-types";
export type {
  PluginResponse,
  RawPluginResponse,
  IdentityPayload,
  CreateProfilePayload,
  IssueProfileKeyPayload,
  CreateProfileOptions,
  DeleteProfilePayload,
  CatalogPayload,
  ToolsetRow,
  ToolsetsPayload,
  ToolProviderRow,
  ToolProvidersPayload,
  ToolProviderSelectResult,
  SkillRow,
  SkillsPayload,
  ProviderAuthType,
  OAuthStartPayload,
  OAuthPollPayload,
  ProviderKeyPayload,
  PluginClient,
  KanbanApi,
  EventsApi,
  ArtifactsApi,
  ArtifactListQuery,
  CronApi,
  OwnerPluginClient,
  ProfilePluginClient,
} from "./plugin-client-types";

const UNREACHABLE: PluginFailure = {
  code: "unreachable",
  message: "",
  blocksEditor: true,
  showsShellCommand: null,
  details: {},
};

// I-3: the gateway was reached and time ran out while waiting for the response. The user action differs
// from `unreachable` — check the address/state first rather than retrying.
const TIMEOUT: PluginFailure = {
  code: "timeout",
  message: "",
  blocksEditor: true,
  showsShellCommand: null,
  details: {},
};

// I-1: on a 2xx whose body is not a JSON object (HTML error page, `null`, parse failure, etc.)
// do not claim success. Same criterion as `classifyPluginProbe` in `plugin-capability.ts`, which
// also refuses a body that is not an object.
const MALFORMED_RESPONSE: PluginFailure = {
  code: "malformed_response",
  message: "",
  blocksEditor: true,
  showsShellCommand: null,
  details: {},
};

const DEFAULT_TIMEOUT_MS = 15000;

type TransportInput = {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

type CallInit = {
  method?: string;
  /** JSON body. Not used together with `formData`. */
  body?: unknown;
  /** multipart body (attachment upload). fetch adds the content-type together with the boundary. */
  formData?: FormData;
  headers?: Record<string, string>;
};

/**
 * The one layer shared by the three clients (`createPluginClient`·`createOwnerPluginClient`·`createProfilePluginClient`)
 * — timeout, unreachable, JSON check and `mapPluginFailure` live here in one place.
 * The token is taken per call, but which token to use is fixed by each outer client at creation time.
 */
function createPluginTransport(input: TransportInput) {
  const fetchImpl = input.fetchImpl ?? transportFetch;
  const base = input.baseUrl.replace(/\/+$/, "");
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function call<T>(
    path: string,
    token: string,
    init: CallInit = {},
  ): Promise<PluginResponse<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method: init.method ?? "GET",
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          ...(init.headers ?? {}),
        },
        ...(init.formData !== undefined
          ? { body: init.formData }
          : init.body === undefined
            ? {}
            : { body: JSON.stringify(init.body) }),
        signal: controller.signal,
      });
    } catch {
      // Whether the abort came from our own timer separates retry (unreachable) from timeout.
      return controller.signal.aborted
        ? { ok: false, failure: TIMEOUT, status: 0 }
        : { ok: false, failure: UNREACHABLE, status: 0 };
    } finally {
      clearTimeout(timer);
    }

    let body: unknown = null;
    let parseFailed = false;
    try {
      body = await res.json();
    } catch {
      parseFailed = true;
    }

    // A 2xx whose body is not an object (HTML error page, parse failure, `null`, etc.) is also a
    // failure — sending null while claiming success makes the caller throw on the next line.
    const isSuccessStatus = res.status >= 200 && res.status < 300;
    if (isSuccessStatus && (parseFailed || typeof body !== "object" || body === null)) {
      return { ok: false, failure: MALFORMED_RESPONSE, status: res.status };
    }

    const failure = mapPluginFailure({ status: res.status, body });
    if (failure) return { ok: false, failure, status: res.status };
    return { ok: true, data: body as T };
  }

  async function callRaw(
    path: string,
    token: string,
    init: { headers?: Record<string, string> } = {},
  ): Promise<RawPluginResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      // The timeout covers only up to the response head — the body is a stream, so taking long is normal.
      res = await fetchImpl(`${base}${path}`, {
        method: "GET",
        headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
        signal: controller.signal,
      });
    } catch {
      return controller.signal.aborted
        ? { ok: false, failure: TIMEOUT, status: 0 }
        : { ok: false, failure: UNREACHABLE, status: 0 };
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 200 && res.status < 300) return { ok: true, response: res };
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const failure = mapPluginFailure({ status: res.status, body }) ?? MALFORMED_RESPONSE;
    return { ok: false, failure, status: res.status };
  }

  return { call, callRaw };
}

/** Builds a query string. Drops `undefined` values and encodes only what is present. Empty string if none. */
function query(params: Record<string, string | number | boolean | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

export function createPluginClient(input: TransportInput & { defaultToken: string }): PluginClient {
  const { call } = createPluginTransport(input);

  // There are paths where the profile name can come in without passing validation (user input).
  const seg = (name: string) => encodeURIComponent(name);

  return {
    listProfiles: () => call("/deskrpg/profiles", input.defaultToken),

    ensureWorkerPlugin: (profiles) =>
      call("/deskrpg/worker-plugin", input.defaultToken, {
        method: "POST",
        body: profiles ? { profiles } : {},
      }),

    createProfile: (name, options) =>
      call("/deskrpg/profiles", input.defaultToken, {
        method: "POST",
        body: {
          name,
          ...(options?.cloneFrom ? { cloneFrom: options.cloneFrom } : {}),
          ...(options?.cloneKeys ? { cloneKeys: options.cloneKeys } : {}),
        },
      }),

    issueProfileKey: (name, options) =>
      call(`/deskrpg/profiles/${seg(name)}/key`, input.defaultToken, {
        method: "POST",
        body: options?.rotate ? { rotate: true } : {},
      }),

    // The plugin deletes only if `confirm` exactly matches the name in the path (400 guard).
    deleteProfile: (name) =>
      call(
        `/deskrpg/profiles/${seg(name)}?confirm=${encodeURIComponent(name)}`,
        input.defaultToken,
        {
          method: "DELETE",
        },
      ),

    getIdentity: (name, profileToken) => call(`/p/${seg(name)}/deskrpg/identity`, profileToken),

    putIdentity: (name, profileToken, body) =>
      call(`/p/${seg(name)}/deskrpg/identity`, profileToken, { method: "PUT", body }),

    getConfig: (name, profileToken) => call(`/p/${seg(name)}/deskrpg/config`, profileToken),

    // Model/provider list. Profile-scoped — auth state can differ per profile.
    getCatalog: (name, profileToken) => call(`/p/${seg(name)}/deskrpg/catalog`, profileToken),

    putConfig: (name, profileToken, patch) =>
      call(`/p/${seg(name)}/deskrpg/config`, profileToken, { method: "PUT", body: patch }),

    // Employee settings picker (0.9.0). Profile-scoped — skill folders and key settings differ per profile.
    getToolsets: (name, profileToken) => call(`/p/${seg(name)}/deskrpg/toolsets`, profileToken),
    getSkills: (name, profileToken) => call(`/p/${seg(name)}/deskrpg/skills`, profileToken),
    getToolProviders: (name, profileToken, toolset) =>
      call(`/p/${seg(name)}/deskrpg/toolsets/${seg(toolset)}/providers`, profileToken),
    putToolProvider: (name, profileToken, toolset, body) =>
      call(`/p/${seg(name)}/deskrpg/toolsets/${seg(toolset)}/provider`, profileToken, {
        method: "PUT",
        body,
      }),

    // Provider auth (0.9.0). All profile-scoped with the profile token — every segment is encoded.
    startOAuth: (name, profileToken, provider) =>
      call(`/p/${seg(name)}/deskrpg/oauth/${seg(provider)}/start`, profileToken, {
        method: "POST",
      }),
    pollOAuth: (name, profileToken, provider, sessionId) =>
      call(
        `/p/${seg(name)}/deskrpg/oauth/${seg(provider)}/sessions/${seg(sessionId)}`,
        profileToken,
      ),
    cancelOAuth: (name, profileToken, sessionId) =>
      call(`/p/${seg(name)}/deskrpg/oauth/sessions/${seg(sessionId)}`, profileToken, {
        method: "DELETE",
      }),
    disconnectOAuth: (name, profileToken, provider) =>
      call(`/p/${seg(name)}/deskrpg/oauth/${seg(provider)}`, profileToken, { method: "DELETE" }),
    putProviderKey: (name, profileToken, provider, value) =>
      call(`/p/${seg(name)}/deskrpg/provider-keys/${seg(provider)}`, profileToken, {
        method: "PUT",
        body: { value },
      }),
    deleteProviderKey: (name, profileToken, provider) =>
      call(`/p/${seg(name)}/deskrpg/provider-keys/${seg(provider)}`, profileToken, {
        method: "DELETE",
      }),
  };
}

// ---------------------------------------------------------------------------
// Automation contract (v0.6.0+) — owner-key client (kanban·events) / profile-key client (cron)
//
// The token is fixed **at creation time**. If, like `PluginClient`, each method took a token, the mistake of passing
// a profile key to a kanban call would not be caught by types (both are string). The owner client has no
// profile paths and the profile client has no owner paths, so there is nowhere to mix them.
// ---------------------------------------------------------------------------

/** The surface called only with the owner (gateway) key — `/deskrpg/info`, `/deskrpg/kanban/*`, `/deskrpg/events`. */
export function createOwnerPluginClient(
  input: TransportInput & { ownerToken: string },
): OwnerPluginClient {
  const { call, callRaw } = createPluginTransport(input);
  const token = input.ownerToken;
  const seg = (value: string) => encodeURIComponent(value);
  const task = (board: string, id: string, suffix = "") =>
    `/deskrpg/kanban/tasks/${seg(id)}${suffix}${query({ board })}`;

  const kanban: KanbanApi = {
    // Archived boards are still channel projects — the list must name them. Older plugins ignore the query.
    listBoards: () => call(`/deskrpg/kanban/boards${query({ include_archived: true })}`, token),
    createBoard: (body) => call("/deskrpg/kanban/boards", token, { method: "POST", body }),
    updateBoard: (slug, body) =>
      call(`/deskrpg/kanban/boards/${seg(slug)}`, token, { method: "PATCH", body }),
    setBoardDefaultPolicy: (slug, body) =>
      call(`/deskrpg/kanban/boards/${seg(slug)}/default-policy`, token, { method: "PUT", body }),

    getBoard: (board, opts) =>
      call(
        `/deskrpg/kanban/board${query({
          board,
          include_archived: opts?.includeArchived ? true : undefined,
        })}`,
        token,
      ),
    getTask: (board, id) => call(task(board, id), token),
    listLinks: (board) => call(`/deskrpg/kanban/links${query({ board })}`, token),
    listRuns: (board, opts) =>
      call(
        `/deskrpg/kanban/runs${query({
          board,
          from: opts?.from,
          to: opts?.to,
          limit: opts?.limit,
        })}`,
        token,
      ),
    listStatusTransitions: (board, opts) =>
      call(
        `/deskrpg/kanban/events${query({
          board,
          kind: "status",
          from: opts?.from,
          to: opts?.to,
          limit: opts?.limit,
        })}`,
        token,
      ),
    createTask: (board, body, actor) =>
      call(`/deskrpg/kanban/tasks${query({ board })}`, token, {
        method: "POST",
        body,
        ...(actor ? { headers: { "x-deskrpg-actor": actor } } : {}),
      }),
    updateTask: (board, id, body) => call(task(board, id), token, { method: "PATCH", body }),
    deleteTask: (board, id) => call(task(board, id), token, { method: "DELETE" }),
    addComment: (board, id, body) =>
      call(task(board, id, "/comments"), token, { method: "POST", body }),
    runTaskAction: (board, id, action, body, actor) =>
      call(task(board, id, `/${action}`), token, {
        method: "POST",
        body,
        ...(actor
          ? {
              headers: {
                "X-DeskRPG-User-Id": actor.userId,
                ...(actor.name ? { "X-DeskRPG-User-Name": encodeURIComponent(actor.name) } : {}),
              },
            }
          : {}),
      }),

    listAttachments: (board, id) => call(task(board, id, "/attachments"), token),
    listBoardAttachments: (board, opts) =>
      call(
        `/deskrpg/kanban/attachments${query({ board, limit: opts?.limit, cursor: opts?.cursor })}`,
        token,
      ),
    uploadAttachment: (board, id, file) => {
      const formData = new FormData();
      const blob = typeof file.content === "string" ? new Blob([file.content]) : file.content;
      formData.append("file", blob, file.filename);
      return call(task(board, id, "/attachments"), token, { method: "POST", formData });
    },
    attachmentContent: (board, attachmentId, opts) =>
      callRaw(`/deskrpg/kanban/attachments/${seg(attachmentId)}${query({ board })}`, token, {
        headers: opts.range ? { range: opts.range } : {},
      }),
    deleteAttachment: (board, attachmentId) =>
      call(`/deskrpg/kanban/attachments/${seg(attachmentId)}${query({ board })}`, token, {
        method: "DELETE",
      }),

    addLink: (board, body) =>
      call(`/deskrpg/kanban/links${query({ board })}`, token, { method: "POST", body }),
    removeLink: (board, body) =>
      call(`/deskrpg/kanban/links${query({ board })}`, token, { method: "DELETE", body }),

    dispatch: (board, opts) =>
      call(`/deskrpg/kanban/dispatch${query({ board, max: opts?.max })}`, token, {
        method: "POST",
        body: {},
      }),

    createSwarm: (board, body) =>
      call(`/deskrpg/kanban/swarm?board=${encodeURIComponent(board)}`, token, {
        method: "POST",
        body,
      }),
    getBlackboard: (board, id) => call(task(board, id, "/blackboard"), token),

    getTaskLog: (board, id, opts) =>
      call(`/deskrpg/kanban/tasks/${seg(id)}/log${query({ board, tail: opts?.tail })}`, token),

    getOrchestration: () => call("/deskrpg/kanban/orchestration", token),
    updateOrchestration: (body) =>
      call("/deskrpg/kanban/orchestration", token, { method: "PUT", body }),
    listProfiles: () => call("/deskrpg/kanban/profiles", token),
  };

  const events: EventsApi = {
    handoff: (body) => call("/deskrpg/events/handoff", token, { method: "POST", body }),
    poll: (opts) =>
      call(
        `/deskrpg/events${query({
          board: opts.board,
          cursor: opts.cursor,
          limit: opts.limit,
          include: opts.include,
        })}`,
        token,
      ),
  };

  const artifacts: ArtifactsApi = {
    list: (q) =>
      call(
        `/deskrpg/artifacts${query({
          profiles: q.profiles.length ? q.profiles.join(",") : undefined,
          board: q.board,
          kind: q.kind,
          source: q.source,
          q: q.q,
          cursor: q.cursor,
          limit: q.limit,
          task_id: q.taskId,
        })}`,
        token,
      ),
    get: (id) => call(`/deskrpg/artifacts/${seg(id)}`, token),
    content: (id, version, opts) =>
      callRaw(
        `/deskrpg/artifacts/${seg(id)}/versions/${version}/content${query({
          download: opts.download ? 1 : undefined,
        })}`,
        token,
        { headers: opts.range ? { range: opts.range } : {} },
      ),
    addVersion: (id, body, user) =>
      call(`/deskrpg/artifacts/${seg(id)}/versions`, token, {
        method: "POST",
        body,
        headers: { "x-deskrpg-user": user },
      }),
    remove: (id, user) =>
      call(`/deskrpg/artifacts/${seg(id)}`, token, {
        method: "DELETE",
        headers: { "x-deskrpg-user": user },
      }),
  };

  const cardProposals: CardProposalsApi = {
    resolve: (proposalId, body) =>
      call(`/deskrpg/card-proposals/${seg(proposalId)}/resolve`, token, { method: "POST", body }),
    unresolve: (proposalId) =>
      call(`/deskrpg/card-proposals/${seg(proposalId)}/unresolve`, token, {
        method: "POST",
        body: {},
      }),
    recordTask: (proposalId, body) =>
      call(`/deskrpg/card-proposals/${seg(proposalId)}/task`, token, { method: "POST", body }),
  };

  return {
    info: () => call("/deskrpg/info", token),
    kanban,
    events,
    artifacts,
    cardProposals,
  };
}

/** The surface called only with one profile's key — `/p/{profile}/deskrpg/cron/*`, skill management (`skills|curator|learning/*`), and MCP connectors (`mcp/*`). */
export function createProfilePluginClient(
  input: TransportInput & { profileName: string; profileToken: string },
): ProfilePluginClient {
  const { call } = createPluginTransport(input);
  const token = input.profileToken;
  const seg = (value: string) => encodeURIComponent(value);
  // Same prefix convention as `hermes-client.ts` — profile scope is appended after `/p/<name>`.
  const root = `/p/${seg(input.profileName)}/deskrpg/cron`;
  const job = (id: string, suffix = "") => `${root}/jobs/${seg(id)}${suffix}`;

  const cron: CronApi = {
    listJobs: (opts) =>
      call(
        `${root}/jobs${query({ include_disabled: opts?.includeDisabled ? true : undefined })}`,
        token,
      ),
    getJob: (id) => call(job(id), token),
    listRuns: (id, opts) => call(`${job(id, "/runs")}${query({ limit: opts?.limit })}`, token),
    createJob: (body) => call(`${root}/jobs`, token, { method: "POST", body }),
    updateJob: (id, body) => call(job(id), token, { method: "PUT", body }),
    pauseJob: (id) => call(job(id, "/pause"), token, { method: "POST", body: {} }),
    resumeJob: (id) => call(job(id, "/resume"), token, { method: "POST", body: {} }),
    runJob: (id) => call(job(id, "/run"), token, { method: "POST", body: {} }),
    deleteJob: (id) => call(job(id), token, { method: "DELETE" }),
    listDeliveryTargets: () => call(`${root}/delivery-targets`, token),
    listBlueprints: () => call(`${root}/blueprints`, token),
    instantiateBlueprint: (body) =>
      call(`${root}/blueprints/instantiate`, token, { method: "POST", body }),
  };

  const prof = `/p/${seg(input.profileName)}/deskrpg`;
  const skill = (name: string, suffix = "") => `${prof}/skills/${seg(name)}${suffix}`;
  // Only mutating requests carry the user id — the plugin records it as the changer in the ledger.
  const as = (actor: string) => ({ headers: { "x-deskrpg-actor": actor } });

  const skills: SkillAdminApi = {
    list: () => call(`${prof}/skills`, token),
    detail: (name) => call(skill(name), token),
    readFile: (name, path) => call(`${skill(name, "/file")}${query({ path })}`, token),
    writeFile: (name, body, actor) =>
      call(skill(name, "/file"), token, { method: "PUT", body, ...as(actor) }),
    create: (body, actor) => call(`${prof}/skills`, token, { method: "POST", body, ...as(actor) }),
    setEnabled: (name, enabled, actor) =>
      call(skill(name, "/enabled"), token, { method: "PUT", body: { enabled }, ...as(actor) }),
    setEnabledBulk: (body, actor) =>
      call(`${prof}/skills/enabled`, token, { method: "PUT", body, ...as(actor) }),
    setPinned: (name, pinned, actor) =>
      call(skill(name, "/pinned"), token, { method: "PUT", body: { pinned }, ...as(actor) }),
    archive: (name, actor) =>
      call(skill(name, "/archive"), token, { method: "POST", body: {}, ...as(actor) }),
    listArchived: () => call(`${prof}/skills/archive`, token),
    restore: (name, actor) =>
      call(`${prof}/skills/archive/${seg(name)}/restore`, token, {
        method: "POST",
        body: {},
        ...as(actor),
      }),
    purge: (name, actor) =>
      call(`${prof}/skills/archive/${seg(name)}`, token, { method: "DELETE", ...as(actor) }),
    hubSearch: (q, source) => call(`${prof}/skills/hub/search${query({ q, source })}`, token),
    hubPreview: (identifier) => call(`${prof}/skills/hub/preview${query({ identifier })}`, token),
    hubInstall: (body, actor) =>
      call(`${prof}/skills/hub/installs`, token, { method: "POST", body, ...as(actor) }),
    hubUninstall: (name, actor) =>
      call(`${prof}/skills/hub/uninstall`, token, {
        method: "POST",
        body: { name },
        ...as(actor),
      }),
    hubUpdate: (name, actor) =>
      call(`${prof}/skills/hub/update`, token, {
        method: "POST",
        body: name ? { name } : {},
        ...as(actor),
      }),
    job: (kind, jobId) =>
      call(
        kind === "hub"
          ? `${prof}/skills/hub/installs/${seg(jobId)}`
          : `${prof}/curator/runs/${seg(jobId)}`,
        token,
      ),
    curator: () => call(`${prof}/curator`, token),
    setCuratorPaused: (paused, actor) =>
      call(`${prof}/curator/paused`, token, { method: "PUT", body: { paused }, ...as(actor) }),
    runCurator: (actor) =>
      call(`${prof}/curator/runs`, token, { method: "POST", body: {}, ...as(actor) }),
    graph: (includeMemory) =>
      call(`${prof}/learning/graph${query({ includeMemory: includeMemory ? 1 : 0 })}`, token),
    node: (id) => call(`${prof}/learning/node${query({ id })}`, token),
    putNode: (body, actor) =>
      call(`${prof}/learning/node`, token, { method: "PUT", body, ...as(actor) }),
    deleteNode: (body, actor) =>
      call(`${prof}/learning/node`, token, { method: "DELETE", body, ...as(actor) }),
  };

  const mcpRoot = `${prof}/mcp`;
  const server = (name: string, suffix = "") => `${mcpRoot}/servers/${seg(name)}${suffix}`;

  const mcp: McpAdminApi = {
    list: () => call(`${mcpRoot}/servers`, token),
    detail: (name) => call(server(name), token),
    create: (body, actor) =>
      call(`${mcpRoot}/servers`, token, { method: "POST", body, ...as(actor) }),
    update: (name, body, actor) => call(server(name), token, { method: "PUT", body, ...as(actor) }),
    remove: (name, actor) => call(server(name), token, { method: "DELETE", ...as(actor) }),
    setEnabled: (name, enabled, actor) =>
      call(server(name, "/enabled"), token, { method: "PUT", body: { enabled }, ...as(actor) }),
    setTrust: (name, trust, actor) =>
      call(server(name, "/trust"), token, { method: "PUT", body: { trust }, ...as(actor) }),
    setTools: (name, body, actor) =>
      call(server(name, "/tools"), token, { method: "PUT", body, ...as(actor) }),
    putSecret: (name, key, value, actor) =>
      call(server(name, `/secrets/${seg(key)}`), token, {
        method: "PUT",
        body: { value },
        ...as(actor),
      }),
    deleteSecret: (name, key, actor) =>
      call(server(name, `/secrets/${seg(key)}`), token, { method: "DELETE", ...as(actor) }),
    test: (name, actor) =>
      call(server(name, "/test"), token, { method: "POST", body: {}, ...as(actor) }),
    job: (jobId) => call(`${mcpRoot}/jobs/${seg(jobId)}`, token),
    tools: (name) => call(server(name, "/tools"), token),
    oauthStart: (name, actor, opts) =>
      call(server(name, "/oauth"), token, {
        method: "POST",
        body: opts?.restart ? { restart: true } : {},
        ...as(actor),
      }),
    oauthCallback: (sessionId, body, actor) =>
      call(`${mcpRoot}/oauth/${seg(sessionId)}/callback`, token, {
        method: "POST",
        body,
        ...as(actor),
      }),
    oauthPoll: (sessionId) => call(`${mcpRoot}/oauth/${seg(sessionId)}`, token),
    oauthCancel: (sessionId, actor) =>
      call(`${mcpRoot}/oauth/${seg(sessionId)}`, token, { method: "DELETE", ...as(actor) }),
    catalog: () => call(`${mcpRoot}/catalog`, token),
    catalogInstall: (entry, body, actor) =>
      call(`${mcpRoot}/catalog/${seg(entry)}/install`, token, {
        method: "POST",
        body,
        ...as(actor),
      }),
    reload: (actor) => call(`${mcpRoot}/reload`, token, { method: "POST", body: {}, ...as(actor) }),
    exportServer: (name) => call(`${mcpRoot}/export/${seg(name)}`, token),
  };

  const policy = `${prof}/approval-policy`;
  const approvals: ApprovalPolicyApi = {
    getPolicy: () => call(policy, token),
    setModes: (body, actor) => call(policy, token, { method: "PUT", body, ...as(actor) }),
    addAllowlist: (entry, actor) =>
      call(`${policy}/allowlist`, token, { method: "POST", body: { entry }, ...as(actor) }),
    // The entry travels in the body: it may contain `/` or spaces.
    removeAllowlist: (entry, actor) =>
      call(`${policy}/allowlist`, token, { method: "DELETE", body: { entry }, ...as(actor) }),
  };

  const sessions: SessionApi = {
    sources: (sessionId) => call(`${prof}/sessions/${seg(sessionId)}/sources`, token),
  };

  const askUser: AskUserApi = {
    registerSession: (sessionId, context) =>
      call(`${prof}/ask-user/sessions`, token, {
        method: "POST",
        body: { session_id: sessionId, context },
      }),
    listQuestions: (sessionId) =>
      call(`${prof}/questions${query({ session_id: sessionId })}`, token),
    answer: (questionId, response) =>
      call(`${prof}/questions/${seg(questionId)}/answer`, token, {
        method: "POST",
        body: { response },
      }),
  };

  return { profileName: input.profileName, cron, skills, mcp, approvals, sessions, askUser };
}
