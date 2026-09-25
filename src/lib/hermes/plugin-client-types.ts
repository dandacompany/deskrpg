import type { WorkerPluginResult } from "./worker-plugin";
/** Pure plugin contracts shared by server clients and browser components. */
import type { PluginFailure } from "./plugin-errors";
import type {
  ArtifactDetail,
  ArtifactPage,
  ArtifactVersion,
  WorkerPluginCreateResult,
} from "./deskrpg-plugin-types";

export type PluginResponse<T> =
  { ok: true; data: T } | { ok: false; failure: PluginFailure; status: number };

export type RawPluginResponse =
  { ok: true; response: Response } | { ok: false; failure: PluginFailure; status: number };

export type ArtifactListQuery = {
  profiles: string[];
  board?: string;
  kind?: string;
  source?: string;
  q?: string;
  cursor?: string;
  limit?: number;
  taskId?: string;
};

export type ArtifactsApi = {
  list(query: ArtifactListQuery): Promise<PluginResponse<ArtifactPage>>;
  get(id: string): Promise<PluginResponse<ArtifactDetail>>;
  content(
    id: string,
    version: number,
    opts: { download?: boolean; range?: string | null },
  ): Promise<RawPluginResponse>;
  addVersion(
    id: string,
    body: { content: string; filename: string; note?: string },
    user: string,
  ): Promise<PluginResponse<{ version: ArtifactVersion }>>;
  remove(id: string, user: string): Promise<PluginResponse<{ ok: true }>>;
};

export type IdentityPayload = {
  body: string | null;
  isDefaultTemplate: boolean | null;
  revision: string | null;
  unreadable?: boolean;
};

export type CreateProfilePayload = {
  name: string;
  apiKey?: string;
  keyIssued: boolean;
  keyError?: string;
  cloned?: { configKeys: string[]; envKeys: string[]; keyScope: CloneKeyScope };
  needsLogin?: string[];
  cloneError?: string;
  /** 0.12.0+ worker plugin apply result; in 0.16.0 it's `{ skipped }` when the opt-in is off. */
  workerPlugin?: WorkerPluginCreateResult;
};

// ---------------------------------------------------------------------------
// Staff settings picker (plugin 0.9.0) — toolset and skill lists, cloning when creating a profile.
// ---------------------------------------------------------------------------

export type ToolsetRow = {
  name: string;
  label: string;
  description: string;
  enabled: boolean;
  configured: boolean | null;
  /** 0.10.0 — whether this toolset picks a provider (TOOL_CATEGORIES of `hermes tools`). Absent in older versions. */
  hasProviders?: boolean;
};

/** Tool provider row (plugin 0.10.0). Key values never come back — only whether they're set. */
export type ToolProviderRow = {
  name: string;
  badge: string;
  tag: string;
  envVars: Array<{ key: string; prompt: string; url: string | null; isSet: boolean }>;
  active: boolean;
  status: "ready" | "needs_keys" | "needs_auth" | "needs_setup";
  /** none: just pick it · keys: needs keys · cli: must be installed and logged in on the server */
  setup: "none" | "keys" | "cli";
};

export type ToolProvidersPayload = {
  toolset: string;
  hasProviders: boolean;
  providers: ToolProviderRow[];
  activeProvider: string | null;
  cliCommand: string;
};

export type ToolProviderSelectResult = { provider: string; isSet: Record<string, boolean> };

export type ToolsetsPayload = { platform: string; toolsets: ToolsetRow[] };

/** 0.15.0 NPC skill management contract (plugin `profile_skill_admin`). */
export type SkillSource = "local" | "hub" | "bundled" | "external";

export type SkillRow = {
  name: string;
  category: string;
  description: string;
  disabled: boolean;
  essential: boolean;
  /** 0.15.0+ — absent means an old plugin. */
  source?: SkillSource;
  curatorManaged?: boolean;
  state?: "active" | "stale";
  pinned?: boolean;
  useCount?: number;
  viewCount?: number;
  lastUsedAt?: string | null;
};

