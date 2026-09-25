/**
 * Wire types for the `deskrpg-hermes-plugin` automation contract (v0.6.0+).
 *
 * Transcribes the JSON shapes of plugin spec A.1 (owner key scope — kanban, events) and A.2 (profile key scope —
 * cron) **as-is**. Nothing is interpreted here — judgments like card state transition rules,
 * assignee permissions and cursor meaning all belong to the server (DeskRPG) or the plugin; this file
 * only pins the responses as types.
 *
 * Imported by both the browser and the server. Holds **types only** — no values (runtime code).
 * The only exceptions are literal arrays like `KANBAN_TASK_STATUSES`/`CRON_JOB_STATES`, and those are
 * pure constants that pull in no Node-only modules.
 */

// ---------------------------------------------------------------------------
// Common — /deskrpg/info
// ---------------------------------------------------------------------------

/**
 * Body of `GET /deskrpg/info`. Automation turns on only if `capabilities` has kanban, cron and events.
 *
 * `timezone` can be `null` because plugins before 0.6.0 don't send that field —
 * the parser (`parsePluginInfo`) folds old bodies into this shape too and keeps them in the cache.
 */
export type PluginInfo = {
  plugin: "deskrpg";
  version: string;
  capabilities: string[];
  timezone: string | null;
  kanban: { dispatcher_present: boolean; attachments: boolean };
  /**
   * 0.7.1 — Public URL of the Hermes dashboard. null if the dashboard is off or has no URL.
   * The parser keeps only http(s). Older plugins and existing caches lack the key, so it's optional.
   */
  dashboard_url?: string | null;
  /**
   * 0.12.0 — Employees whose plugin doesn't load in kanban workers/cron (`worker-plugin.ts`). Old plugins
   * lack the key (undefined), and a failed check is null. The two are not mixed.
   */
  worker_plugin?: WorkerPluginReport | null;
};

/** Worker plugin status for one employee. `link`: linked · missing · other. */
export type WorkerPluginGap = {
  profile: string;
  link: string;
  enabled: boolean;
  /** Employee disabled by the operator via `plugins.disabled` — applying won't enable it. */
  disabled: boolean;
};

export type WorkerPluginReport = {
  missing: WorkerPluginGap[];
  /**
   * 0.16.0 — Worker propagation opt-in state. When `disabled`, the plugin doesn't link/enable itself on new profiles
   * and `POST /deskrpg/worker-plugin` returns 409 `worker_propagation_disabled`. Old plugins lack the key (undefined).
   */
  propagation?: WorkerPropagation;
};

/** 0.16.0 worker propagation opt-in. The operator turns it on via a root `config.yaml` setting key or env var
 * (off by default). */
export type WorkerPropagation = "enabled" | "disabled";
export const WORKER_PROPAGATION_DISABLED = "worker_propagation_disabled";
export const WORKER_PROPAGATION_CONFIG_KEY = "plugins.entries.deskrpg.worker_propagation";
export const WORKER_PROPAGATION_ENV = "DESKRPG_WORKER_PROPAGATION";
export const WORKER_PROPAGATION_ENABLE_COMMAND = `hermes config set ${WORKER_PROPAGATION_CONFIG_KEY} true`;
export const WORKER_PROPAGATION_MIN_VERSION = "0.16.0";

/** `workerPlugin` in the profile creation response — the apply result or the 0.16.0 skip. */
export type WorkerPluginCreateResult =
  | { profile: string; link: string; enabled: string }
  | { skipped: "propagation_disabled" }
  | { error: string };

// ---------------------------------------------------------------------------
// A.1 Kanban — boards, cards
// ---------------------------------------------------------------------------

export const KANBAN_TASK_STATUSES = [
  "triage",
  "todo",
  "scheduled",
  "ready",
  "running",
  "blocked",
  "review",
  "done",
  "archived",
] as const;

export type KanbanTaskStatus = (typeof KANBAN_TASK_STATUSES)[number];

export type BoardMeta = {
  slug: string;
  name?: string;
  description?: string;
  is_current?: boolean;
  total?: number;
  default_workdir?: string;
  default_workspace_kind?: string;
  project_id?: string;
  project_name?: string;
};

export type DiagnosticAction = {
  kind: string;
  label: string;
  payload?: Record<string, unknown>;
  suggested?: boolean;
};

