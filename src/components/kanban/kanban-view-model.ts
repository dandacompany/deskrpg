import { classifyGateFailure } from "@/lib/gate-failure";
import { taskTimeMs } from "@/lib/plugin-time";
import { PLUGIN_INSTALL_COMMAND as SHARED_PLUGIN_INSTALL_COMMAND } from "@/lib/hermes/plugin-install-command";
/**
 * Pure view-model for the kanban screen — knows nothing about React or fetch.
 *
 * This pins down column order (R6), assignee ↔ NPC mapping (R7), card summaries (progress /
 * elapsed / warning badges), and the rule for folding server errors into screen branches (428 /
 * 409 / 503 / other, R31/R32). Components only render these functions' results — they never
 * reinterpret state or invent columns.
 */

import {
  KANBAN_TASK_STATUSES,
  type KanbanBoard,
  type KanbanComment,
  type KanbanTask,
  type KanbanTaskStatus,
} from "@/lib/hermes/deskrpg-plugin-types";

// ---------------------------------------------------------------------------
// Columns (R6)
// ---------------------------------------------------------------------------

/** Fixed order of board columns. Rendered in this order regardless of the server response's column order. */
export const KANBAN_COLUMN_ORDER: readonly KanbanTaskStatus[] = KANBAN_TASK_STATUSES;

export type OrderedColumn = { name: KanbanTaskStatus; tasks: KanbanTask[] };

/**
 * Sorts the response's columns into the fixed order. Columns missing from the response are filled
 * in empty, and columns with unknown names are dropped (never invent a status) — `hiddenCards`
 * counts what was dropped so the board can say so. The `archived` column is kept only when
 * `includeArchived` is set.
 */
export function orderColumns(
  columns: KanbanBoard["columns"] | undefined,
  includeArchived: boolean,
): OrderedColumn[] {
  const byName = new Map<string, KanbanTask[]>();
  for (const column of columns ?? []) byName.set(column.name, column.tasks ?? []);
  return KANBAN_COLUMN_ORDER.filter((name) => includeArchived || name !== "archived").map(
    (name) => ({ name, tasks: byName.get(name) ?? [] }),
  );
}

export type HiddenCards = { count: number; statuses: string[] };

/**
 * Cards that `orderColumns` drops because their column is a status this board does not know (a
 * newer Hermes, a hand-edited board). They are not placed in any column — the board only says how
 * many there are and under which statuses, in response order. `archived` is a known status, so
 * hiding it behind the archive toggle does not count here.
 */
export function hiddenCards(columns: KanbanBoard["columns"] | undefined): HiddenCards {
  const known = new Set<string>(KANBAN_COLUMN_ORDER);
  const statuses: string[] = [];
  let count = 0;
  for (const column of columns ?? []) {
    const size = column.tasks?.length ?? 0;
    if (known.has(column.name) || size === 0) continue;
    count += size;
    if (!statuses.includes(column.name)) statuses.push(column.name);
  }
  return { count, statuses };
}

// ---------------------------------------------------------------------------
// Assignee ↔ NPC (R7)
// ---------------------------------------------------------------------------

export type BoardNpc = { npcId: string; npcName: string; profileName: string; active: boolean };

/** Options for creation/reassignment — only NPCs who are active (checked in). */
export function activeAssigneeOptions(npcs: readonly BoardNpc[]): BoardNpc[] {
  return npcs.filter((npc) => npc.active);
}

/**
 * Turns the card's `assignee` (a profile name) into a display name. If it's this channel's NPC,
 * use the NPC name; otherwise use the profile name as-is (a card created from outside). Returns
 * null if there is no assignee.
 */
export function assigneeLabel(
  assignee: string | undefined | null,
  npcs: readonly BoardNpc[],
): string | null {
  if (!assignee) return null;
  const npc = npcs.find((entry) => entry.profileName === assignee);
  return npc ? npc.npcName : assignee;
}

/** Profile name → npcId (for the reassignment select's initial value). Null if not a channel NPC. */
export function npcIdForAssignee(
  assignee: string | undefined | null,
  npcs: readonly BoardNpc[],
): string | null {
  if (!assignee) return null;
  return npcs.find((entry) => entry.profileName === assignee)?.npcId ?? null;
}

// ---------------------------------------------------------------------------
// Card summaries
// ---------------------------------------------------------------------------

/** `done/total` string. Null if there's no progress or total is 0. */
export function progressLabel(task: Pick<KanbanTask, "progress">): string | null {
  const p = task.progress;
  if (!p || typeof p.total !== "number" || p.total <= 0) return null;
  return `${p.done}/${p.total}`;
}