export type SkillFileEntry = { path: string; size: number; editable: boolean };
export type SkillDetail = {
  skill: {
    name: string;
    source: SkillSource;
    curatorManaged: boolean;
    pinned: boolean;
    frontmatter: Record<string, string>;
  };
  files: SkillFileEntry[];
};
export type SkillFile = { path: string; content: string; hash: string };
export type ArchivedSkill = { name: string; archivedAt: string | null };
export type HubSearchResult = {
  identifier: string;
  name: string;
  description: string;
  source: string;
  trustLevel: string;
};
export type HubPreview = {
  name: string;
  identifier: string;
  description: string;
  source: string;
  trustLevel: string;
  skillMd: string;
  files: string[];
  hasScripts: boolean;
  verdict: string;
  policy: "allow" | "ask" | "block";
  policyReason: string;
};
export type SkillJob = {
  jobId: string;
  kind: "hub_install" | "hub_update" | "curator_run";
  state: "running" | "succeeded" | "failed";
  exitCode: number | null;
  outputTail: string;
};
export type CuratorStatus = {
  enabled: boolean;
  paused: boolean;
  intervalHours: number | null;
  lastRunAt: string | null;
  minIdleHours: number | null;
  staleAfterDays: number | null;
  archiveAfterDays: number | null;
};
export type LearningNode = {
  id: string;
  label: string;
  kind: "skill" | "memory";
  timestamp?: number | null;
  category?: string;
};
export type LearningGraph = {
  nodes: LearningNode[];
  edges: { source: string; target: string }[];
  memory?: unknown[];
  stats: Record<string, unknown>;
};
export type LearningNodeDetail = {
  id: string;
  kind: "skill" | "memory";
  content: string;
  hash: string;
};

export type SkillAdminApi = {
  list(): Promise<PluginResponse<SkillsPayload>>;
  detail(name: string): Promise<PluginResponse<SkillDetail>>;
  readFile(name: string, path: string): Promise<PluginResponse<SkillFile>>;
  writeFile(
    name: string,
    body: { path: string; content: string; baseHash: string | null },
    actor: string,
  ): Promise<PluginResponse<{ path: string; hash: string }>>;
  create(
    body: { name: string; category?: string; content: string },
    actor: string,
  ): Promise<PluginResponse<{ name: string }>>;
  setEnabled(
    name: string,
    enabled: boolean,
    actor: string,
  ): Promise<PluginResponse<{ name: string; enabled: boolean }>>;
  setEnabledBulk(
    body: { enable: string[]; disable: string[] },
    actor: string,
  ): Promise<PluginResponse<{ disabled: string[] }>>;
  setPinned(
    name: string,
    pinned: boolean,
    actor: string,
  ): Promise<PluginResponse<{ name: string; pinned: boolean }>>;
  archive(name: string, actor: string): Promise<PluginResponse<{ name: string }>>;
  listArchived(): Promise<PluginResponse<{ archived: ArchivedSkill[] }>>;
  restore(name: string, actor: string): Promise<PluginResponse<{ name: string }>>;
  purge(
    name: string,
    actor: string,
  ): Promise<PluginResponse<{ name: string; ledgerId: string | null }>>;
  hubSearch(
    q: string,
    source?: string,
  ): Promise<PluginResponse<{ results: HubSearchResult[]; timedOut: string[] }>>;
  hubPreview(identifier: string): Promise<PluginResponse<HubPreview>>;
  hubInstall(
    body: { identifier: string; force?: boolean },
    actor: string,
  ): Promise<PluginResponse<{ jobId: string }>>;
  hubUninstall(name: string, actor: string): Promise<PluginResponse<{ jobId: string }>>;
  hubUpdate(name: string | null, actor: string): Promise<PluginResponse<{ jobId: string }>>;
  job(kind: "hub" | "curator", jobId: string): Promise<PluginResponse<SkillJob>>;
  curator(): Promise<PluginResponse<CuratorStatus>>;
  setCuratorPaused(paused: boolean, actor: string): Promise<PluginResponse<{ paused: boolean }>>;
  runCurator(actor: string): Promise<PluginResponse<{ jobId: string }>>;
  graph(includeMemory: boolean): Promise<PluginResponse<LearningGraph>>;
  node(id: string): Promise<PluginResponse<LearningNodeDetail>>;
  putNode(
    body: { id: string; content: string; baseHash: string },
    actor: string,
  ): Promise<PluginResponse<{ id: string; hash: string }>>;
  deleteNode(
    body: { id: string; baseHash: string },
    actor: string,
  ): Promise<PluginResponse<{ id: string; kind: string; result: string }>>;
};