export type Diagnostic = {
  kind: string;
  severity: "critical" | "error" | "warning";
  title: string;
  detail: string;
  actions: DiagnosticAction[];
  count: number;
  last_seen_at: string;
  data: Record<string, unknown>;
};

/**
 * Timestamps sent by the plugin. **Epoch seconds (integer) is canonical** (plugin `docs/contracts.md`), while the
 * fake plugin server sends ISO strings. Read with `taskTimeMs()` — calling `Date.parse`
 * directly yields NaN on integers and the time silently disappears.
 */
export type PluginTime = string | number;

/** Card summary carried in a board column. */
export type KanbanReviewPolicy = {
  version: 1;
  mode: "human" | "agent";
  reviewer_profile: string | null;
};

export type KanbanReviewState = {
  policy: KanbanReviewPolicy;
  policy_revision: number;
  submission: null | {
    id: string;
    run_id: string | number | null;
    hash: string;
    policy_revision: number;
  };
  review_round: number;
  state: "awaiting_submission" | "submitted" | "reviewing" | "human_required" | "approved";
  reason: string | null;
  approval: null | {
    actor_kind: "human" | "agent";
    actor_id: string;
    actor_name?: string;
    submission_id: string;
    policy_revision: number;
    hash: string;
    approved_at: number;
    request_id: string | null;
  };
};

export type KanbanTask = {
  review?: KanbanReviewState | null;
  id: string;
  title: string;
  body?: string;
  status: KanbanTaskStatus;
  assignee?: string;
  priority?: string;
  tenant?: string;
  created_at?: PluginTime;
  latest_summary?: string;
  comment_count?: number;
  link_counts?: { parents: number; children: number };
  progress?: { done: number; total: number };
  warnings?: { count: number; highest_severity?: string };
  started_at?: PluginTime;
  worker_pid?: number;
  last_heartbeat_at?: PluginTime;
};

/** Full shape including fields that only come from card detail (`GET /kanban/tasks/{id}`). */
export type KanbanTaskFull = KanbanTask & {
  result?: string;
  created_by?: string;
  model_override?: string;
  provider_override?: string;
  reasoning_effort?: string;
  completed_at?: PluginTime;
  last_failure_error?: string;
  workspace_kind?: string;
  workspace_path?: string;
  branch_name?: string;
  consecutive_failures?: number;
  diagnostics?: Diagnostic[];
};

export type KanbanRun = {
  id: string;
  profile?: string;
  status: string;
  outcome?: string;
  summary?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  worker_pid?: number;
  started_at?: PluginTime;
  ended_at?: PluginTime;
};

export type KanbanComment = {
  id: string;
  author: string;
  body: string;
  created_at: PluginTime;
};

/** Per-card history carried in card detail. A different shape from the unified event stream (`Event`). */
export type KanbanEvent = {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  created_at: PluginTime;
};

export type KanbanAttachment = {
  id: string;
  filename: string;
  size?: number;
};

/**
 * One entry of the board-wide attachment list (`GET /deskrpg/kanban/attachments`, capability `kanban_attachment_list`).
 * Same shape as a single card's attachment plus **which card it belongs to**. If the card was deleted,
 * `task_title` may be null (plugin contract).
 */
export type KanbanBoardAttachment = KanbanAttachment & {
  content_type?: string | null;
  created_at?: number | null;
  task_id: string;
  task_title: string | null;
};
export type KanbanBoardAttachmentsPage = {
  attachments: KanbanBoardAttachment[];
  next_cursor: string | null;
};

export type KanbanColumn = {
  name: string;
  tasks: KanbanTask[];
};

export type KanbanBoard = {
  columns: KanbanColumn[];
  tenants: string[];
  assignees: string[];
  latest_event_id: string | null;
  now: PluginTime;
};

/**
 * Run records for the timeline (`GET /kanban/runs`, capability `kanban_views`).
 *
 * Broader than per-card `runs[]` (`KanbanRun`) — which card, subproject and board a run belongs to must be
 * clear from the response alone, so no rejoining with the card list. Runs of deleted cards remain too, so
 * `tenant`/`task_title` may be absent (the fact that work happened doesn't go away).
 */
export type KanbanTimelineRun = KanbanRun & {
  task_id: string;
  board: string;
  task_title?: string;
  tenant?: string;
  step_key?: string;
};