/**
 * Elapsed seconds for a running card. Null if there's no `started_at`. If the last heartbeat is
 * after the start and the current time is unknown (`now` omitted), uses the elapsed time up to
 * the heartbeat.
 */
export function elapsedSeconds(
  task: Pick<KanbanTask, "started_at" | "last_heartbeat_at">,
  now?: number,
): number | null {
  const started = taskTimeMs(task.started_at);
  if (started === null) return null;
  let end = now;
  if (end === undefined) {
    const heartbeat = taskTimeMs(task.last_heartbeat_at);
    end = heartbeat ?? Date.now();
  }
  return Math.max(0, Math.floor((end - started) / 1000));
}

/** `1h 02m` · `5m 07s` · `42s` */
export function formatElapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

export type WarningBadge = { count: number; severity: "critical" | "error" | "warning" };

/** Warning badge. Null if `warnings.count` is 0 or less. Unknown severities fold into `warning`. */
export function warningBadge(task: Pick<KanbanTask, "warnings">): WarningBadge | null {
  const w = task.warnings;
  if (!w || typeof w.count !== "number" || w.count <= 0) return null;
  const severity =
    w.highest_severity === "critical" || w.highest_severity === "error"
      ? w.highest_severity
      : "warning";
  return { count: w.count, severity };
}

/** Whether a card is running — not by column name, but `status === "running"` with `started_at` present. */
export function isRunning(task: Pick<KanbanTask, "status" | "started_at">): boolean {
  return task.status === "running" && Boolean(task.started_at);
}

/** All board cards, in column order. Used for prerequisite-card options and link name lookups. */
export function flattenTasks(columns: readonly OrderedColumn[]): KanbanTask[] {
  return columns.flatMap((column) => column.tasks);
}

/** id → title. Used when the link list only gives an id. Falls back to the id itself if not found. */
export function taskTitleById(tasks: readonly KanbanTask[], id: string): string {
  return tasks.find((task) => task.id === id)?.title ?? id;
}

// ---------------------------------------------------------------------------
// Server error → screen branch (R31/R32/E6)
// ---------------------------------------------------------------------------

/** The source of truth is `@/lib/hermes/plugin-install-command` — this just preserves the existing import path. */
export const PLUGIN_INSTALL_COMMAND = SHARED_PLUGIN_INSTALL_COMMAND;

export type KanbanFailure = { status: number; code: string; message: string; minVersion?: string };

export type BoardBlocker =
  | { kind: "upgrade_required"; minVersion: string; command: string }
  | { kind: "gateway_not_bound" }
  | { kind: "board_unavailable"; code: string; reason: string }
  | { kind: "other"; status: number; code: string; message: string };

/** Turns an error that blocks opening the board into a screen branch. Other errors carry their code/message as-is. */
export function classifyBoardFailure(
  failure: KanbanFailure,
  fallbackMinVersion = "0.6.0",
): BoardBlocker {
  // The single source of judgment is `@/lib/gate-failure` — this just renames it into the board screen's terms.
  const blocker = classifyGateFailure({
    status: failure.status,
    code: failure.code,
    message: failure.message,
    minVersion: failure.minVersion,
  });

  if (blocker.kind === "plugin_upgrade_required") {
    return {
      kind: "upgrade_required",
      minVersion: failure.minVersion || fallbackMinVersion,
      command: blocker.command,
    };
  }
  if (blocker.kind === "gateway_not_bound") return { kind: "gateway_not_bound" };
  // 428 was already caught above. 503 means the board can't open, so the screen handles it separately.
  if (failure.status === 503) {
    return { kind: "board_unavailable", code: failure.code, reason: failure.message };
  }
  return {
    kind: "other",
    status: failure.status,
    code: failure.code,
    message: failure.message,
  };
}

/** Renders an error as one line. If the message equals the code, shows only the code — never prints `code: code` twice. */
export function failureLine(failure: Pick<KanbanFailure, "code" | "message">): string {
  return failure.message && failure.message !== failure.code
    ? `${failure.code}: ${failure.message}`
    : failure.code;
}

// ---------------------------------------------------------------------------
// Form (R8) — screen values → server body
// ---------------------------------------------------------------------------

export type TaskFormValues = {
  reviewMode?: "human" | "agent" | "mixed";
  reviewerNpcId?: string;
  reviewRevision?: number;
  title: string;
  body: string;
  assigneeNpcId: string;
  priority: string;
  parents: string[];
  workspaceKind: "" | "scratch" | "worktree" | "dir";
  workspacePath: string;
  skills: string;
  modelOverride: string;
  providerOverride: string;
  reasoningEffort: string;
  maxRuntimeSeconds: string;
  goalMode: boolean;
  goalMaxTurns: string;
};