export type SkillsPayload = { skills: SkillRow[] };

/**
 * Key cloning scope (plugin 0.9.0 `cloneKeys`). `referenced` clones only the keys of providers the cloned config
 * points to; `api_keys` clones all API-key-style provider keys (excluding generic and OAuth tokens) plus the
 * referenced ones. Defaults to referenced.
 */
export type CloneKeyScope = "referenced" | "api_keys";

export type CreateProfileOptions = { cloneFrom?: "default"; cloneKeys?: CloneKeyScope };

export type DeleteProfilePayload = {
  name: string;
  removed: { profileDir: boolean; wrapperScript: boolean };
};

export type CatalogPayload = {
  providers: Array<{
    id: string;
    name: string;
    authenticated: boolean;
    authType?: ProviderAuthType;
    envVars?: string[];
    cliCommand?: string | null;
  }>;
  models: Record<string, string[]>;
  reasoningEfforts: string[];
};

// ---------------------------------------------------------------------------
// Provider auth (plugin 0.9.0) — OAuth device login · API key entry.
// ---------------------------------------------------------------------------

export type ProviderAuthType = "api_key" | "oauth_device" | "external";

export type OAuthStartPayload = {
  sessionId: string;
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
  pollInterval: number;
};

export type OAuthPollPayload = {
  status: "pending" | "approved" | "denied" | "expired" | "error";
  error: string | null;
  expiresAt: number | null;
  retryable: boolean | null;
  retryAfter: number | null;
};

export type ProviderKeyPayload = {
  configured: boolean;
  envVar?: string;
  removed?: string[];
};

export type PluginClient = {
  listProfiles(): Promise<PluginResponse<{ profiles: unknown[] }>>;
  /** 0.12.0 — also installs the plugin in profile homes where kanban workers/crons run (owner key). No names = all. */
  ensureWorkerPlugin(
    profiles?: string[],
  ): Promise<PluginResponse<{ results: WorkerPluginResult[] }>>;
  createProfile(
    name: string,
    options?: CreateProfileOptions,
  ): Promise<PluginResponse<CreateProfilePayload>>;
  deleteProfile(name: string): Promise<PluginResponse<DeleteProfilePayload>>;
  getIdentity(name: string, profileToken: string): Promise<PluginResponse<IdentityPayload>>;
  putIdentity(
    name: string,
    profileToken: string,
    input: { body: string; ifRevision: string },
  ): Promise<PluginResponse<{ revision: string }>>;
  getConfig(name: string, profileToken: string): Promise<PluginResponse<Record<string, unknown>>>;
  getCatalog(name: string, profileToken: string): Promise<PluginResponse<CatalogPayload>>;
  putConfig(
    name: string,
    profileToken: string,
    patch: Record<string, unknown>,
  ): Promise<PluginResponse<Record<string, unknown>>>;
  // Staff settings picker (0.9.0). Profile scope — skill folders and key settings differ per profile.
  getToolsets(name: string, profileToken: string): Promise<PluginResponse<ToolsetsPayload>>;
  getSkills(name: string, profileToken: string): Promise<PluginResponse<SkillsPayload>>;
  // Per-tool providers (0.10.0). Profile scope — keys are write-only.
  getToolProviders(
    name: string,
    profileToken: string,
    toolset: string,
  ): Promise<PluginResponse<ToolProvidersPayload>>;
  putToolProvider(
    name: string,
    profileToken: string,
    toolset: string,
    body: { provider: string; env: Record<string, string> },
  ): Promise<PluginResponse<ToolProviderSelectResult>>;
  // Provider auth (0.9.0). All profile scope — the gateway owner permission check belongs to the route layer.
  startOAuth(
    name: string,
    profileToken: string,
    provider: string,
  ): Promise<PluginResponse<OAuthStartPayload>>;
  pollOAuth(
    name: string,
    profileToken: string,
    provider: string,
    sessionId: string,
  ): Promise<PluginResponse<OAuthPollPayload>>;
  cancelOAuth(
    name: string,
    profileToken: string,
    sessionId: string,
  ): Promise<PluginResponse<{ ok: boolean }>>;
  disconnectOAuth(
    name: string,
    profileToken: string,
    provider: string,
  ): Promise<PluginResponse<{ ok: boolean }>>;
  putProviderKey(
    name: string,
    profileToken: string,
    provider: string,
    value: string,
  ): Promise<PluginResponse<ProviderKeyPayload>>;
  deleteProviderKey(
    name: string,
    profileToken: string,
    provider: string,
  ): Promise<PluginResponse<ProviderKeyPayload>>;
};