/** Body of `GET /kanban/runs`. `window` is in epoch seconds. */
export type KanbanRunsPage = {
  runs: KanbanTimelineRun[];
  board: string;
  window: { from: number; to: number };
  /**
   * Whether the cap was hit and **only the most recent** remain. The screen must show this — drawing a truncated
   * window as-is reads as "nobody worked in that time range".
   */
  truncated: boolean;
};

/** Body of `GET /kanban/links`. Only pairs come — the source of truth for card bodies is the board response. */
export type KanbanLinksPage = {
  links: Array<{ parent_id: string; child_id: string }>;
  board: string;
};

export type KanbanTaskDetail = {
  task: KanbanTaskFull;
  comments: KanbanComment[];
  events: KanbanEvent[];
  /** null if the plugin has no attachment feature (`info.kanban.attachments === false`) */
  attachments: KanbanAttachment[] | null;
  links: { parents: string[]; children: string[] };
  runs: KanbanRun[];
};

export type WorkspaceKind = "scratch" | "worktree" | "dir";

export type CreateTaskBody = {
  review_policy?: KanbanReviewPolicy;
  title: string;
  body?: string;
  assignee?: string;
  tenant?: string;
  priority?: string;
  workspace_kind?: WorkspaceKind;
  workspace_path?: string;
  parents?: string[];
  triage?: boolean;
  idempotency_key?: string;
  max_runtime_seconds?: number;
  skills?: string[];
  goal_mode?: boolean;
  goal_max_turns?: number;
  model_override?: string;
  provider_override?: string;
  reasoning_effort?: string;
  project_id?: string;
  /**
   * Status that can only be set at creation time. The plugin only accepts `{"running","blocked"}`.
   * `blocked` is sticky in Hermes, so it isn't dispatched until a person releases it —
   * the slot used by the pre-run approval gate (`triage` can't be used since the gateway auto-decomposes it).
   */
  initial_status?: "running" | "blocked";
};

/** `PATCH /kanban/tasks/{id}` — partial update. */
export type UpdateTaskBody = Partial<Omit<CreateTaskBody, "idempotency_key">> & {
  status?: KanbanTaskStatus;
  expected_revision?: number;
};

export type CreateBoardBody = {
  slug: string;
  name: string;
  default_workdir?: string;
};

export type UpdateBoardBody = {
  name?: string;
  description?: string;
  default_workdir?: string;
};

/** Set of action names for `POST /kanban/tasks/{id}/{action}`. */
export const KANBAN_TASK_ACTIONS = [
  "reassign",
  "reclaim",
  "specify",
  "decompose",
  "estimate",
  "approve",
  "request-changes",
  "unblock",
  "terminate",
  "archive",
] as const;

export type KanbanTaskAction = (typeof KANBAN_TASK_ACTIONS)[number];

export type OrchestrationSettings = {
  orchestrator_profile: string | null;
  default_assignee: string | null;
  auto_decompose: boolean;
  resolved_orchestrator_profile: string | null;
  resolved_default_assignee: string | null;
  max_in_progress?: number;
  max_in_progress_per_profile?: number;
};

export type UpdateOrchestrationBody = {
  orchestrator_profile?: string | null;
  default_assignee?: string | null;
  auto_decompose?: boolean;
  max_in_progress?: number;
  max_in_progress_per_profile?: number;
};

export type WorkerLog = {
  exists: boolean;
  size_bytes: number;
  content: string;
  truncated: boolean;
};

export type KanbanProfileSummary = {
  name: string;
  is_default: boolean;
  description: string;
};

export type DispatchResult = {
  spawned: Array<{ task_id: string; profile?: string; run_id?: string }>;
};

// ---------------------------------------------------------------------------
// A.1 Unified events — /deskrpg/events
// ---------------------------------------------------------------------------

export const PLUGIN_EVENT_KINDS = [
  "task.created",
  "task.status",
  "task.comment",
  "task.run.started",
  "task.run.finished",
  "task.deleted",
  "task.link",
  "task.updated",
  "cron.run.started",
  "cron.run.finished",
  "artifact.created",
  "artifact.versioned",
  "artifact.deleted",
  "card_proposal.created",
  "approval.blocked",
] as const;

export type PluginEventKind = (typeof PLUGIN_EVENT_KINDS)[number];