export type ChatTaskDraft = Pick<TaskFormValues, "title" | "body" | "assigneeNpcId">;

export const EMPTY_TASK_FORM: TaskFormValues = {
  reviewMode: "human",
  reviewerNpcId: "",
  title: "",
  body: "",
  assigneeNpcId: "",
  priority: "",
  parents: [],
  workspaceKind: "",
  workspacePath: "",
  skills: "",
  modelOverride: "",
  providerOverride: "",
  reasoningEffort: "",
  maxRuntimeSeconds: "",
  goalMode: false,
  goalMaxTurns: "",
};

/** Skill list split on commas/newlines. Empty entries are dropped. */
export function parseSkills(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Form values → `POST/PATCH /kanban/tasks` body. Empty fields are omitted — the server does drop
 * unknown keys, but sending an empty string could be read by Hermes as "overwrite with an empty
 * value." The assignee is sent as npcId (the server converts it to a profile name).
 */
export function taskFormToBody(values: TaskFormValues): Record<string, unknown> {
  const body: Record<string, unknown> = { title: values.title.trim() };
  if (values.reviewMode) {
    body.reviewPolicy =
      values.reviewMode === "agent"
        ? { mode: "agent", reviewerNpcId: values.reviewerNpcId }
        : { mode: "human" };
    if (values.reviewRevision !== undefined) body.expected_revision = values.reviewRevision;
  }
  if (values.body.trim()) body.body = values.body;
  if (values.assigneeNpcId) body.assignee = values.assigneeNpcId;
  if (values.priority.trim()) body.priority = values.priority.trim();
  if (values.parents.length) body.parents = values.parents;
  if (values.workspaceKind) body.workspace_kind = values.workspaceKind;
  if (values.workspacePath.trim()) body.workspace_path = values.workspacePath.trim();
  const skills = parseSkills(values.skills);
  if (skills.length) body.skills = skills;
  if (values.modelOverride.trim()) body.model_override = values.modelOverride.trim();
  if (values.providerOverride.trim()) body.provider_override = values.providerOverride.trim();
  if (values.reasoningEffort.trim()) body.reasoning_effort = values.reasoningEffort.trim();
  const runtime = Number(values.maxRuntimeSeconds);
  if (values.maxRuntimeSeconds.trim() && Number.isFinite(runtime) && runtime > 0) {
    body.max_runtime_seconds = Math.floor(runtime);
  }
  if (values.goalMode) {
    body.goal_mode = true;
    const turns = Number(values.goalMaxTurns);
    if (values.goalMaxTurns.trim() && Number.isFinite(turns) && turns > 0) {
      body.goal_max_turns = Math.floor(turns);
    }
  }
  return body;
}

// ---------------------------------------------------------------------------
// Blackboard filter (swarm)
// ---------------------------------------------------------------------------

/** Must be **the same string** as Hermes `kanban_swarm.BLACKBOARD_PREFIX`. */
export const BLACKBOARD_PREFIX = "[swarm:blackboard] ";

/**
 * Filters blackboard comments out of the thread and merges them into the latest value per key.
 *
 * `create_swarm` leaves a `topology` comment on the root card itself, so without this processing
 * the user would see raw JSON on **every** swarm root card (`TaskDrawer` renders the body as plain
 * `whitespace-pre-wrap` text).
 *
 * The merge rule follows Hermes `latest_blackboard` — a later comment overwrites the same key, and
 * broken JSON or a non-string key is skipped.
 */
export function splitBlackboardComments(comments: KanbanComment[]): {
  comments: KanbanComment[];
  blackboard: Record<string, unknown>;
  authors: Record<string, string>;
} {
  const rest: KanbanComment[] = [];
  const blackboard: Record<string, unknown> = {};
  const authors: Record<string, string> = {};
  for (const comment of comments) {
    const body = comment.body ?? "";
    if (!body.startsWith(BLACKBOARD_PREFIX)) {
      rest.push(comment);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.slice(BLACKBOARD_PREFIX.length));
    } catch {
      continue; // A broken one isn't put back in the thread either — it's not meant to be shown to a person.
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const { key, value } = parsed as { key?: unknown; value?: unknown };
    if (typeof key !== "string" || !key) continue;
    blackboard[key] = value;
    authors[key] = comment.author;
  }
  return { comments: rest, blackboard, authors };
}