// ---------------------------------------------------------------------------
// Automation contract (v0.6.0+) — kanban and events (owner key) / cron (profile key)
//
// The two scopes are split into **separate clients**. `PluginClient` takes a token per method, which
// left room for callers to mix them up; since kanban takes only the owner key and cron only the profile key,
// fixing the token at creation time removes the place to mix them up entirely.
// ---------------------------------------------------------------------------

import type {
  AutomationBlueprint,
  Blackboard,
  BoardMeta,
  CreateBoardBody,
  CreateCronJobBody,
  CreateTaskBody,
  CronDeliveryTarget,
  CronJob,
  CronRun,
  DispatchResult,
  EventsPage,
  InstantiateBlueprintBody,
  KanbanAttachment,
  KanbanBoardAttachmentsPage,
  KanbanBoard,
  KanbanComment,
  KanbanLinksPage,
  KanbanProfileSummary,
  KanbanRunsPage,
  KanbanTask,
  KanbanTaskAction,
  KanbanTaskDetail,
  OrchestrationSettings,
  PluginInfo,
  SwarmCreated,
  SwarmRequest,
  UpdateBoardBody,
  UpdateCronJobBody,
  UpdateOrchestrationBody,
  UpdateTaskBody,
  WorkerLog,
} from "./deskrpg-plugin-types";

/** Body per card action. Actions other than reassign, request-changes, and unblock are an empty object. */
export type KanbanTaskActionInput<A extends KanbanTaskAction> = A extends "approve"
  ? { submission_id?: string; request_id?: string }
  : A extends "reassign"
    ? { profile: string; reclaim_first: true }
    : A extends "request-changes"
      ? { comment: string }
      : A extends "unblock"
        ? { comment?: string }
        : Record<string, never>;