/**
 * 0.18.0 — a cron or kanban worker hit a tool approval with nobody to answer
 * (`approvals.cron_mode`/`single_query_mode: deny`, or an untrusted MCP write tool). Opt-in via
 * `include=approvals`. `command` is capped and redacted by the plugin.
 */
export type ApprovalBlockedEventPayload = {
  profile: string;
  source: "cron" | "kanban";
  kind: "command" | "mcp";
  jobId?: string;
  /** 0.18.1 — the cron job's name from the profile's cron/jobs.json. */
  jobName?: string;
  taskId?: string;
  runId?: string;
  tool: string;
  patternKey?: string | null;
  patternDescription?: string | null;
  command?: string;
  mcpServer?: string;
  at: string;
};

/** Title, description, priority, assignee or attachment change — list of changed field names. The screen
 * reflects it by refetching the board. */
export type TaskUpdatedEventPayload = { fields: string[] };

export type TaskStatusEventPayload = {
  from: KanbanTaskStatus | null;
  to: KanbanTaskStatus;
  parent_count: number;
  title: string;
  assignee: string | null;
};

/**
 * A "request worth keeping as a work card" found by an NPC during conversation. It is **not** a card — it's a copy
 * of the Hermes-side proposal record, and whether to register a card is chosen by the user in the room notice.
 * If `body`/`acceptance` are absent, **the key itself is omitted** (not an empty string).
 */
export type CardProposalEventPayload = {
  proposal_id: string;
  title: string;
  summary: string;
  body?: string;
  acceptance?: string;
  profile: string;
};

export type CronRunStartedPayload = {
  job_id: string;
  job_name: string;
  profile: string;
  session_id: string;
  started_at: string;
};

export type CronRunFinishedPayload = CronRunStartedPayload & {
  status: "ok" | "error";
  ended_at: string;
  result_text: string;
};

export type PluginEvent = {
  id: string;
  /** Epoch seconds (all sources, plugin 0.6.0+). The screen converts with epochSecondsToMs */
  ts: number;
  kind: PluginEventKind;
  board?: string;
  task_id?: string;
  profile?: string;
  job_id?: string;
  run_id?: string;
  payload: Record<string, unknown>;
};

export type EventsPage = {
  events: PluginEvent[];
  cursor: string;
  has_more: boolean;
};

// ---------------------------------------------------------------------------
// A.2 Cron — /p/{profile}/deskrpg/cron
// ---------------------------------------------------------------------------

export const CRON_JOB_STATES = [
  "scheduled",
  "paused",
  "running",
  "error",
  "completed",
  "disabled",
] as const;

export type CronJobState = (typeof CRON_JOB_STATES)[number];

export type CronSchedule = {
  kind: string;
  expr?: string;
  minutes?: number;
  run_at?: string;
  display?: string;
};

export type CronJob = {
  id: string;
  name: string;
  prompt: string;
  schedule: CronSchedule;
  schedule_display: string;
  repeat: boolean;
  enabled: boolean;
  state: CronJobState;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  deliver: string | null;
  skills: string[];
  model: string | null;
  provider: string | null;
  created_at: string;
};

export type CronRun = {
  id: string;
  started_at: string;
  ended_at: string | null;
  status: string;
  summary: string;
  result_text: string;
};

export type CreateCronJobBody = {
  schedule: string;
  /** Required unless it's a script-only job. The server route requires it only when `script` is absent. */
  prompt?: string;
  /** Script-only job — Hermes runs it instead of a prompt. Passed through as-is. */
  script?: string;
  name: string;
  deliver?: string;
  model?: string;
  provider?: string;
  skills?: string[];
  paused?: boolean;
  repeat?: boolean;
};

export type UpdateCronJobBody = {
  updates: {
    schedule?: string;
    prompt?: string;
    name?: string;
    deliver?: string;
    model?: string | null;
    provider?: string | null;
    enabled?: boolean;
  };
};

export type CronDeliveryTarget = {
  id: string;
  name: string;
  home_target_set: boolean;
  home_env_var: string;
};

export type BlueprintField = {
  name: string;
  type: "enum" | "text" | "time" | "weekdays";
  label: string;
  default?: string;
  options?: string[];
  optional?: boolean;
  strict?: boolean;
  help?: string;
};