export type KanbanApi = {
  listBoards(): Promise<PluginResponse<{ boards: BoardMeta[]; current: string | null }>>;
  createBoard(body: CreateBoardBody): Promise<PluginResponse<{ board: BoardMeta }>>;
  updateBoard(slug: string, body: UpdateBoardBody): Promise<PluginResponse<{ board: BoardMeta }>>;

  getBoard(
    board: string,
    opts?: { includeArchived?: boolean },
  ): Promise<PluginResponse<KanbanBoard>>;
  getTask(board: string, id: string): Promise<PluginResponse<KanbanTaskDetail>>;
  /** Batched lookup — requires capability `kanban_views` (404 otherwise). */
  listLinks(board: string): Promise<PluginResponse<KanbanLinksPage>>;
  listRuns(
    board: string,
    opts?: { from?: number; to?: number; limit?: number },
  ): Promise<PluginResponse<KanbanRunsPage>>;
  createTask(
    board: string,
    body: CreateTaskBody,
  ): Promise<PluginResponse<{ task: KanbanTask; warning?: string }>>;
  updateTask(
    board: string,
    id: string,
    body: UpdateTaskBody,
  ): Promise<PluginResponse<{ task: KanbanTask }>>;
  deleteTask(board: string, id: string): Promise<PluginResponse<{ ok: true }>>;
  addComment(
    board: string,
    id: string,
    body: { author: string; body: string },
  ): Promise<PluginResponse<{ comment: KanbanComment }>>;
  runTaskAction<A extends KanbanTaskAction>(
    board: string,
    id: string,
    action: A,
    body: KanbanTaskActionInput<A>,
    actor?: { userId: string; name?: string },
  ): Promise<PluginResponse<{ task: KanbanTask }>>;

  listAttachments(
    board: string,
    id: string,
  ): Promise<PluginResponse<{ attachments: KanbanAttachment[] }>>;
  /** Board-wide attachments — requires capability `kanban_attachment_list` (404 otherwise). */
  listBoardAttachments(
    board: string,
    opts?: { limit?: number; cursor?: string },
  ): Promise<PluginResponse<KanbanBoardAttachmentsPage>>;
  uploadAttachment(
    board: string,
    id: string,
    file: { filename: string; content: Blob | string },
  ): Promise<PluginResponse<{ attachment: KanbanAttachment }>>;
  attachmentContent(
    board: string,
    attachmentId: string,
    opts: { range?: string | null },
  ): Promise<RawPluginResponse>;
  deleteAttachment(board: string, attachmentId: string): Promise<PluginResponse<{ ok: true }>>;

  addLink(
    board: string,
    body: { parent_id: string; child_id: string },
  ): Promise<PluginResponse<{ ok: true }>>;
  removeLink(
    board: string,
    body: { parent_id: string; child_id: string },
  ): Promise<PluginResponse<{ ok: true }>>;

  dispatch(board: string, opts?: { max?: number }): Promise<PluginResponse<DispatchResult>>;

  createSwarm(board: string, body: SwarmRequest): Promise<PluginResponse<SwarmCreated>>;
  getBlackboard(board: string, taskId: string): Promise<PluginResponse<{ blackboard: Blackboard }>>;

  getTaskLog(
    board: string,
    id: string,
    opts?: { tail?: number },
  ): Promise<PluginResponse<WorkerLog>>;

  getOrchestration(): Promise<PluginResponse<OrchestrationSettings>>;
  updateOrchestration(
    body: UpdateOrchestrationBody,
  ): Promise<PluginResponse<OrchestrationSettings>>;
  listProfiles(): Promise<PluginResponse<{ profiles: KanbanProfileSummary[] }>>;
};

export type EventsApi = {
  /** Merges k/d of the new receiving board and c/a of the previous receiving board on the server. */
  handoff(body: {
    board: string;
    board_cursor: string | null;
    carrier_cursor: string;
  }): Promise<PluginResponse<{ cursor: string }>>;
  /**
   * Called without a cursor, it returns only a "now" token with no events — from the next call with that token
   * you receive new events. An unknown cursor collapses to 400 `unknown_cursor`.
   */
  poll(opts: {
    board?: string;
    cursor?: string;
    limit?: number;
    include?: string;
  }): Promise<PluginResponse<EventsPage>>;
};

/**
 * Card proposals (plugin `card_proposals` capability). The plugin is the authority on proposals; DeskRPG
 * calls only resolve-marking and its undo — it doesn't use the proposal list/lookup routes.
 */
export type CardProposalsApi = {
  /** 200 `{resolved:true}` · 409 `card_proposal_already_resolved` · 404 · 400 `invalid_field`. */
  resolve(
    proposalId: string,
    body: { choice: "card" | "inline"; task_id?: string },
  ): Promise<PluginResponse<{ resolved: true }>>;
  /**
   * 200 `{resolved:false}` · 409 `card_proposal_not_unresolvable` (unresolved, or the card was already
   * recorded) · 404. No body.
   */
  unresolve(proposalId: string): Promise<PluginResponse<{ resolved: false }>>;
  /**
   * Records the card id on a resolved proposal **once** — after that `unresolve` is blocked with 409.
   * Resolving (`resolve`) happens before card creation, so `task_id` is filled only through this path.
   * 200 `{recorded:true}` · 409 `card_proposal_task_not_recordable` (unresolved or already recorded)
   * · 404 · 400 `invalid_field`. Cannot be overwritten.
   */
  recordTask(
    proposalId: string,
    body: { task_id: string },
  ): Promise<PluginResponse<{ recorded: true }>>;
};

export type OwnerPluginClient = {
  info(): Promise<PluginResponse<PluginInfo>>;
  kanban: KanbanApi;
  events: EventsApi;
  artifacts: ArtifactsApi;
  cardProposals: CardProposalsApi;
};

export type CronApi = {
  listJobs(opts?: { includeDisabled?: boolean }): Promise<PluginResponse<{ jobs: CronJob[] }>>;
  getJob(id: string): Promise<PluginResponse<{ job: CronJob }>>;
  listRuns(id: string, opts?: { limit?: number }): Promise<PluginResponse<{ runs: CronRun[] }>>;
  createJob(body: CreateCronJobBody): Promise<PluginResponse<{ job: CronJob }>>;
  updateJob(id: string, body: UpdateCronJobBody): Promise<PluginResponse<{ job: CronJob }>>;
  pauseJob(id: string): Promise<PluginResponse<{ job: CronJob }>>;
  resumeJob(id: string): Promise<PluginResponse<{ job: CronJob }>>;
  /** Async execution — 202 `{accepted:true}` is success. */
  runJob(id: string): Promise<PluginResponse<{ accepted: true }>>;
  deleteJob(id: string): Promise<PluginResponse<{ ok: true }>>;
  listDeliveryTargets(): Promise<PluginResponse<{ targets: CronDeliveryTarget[] }>>;
  listBlueprints(): Promise<PluginResponse<{ blueprints: AutomationBlueprint[] }>>;
  instantiateBlueprint(body: InstantiateBlueprintBody): Promise<PluginResponse<{ job: CronJob }>>;
};

// ---------------------------------------------------------------------------
// 0.17.0 — NPC MCP connectors (`/p/{profile}/deskrpg/mcp/**`, capability `profile_mcp_admin`)
// ---------------------------------------------------------------------------

export type McpTransport = "http" | "stdio";

/** One server row. Carries no secret values, URL query strings, or command arguments. */
export type McpServerView = {
  name: string;
  kind: "catalog" | "custom" | "plugin";
  transport: McpTransport;
  endpointSummary: string;
  enabled: boolean;
  trust: "full" | "untrusted";
  auth: "none" | "bearer" | "oauth" | "env";
  secrets: { key: string; hasValue: boolean }[];
  oauthTokenPresent: boolean;
  tools: { total: number; enabled: number } | null;
  lastCheck: { at: string; ok: boolean; error?: string } | null;
  revision: string;
};

/** Owner-only detail — adds the command, arguments, and env/header *names* (never values). */
export type McpServerDetail = McpServerView & {
  url: string | null;
  command: string | null;
  args: string[];
  cwd: string | null;
  envKeys: string[];
  headerKeys: string[];
  toolFilter: { include?: string[]; exclude?: string[] };
};

export type McpTool = {
  name: string;
  description: string;
  readOnlyHint: boolean | null;
  destructiveHint: boolean | null;
  on: boolean;
};

export type McpJob = {
  jobId: string;
  state: "running" | "succeeded" | "failed";
  ok?: boolean;
  tools?: McpTool[];
  error?: string;
};

export type McpCatalogEntry = {
  name: string;
  description: string;
  transport: McpTransport;
  installed: boolean;
  requiredEnv: { name: string; prompt: string; required: boolean; secret: boolean }[];
};