export type AutomationBlueprint = {
  key: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  fields: BlueprintField[];
  command: string;
  appUrl: string;
};

export type InstantiateBlueprintBody = {
  blueprint: string;
  values: Record<string, string>;
};

// ---------------------------------------------------------------------------
// Swarm (v0.7.0+) — /deskrpg/kanban/swarm, /deskrpg/kanban/tasks/{id}/blackboard
// ---------------------------------------------------------------------------

/** Body of `POST /deskrpg/kanban/swarm`. The profile name is resolved **by the server** from the NPC id. */
export type SwarmRequest = {
  goal: string;
  workers: Array<{ profile: string; title: string; body?: string; skills?: string[] }>;
  verifier: string;
  synthesizer: string;
  tenant?: string | null;
  priority?: number;
  idempotency_key?: string;
};

/** Hermes `SwarmCreated.as_dict()` as-is. Key names are not changed. */
export type SwarmCreated = {
  root_id: string;
  worker_ids: string[];
  verifier_id: string;
  synthesizer_id: string;
};

/** Blackboard of the root card. Latest value per key + `_authors`. The value shape is decided by Hermes. */
export type Blackboard = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Artifacts (0.8.0+) — /deskrpg/artifacts
// ---------------------------------------------------------------------------

export const ARTIFACT_KINDS = [
  "document",
  "image",
  "media",
  "web",
  "react",
  "data",
  "file",
  "link",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export const ARTIFACT_SOURCES = ["chat", "kanban", "cron"] as const;
export type ArtifactSource = (typeof ARTIFACT_SOURCES)[number];

/**
 * UI tab groups (2026-09-18 follow-up). `media`=image+media, `file`=document+web+react+data+file,
 * `link`=link. Order is the tab display order (after All: media, files, links). The plugin-side mapping is
 * accepted by deskrpg-hermes-plugin `GET /deskrpg/artifacts?kind=<comma list>` (0.8.4+).
 */
export const ARTIFACT_CATEGORIES = {
  media: ["image", "media"],
  file: ["document", "web", "react", "data", "file"],
  link: ["link"],
} as const satisfies Record<string, readonly ArtifactKind[]>;
export type ArtifactCategory = keyof typeof ARTIFACT_CATEGORIES;
export const ARTIFACTS_MIN_VERSION = "0.8.0";
export const ARTIFACTS_TASK_FILTER_MIN_VERSION = "0.8.4";
export type ArtifactSummary = {
  id: string;
  kind: ArtifactKind;
  title: string;
  summary?: string | null;
  profile: string;
  source_kind: ArtifactSource;
  session_id: string;
  board?: string | null;
  task_id?: string | null;
  job_id?: string | null;
  run_id?: string | null;
  current_version: number;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  created_at: number;
  updated_at: number;
  missing?: true;
};
export type ArtifactVersion = {
  version: number;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  origin_path?: string | null;
  created_by: string;
  captured_via: "tool" | "hook" | "edit" | "response";
  note?: string | null;
  created_at: number;
  pruned_at?: number;
};
export type ArtifactPage = { artifacts: ArtifactSummary[]; cursor: string; has_more: boolean };
export type ArtifactDetail = { artifact: ArtifactSummary; versions: ArtifactVersion[] };
export type ArtifactEventPayload = {
  artifact_id: string;
  version?: number;
  kind?: ArtifactKind;
  title?: string;
  profile?: string;
  source_kind?: ArtifactSource;
  board?: string | null;
  task_id?: string | null;
  captured_via?: string;
};

/** 0.15.0 — NPC skill management (`/p/{profile}/deskrpg/skills|curator|learning/**`). */
export const SKILL_ADMIN_MIN_VERSION = "0.15.0";
export const SKILL_ADMIN_CAPABILITY = "profile_skill_admin";

/** 0.17.0 — NPC MCP connector management (`/p/{profile}/deskrpg/mcp/**`). */
export const MCP_ADMIN_MIN_VERSION = "0.17.0";
export const MCP_ADMIN_CAPABILITY = "profile_mcp_admin";

/** 0.18.0 — unattended run approval policy (`/p/{profile}/deskrpg/approval-policy`) and `approval.blocked` events. */
export const APPROVAL_POLICY_MIN_VERSION = "0.18.0";
export const APPROVAL_POLICY_CAPABILITY = "profile_approval_policy";