export type McpServerInput = {
  name?: string;
  transport?: McpTransport;
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  /** Only the keys matter — the plugin stores each as a `${KEY}` reference and ignores values. */
  env?: Record<string, string>;
  passthroughEnv?: string[];
  cwd?: string;
  auth?: "none" | "bearer" | "oauth" | "env";
  trust?: "full" | "untrusted";
  /** Required (= name) for a new stdio server or a change to its command. */
  confirmName?: string;
  baseRevision?: string;
};

export type McpExport = {
  name: string;
  entry: Record<string, unknown>;
  secretKeys: string[];
  oauth: boolean;
  /** True when the plugin removed a query string from `entry.url` (it may carry a token). */
  urlQueryDropped?: boolean;
};

export type McpOAuthStart = { sessionId: string; authUrl: string } | { status: "approved" };
export type McpOAuthPoll = {
  status: "pending" | "approved" | "error";
  error?: string;
  tools?: string[];
};
export type McpReload = { reloaded: true; servers: string[]; agentsRefreshed: boolean };

export type McpAdminApi = {
  list(): Promise<PluginResponse<{ servers: McpServerView[] }>>;
  detail(name: string): Promise<PluginResponse<McpServerDetail>>;
  create(body: McpServerInput, actor: string): Promise<PluginResponse<McpServerView>>;
  update(name: string, body: McpServerInput, actor: string): Promise<PluginResponse<McpServerView>>;
  remove(name: string, actor: string): Promise<PluginResponse<{ ok: true }>>;
  setEnabled(name: string, enabled: boolean, actor: string): Promise<PluginResponse<McpServerView>>;
  setTrust(
    name: string,
    trust: "full" | "untrusted",
    actor: string,
  ): Promise<PluginResponse<McpServerView>>;
  setTools(
    name: string,
    body: { include?: string[]; exclude?: string[]; baseRevision: string },
    actor: string,
  ): Promise<PluginResponse<McpServerView>>;
  putSecret(
    name: string,
    key: string,
    value: string,
    actor: string,
  ): Promise<PluginResponse<{ key: string; hasValue: boolean }>>;
  deleteSecret(
    name: string,
    key: string,
    actor: string,
  ): Promise<PluginResponse<{ key: string; hasValue: boolean }>>;
  test(name: string, actor: string): Promise<PluginResponse<{ jobId: string }>>;
  job(jobId: string): Promise<PluginResponse<McpJob>>;
  tools(
    name: string,
  ): Promise<PluginResponse<{ tools: McpTool[]; checkedAt: string; revision: string }>>;
  /** `restart` (plugin 0.17.1) cancels the open attempt for this server and waits for it to end first. */
  oauthStart(
    name: string,
    actor: string,
    opts?: { restart?: boolean },
  ): Promise<PluginResponse<McpOAuthStart>>;
  oauthCallback(
    sessionId: string,
    body: { code: string; state: string; iss?: string },
    actor: string,
  ): Promise<PluginResponse<{ ok: true }>>;
  oauthPoll(sessionId: string): Promise<PluginResponse<McpOAuthPoll>>;
  oauthCancel(sessionId: string, actor: string): Promise<PluginResponse<{ ok: boolean }>>;
  catalog(): Promise<PluginResponse<{ entries: McpCatalogEntry[] }>>;
  catalogInstall(
    entry: string,
    body: { env: Record<string, string>; enable?: boolean },
    actor: string,
  ): Promise<PluginResponse<McpServerView>>;
  reload(actor: string): Promise<PluginResponse<McpReload>>;
  exportServer(name: string): Promise<PluginResponse<McpExport>>;
};

export type ProfilePluginClient = {
  profileName: string;
  cron: CronApi;
  /** 0.15.0 `profile_skill_admin` — with an old plugin the call comes back 404. */
  skills: SkillAdminApi;
  /** 0.17.0 `profile_mcp_admin` — with an old plugin the call comes back 404. */
  mcp: McpAdminApi;
};
