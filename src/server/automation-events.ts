/**
 * Automation event sink (T5, R25).
 *
 * The **only door** through which the plugin's unified events (`/deskrpg/events`) enter DeskRPG.
 * The poller (`automation-poller.ts`) calls it, and a future push route will call the same function.
 * Hard gate 5: no other path creates room notices or map state directly — everything goes through here.
 *
 * There are only three things done for an event.
 *  (a) Channel socket broadcast — an allow list. `task.*` goes to `kanban:event`, `cron.*` to `cron:event`,
 *      `artifact.*` to `artifact:event`. Cron events arrive for every profile on the host, so they are broadcast only
 *      when the profile resolves to **an NPC of this channel** (including sleeping NPCs). Artifact events are
 *      broadcast only for a channel NPC profile or the channel board. Another channel's profiles/boards must not leak
 *      onto this channel's screen. Kinds outside the list are broadcast to no channel.
 *  (b) Map state — an NPC is "working" if it has at least one in-flight card run or cron run (R27).
 *      `npc:working` is emitted **only when the value changes**.
 *  (c) Room notices — a card entering blocked (all), a top-level card entering done (R28), cron results originating
 *      from this channel (R30), and card proposals an NPC made during conversation (`card_proposal.created`). If the
 *      assigned NPC is asleep or gone, post a system message but prefix the NPC name (R22) — nothing is missed.
 *
 * The same event ID is never processed twice (per-channel recent-ID set, size cap tunable).
 *
 * The core knows nothing about the DB — lookups, storage and broadcasts all come in via `IngestDeps`. So unit tests
 * can pin just the rules, and the real wiring lives in one place, `createLiveIngestDeps` below.
 */

import { eq, and } from "drizzle-orm";

import { approvalTargets, approvals, db, hermesProfiles, npcs } from "@/db";
import type { RoomMessage, RoomNotice } from "@/lib/chat-rooms-policy";
import { appendRoomMessage, ensureOfficeRoom, getChannelOwnerId } from "@/lib/chat-rooms";
import { findCronOrigin, resolveOriginForGateway } from "@/lib/cron-origins";
import {
  PLUGIN_EVENT_KINDS,
  type CardProposalEventPayload,
  type CronRunFinishedPayload,
  type CronRunStartedPayload,
  type PluginEvent,
  type TaskStatusEventPayload,
} from "@/lib/hermes/deskrpg-plugin-types";

// ---------------------------------------------------------------------------
// Socket event names — hard gate 10: these four are the only new events.
// ---------------------------------------------------------------------------

export const AUTOMATION_SOCKET_EVENTS = {
  kanban: "kanban:event",
  cron: "cron:event",
  working: "npc:working",
  artifact: "artifact:event",
} as const;

const KANBAN_EVENT_KINDS: ReadonlySet<string> = new Set(
  PLUGIN_EVENT_KINDS.filter((k) => k.startsWith("task.")),
);

const ARTIFACT_PAYLOAD_KEYS = [
  "artifact_id",
  "version",
  "kind",
  "title",
  "profile",
  "source_kind",
  "board",
  "task_id",
  "captured_via",
] as const;

export type NpcWorkingPayload = {
  npcId: string;
  working: boolean;
  sources: { runningCards: number; cronRuns: number };
};

// ---------------------------------------------------------------------------
// Tunables — can be changed via environment variables.
// ---------------------------------------------------------------------------

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw ? Number(raw) : NaN;
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Max cron result body length (R30). If exceeded, the leading part + "…". */
export const DEFAULT_RESULT_MAX_CHARS = envInt("AUTOMATION_RESULT_MAX_CHARS", 2000);
/** Number of recent event IDs remembered per channel. */
export const DEFAULT_DEDUPE_LIMIT = envInt("AUTOMATION_EVENT_DEDUPE_LIMIT", 1000);

// ---------------------------------------------------------------------------
// Process state — dedup set + in-flight runs per NPC
// ---------------------------------------------------------------------------

type NpcWork = { runningCards: Set<string>; cronRuns: Set<string> };

type ChannelState = {
  /** Recently processed event IDs. The Set's insertion order is used directly as LRU. */
  seen: Set<string>;
  /** npcId → in-flight set */
  work: Map<string, NpcWork>;
  /** npcId → serialized value of the last broadcast `npc:working`. Not re-sent if equal. */
  lastEmitted: Map<string, string>;
};

export type AutomationState = Map<string, ChannelState>;

export function createAutomationState(): AutomationState {
  return new Map();
}

const defaultState: AutomationState = createAutomationState();

function channelState(state: AutomationState, channelId: string): ChannelState {
  let s = state.get(channelId);
  if (!s) {
    s = { seen: new Set(), work: new Map(), lastEmitted: new Map() };
    state.set(channelId, s);
  }
  return s;
}

/** For tests / rebinding — discard the state of one channel (or all). */
export function resetAutomationState(channelId?: string, state: AutomationState = defaultState) {
  if (channelId === undefined) state.clear();
  else state.delete(channelId);
}

function workingPayload(npcId: string, work: NpcWork): NpcWorkingPayload {
  const runningCards = work.runningCards.size;
  const cronRuns = work.cronRuns.size;
  return { npcId, working: runningCards + cronRuns > 0, sources: { runningCards, cronRuns } };
}

/**
 * Current values of NPCs that are "working" right now. Sent once to the socket on channel join (player:join) (R27).
 * Finished NPCs are not included — the client's default is `working:false`.
 */
export function getWorkingSnapshot(
  channelId: string,
  state: AutomationState = defaultState,
): NpcWorkingPayload[] {
  const s = state.get(channelId);
  if (!s) return [];
  const out: NpcWorkingPayload[] = [];
  for (const [npcId, work] of s.work) {
    const payload = workingPayload(npcId, work);
    if (payload.working) out.push(payload);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** Profile name → NPC of this channel. null if the profile is not on the gateway; `npc:null` if there is no NPC row. */
export type ChannelNpcLookup = {
  profileName: string;
  /** `hermes_profiles.display_name ?? profile_name` — `npcs.name` is not read. */
  displayName: string;
  npc: { id: string; active: boolean } | null;
};

export type IngestDeps = {
  /** The channel's current gateway. Used to match cron origin (R30). */
  gatewayId: string;
  /** The channel's board slug. `notice.boardSlug` of card notices. */
  boardSlug: string;
  findNpcByProfile(channelId: string, profileName: string): Promise<ChannelNpcLookup | null>;
  /**
   * Is this card `blocked` because it is **awaiting approval**? If so, no "card blocked" (`notice.cardBlocked`) notice is posted — the approval
   * request line already says the same thing, and awaiting approval is not a failure. Optional dependency; if absent,
   * notifies as before.
   */
  isAwaitingApproval?(channelId: string, taskId: string): Promise<boolean>;
  /**
   * Was this card **ever part of** a human-approved bundle (regardless of approval status)? If so, even with a parent
   * it is treated as independent work and its completion is announced — cards like meeting follow-ups linked by
   * parent as "must finish first". The parent link is execution order, not a bundle, and looking only at it would
   * treat these cards as subcards and silence them. Swarm/decomposition children never go through approval, so they
   * stay silent. Optional dependency; if absent, does not notify as before.
   */
  isApprovalBatchCard?(channelId: string, taskId: string): Promise<boolean>;
  findCronOriginChannel(key: {
    gatewayId: string;
    profileName: string;
    jobId: string;
  }): Promise<{ channelId: string; gatewayId: string } | null>;
  /** The channel's office room id. null if it cannot be created — only posting is skipped. */
  ensureOfficeRoomId(channelId: string): Promise<string | null>;
  appendRoomMessage(args: {
    roomId: string;
    senderKind: "npc" | "system";
    senderId: string | null;
    senderName: string;
    content: string;
    notice: RoomNotice;
  }): Promise<RoomMessage>;
  emitChannel(channelId: string, event: string, payload: unknown): void;
  emitRoomMessage(roomId: string, message: RoomMessage): void;
  maxResultLength?: number;
  dedupeLimit?: number;
  /** Process-global by default. Tests plug in their own. */
  state?: AutomationState;
};

export type IngestResult = {
  /** Number of newly processed events */
  processed: number;
  /** Number skipped because the ID was already seen */
  duplicates: number;
  /** Per-event processing failure messages (thrown by broadcast, state or post). Remaining events continue. */
  errors: string[];
};

// ---------------------------------------------------------------------------
// Sink
// ---------------------------------------------------------------------------

export async function ingest(
  channelId: string,
  events: PluginEvent[],
  deps: IngestDeps,
): Promise<IngestResult> {
  const state = channelState(deps.state ?? defaultState, channelId);
  const dedupeLimit = deps.dedupeLimit ?? DEFAULT_DEDUPE_LIMIT;
  const result: IngestResult = { processed: 0, duplicates: 0, errors: [] };

  for (const event of events) {
    if (state.seen.has(event.id)) {
      result.duplicates += 1;
      continue;
    }
    remember(state.seen, event.id, dedupeLimit);
    result.processed += 1;

    try {
      await broadcast(channelId, event, deps);
      await updateWorking(channelId, event, state, deps);
      await postNotice(channelId, event, deps);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`${event.kind} ${event.id}: ${message}`);
      console.warn(`[automation-events] ${channelId} ${event.kind} ${event.id} failed: ${message}`);
    }
  }
  return result;
}

function remember(seen: Set<string>, id: string, limit: number) {
  seen.add(id);
  while (seen.size > limit) {
    const oldest = seen.values().next().value;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }
}

// ---- (a) Broadcast -------------------------------------------------------

async function broadcast(channelId: string, event: PluginEvent, deps: IngestDeps) {
  if (KANBAN_EVENT_KINDS.has(event.kind)) {
    deps.emitChannel(channelId, AUTOMATION_SOCKET_EVENTS.kanban, { channelId, event });
    return;
  }
  if (event.kind.startsWith("artifact.")) {
    await broadcastArtifact(channelId, event, deps);
    return;
  }
  if (event.kind.startsWith("cron.")) {
    // Cron events only when the profile is an NPC of this channel (including sleeping NPCs) — the same lookup as
    // `updateWorking`·`postNotice`.
    const profile = profileOf(event);
    if (!profile) return;
    const lookup = await deps.findNpcByProfile(channelId, profile);
    if (!lookup?.npc) return;
    deps.emitChannel(channelId, AUTOMATION_SOCKET_EVENTS.cron, { channelId, event });
    return;
  }
  if (event.kind === "card_proposal.created") {
    // Proposals go out only as room notices (`postNotice`) — no new socket event is created.
    return;
  }
  // Outside the allow list — events whose channel scope is unknown are not passed to the browser.
  console.warn(`[automation-events] ${channelId} dropped unknown event kind ${event.kind}`);
}

async function broadcastArtifact(channelId: string, event: PluginEvent, deps: IngestDeps) {
  const p = event.payload as Record<string, unknown>;
  const base = { id: event.id, ts: event.ts, kind: event.kind };
  if (event.kind === "artifact.deleted") {
    // Deletion events carry no profile/board — send only the opaque id (no title etc.).
    if (typeof p.artifact_id !== "string") return;
    deps.emitChannel(channelId, AUTOMATION_SOCKET_EVENTS.artifact, {
      channelId,
      event: { ...base, payload: { artifact_id: p.artifact_id } },
    });
    return;
  }
  if (event.kind !== "artifact.created" && event.kind !== "artifact.versioned") return;
  const board = typeof p.board === "string" ? p.board : null;
  const profile = typeof p.profile === "string" ? p.profile : null;
  const inBoard = !!board && board === deps.boardSlug;
  const inProfile = !!profile && !!(await deps.findNpcByProfile(channelId, profile))?.npc;
  if (!inBoard && !inProfile) return;
  const payload: Record<string, unknown> = {};
  for (const key of ARTIFACT_PAYLOAD_KEYS) if (p[key] !== undefined) payload[key] = p[key];
  deps.emitChannel(channelId, AUTOMATION_SOCKET_EVENTS.artifact, {
    channelId,
    event: { ...base, payload },
  });
}

// ---- (b) Map state -------------------------------------------------------

function profileOf(event: PluginEvent): string | null {
  if (typeof event.profile === "string" && event.profile) return event.profile;
  const p = event.payload;
  if (typeof p.profile === "string" && p.profile) return p.profile;
  if (typeof p.assignee === "string" && p.assignee) return p.assignee;
  return null;
}

function cronRunKey(event: PluginEvent): string | null {
  if (typeof event.run_id === "string" && event.run_id) return event.run_id;
  const p = event.payload as Partial<CronRunStartedPayload>;
  if (typeof p.session_id === "string" && p.session_id) return `session:${p.session_id}`;
  if (typeof event.job_id === "string" && event.job_id) return `job:${event.job_id}`;
  return null;
}

async function updateWorking(
  channelId: string,
  event: PluginEvent,
  state: ChannelState,
  deps: IngestDeps,
) {
  const touched = new Set<string>();

  const add = async (kind: keyof NpcWork, key: string | null) => {
    const profile = profileOf(event);
    if (!profile || !key) return;
    const lookup = await deps.findNpcByProfile(channelId, profile);
    // Sleeping NPCs are counted too — when they clock in again, the value at that point must be right.
    if (!lookup?.npc) return;
    let work = state.work.get(lookup.npc.id);
    if (!work) {
      work = { runningCards: new Set(), cronRuns: new Set() };
      state.work.set(lookup.npc.id, work);
    }
    work[kind].add(key);
    touched.add(lookup.npc.id);
  };

  // Termination events may not carry a profile (terminate etc.). Search every NPC by key.
  const remove = (kind: keyof NpcWork, key: string | null) => {
    if (!key) return;
    for (const [npcId, work] of state.work) {
      if (work[kind].delete(key)) touched.add(npcId);
    }
  };

  switch (event.kind) {
    case "task.run.started":
      await add("runningCards", event.task_id ?? null);
      break;
    case "task.run.finished":
      remove("runningCards", event.task_id ?? null);
      break;
    case "cron.run.started":
      await add("cronRuns", cronRunKey(event));
      break;
    case "cron.run.finished":
      remove("cronRuns", cronRunKey(event));
      break;
    default:
      return;
  }

  for (const npcId of touched) {
    const work = state.work.get(npcId);
    if (!work) continue;
    const payload = workingPayload(npcId, work);
    const serialized = JSON.stringify(payload);
    if (state.lastEmitted.get(npcId) === serialized) continue;
    state.lastEmitted.set(npcId, serialized);
    deps.emitChannel(channelId, AUTOMATION_SOCKET_EVENTS.working, payload);
    if (!payload.working) state.work.delete(npcId);
  }
}

// ---- (c) Room notices ----------------------------------------------------

type Sender = {
  senderKind: "npc" | "system";
  senderId: string | null;
  senderName: string;
  npcName: string;
};

/**
 * Resolves the assigned NPC as the sender. If on duty, an NPC utterance; if asleep or missing, a system message (R22).
 * If even the profile is missing, the profile name is used as-is — the notice must go out even without a name.
 */
async function resolveSender(
  channelId: string,
  profile: string | null,
  deps: IngestDeps,
): Promise<Sender> {
  if (!profile) return { senderKind: "system", senderId: null, senderName: "", npcName: "" };
  const lookup = await deps.findNpcByProfile(channelId, profile);
  const npcName = lookup?.displayName || profile;
  if (lookup?.npc?.active) {
    return { senderKind: "npc", senderId: lookup.npc.id, senderName: npcName, npcName };
  }
  return { senderKind: "system", senderId: null, senderName: npcName, npcName };
}

function withPrefix(sender: Sender, body: string): string {
  return sender.senderKind === "system" && sender.npcName && body
    ? `${sender.npcName}: ${body}`
    : body;
}

async function post(
  channelId: string,
  sender: Sender,
  body: string,
  notice: RoomNotice,
  deps: IngestDeps,
) {
  const roomId = await deps.ensureOfficeRoomId(channelId);
  if (!roomId) {
    console.warn(`[automation-events] ${channelId}: office room unavailable, notice dropped`);
    return;
  }
  const message = await deps.appendRoomMessage({
    roomId,
    senderKind: sender.senderKind,
    senderId: sender.senderId,
    senderName: sender.senderName,
    content: withPrefix(sender, body),
    notice,
  });
  deps.emitRoomMessage(roomId, message);
}

/**
 * Should completion be announced? A subcard's (has a parent) completion is reported by its parent, so it stays quiet
 * — a rule to prevent 10 notices when a swarm creates 10 children. But a card that was part of an approval bundle,
 * even with a parent, is independent work a human saw in a list, so it is announced.
 */
async function announcesDone(
  channelId: string,
  taskId: string | null | undefined,
  p: Partial<TaskStatusEventPayload>,
  deps: IngestDeps,
): Promise<boolean> {
  if ((p.parent_count ?? 0) === 0) return true;
  if (!taskId || !deps.isApprovalBatchCard) return false;
  return deps.isApprovalBatchCard(channelId, taskId);
}

async function postNotice(channelId: string, event: PluginEvent, deps: IngestDeps) {
  if (event.kind === "task.status") {
    const p = event.payload as Partial<TaskStatusEventPayload>;
    // `review` is a spot waiting on human judgment — like `blocked`, it is announced even for a subcard.
    // Without the notice, the user has no way to know the NPC has stalled.
    const kind =
      p.to === "blocked"
        ? "card_blocked"
        : p.to === "review"
          ? "card_review"
          : p.to === "done" && (await announcesDone(channelId, event.task_id, p, deps))
            ? "card_done"
            : null;
    if (!kind) return;
    if (kind === "card_blocked" && event.task_id && deps.isAwaitingApproval) {
      if (await deps.isAwaitingApproval(channelId, event.task_id)) return;
    }
    const sender = await resolveSender(channelId, p.assignee ?? null, deps);
    const cardTitle = typeof p.title === "string" ? p.title : (event.task_id ?? "");
    await post(
      channelId,
      sender,
      cardTitle,
      {
        kind,
        cardId: event.task_id ?? "",
        cardTitle,
        boardSlug: event.board ?? deps.boardSlug,
        npcName: sender.npcName,
      },
      deps,
    );
    return;
  }

  if (event.kind === "card_proposal.created") {
    const p = event.payload as Partial<CardProposalEventPayload>;
    const profile = profileOf(event);
    if (!profile) return;
    // Same lookup as cron events — only notify for NPCs of this channel (including sleeping NPCs).
    const lookup = await deps.findNpcByProfile(channelId, profile);
    if (!lookup?.npc) return;

    const proposalId = typeof p.proposal_id === "string" ? p.proposal_id : "";
    const title = typeof p.title === "string" ? p.title.trim() : "";
    // Without a title the user cannot tell what they are choosing — drop it (not an error).
    if (!proposalId || !title) return;

    const sender = await resolveSender(channelId, profile, deps);
    const notice: Extract<RoomNotice, { kind: "card_proposal" }> = {
      kind: "card_proposal",
      proposalId,
      title,
      summary: typeof p.summary === "string" ? p.summary : "",
      npcId: lookup.npc.id,
      npcName: sender.npcName,
    };
    // If `body`·`acceptance` are missing, the key itself is omitted — never turned into an empty string.
    if (typeof p.body === "string" && p.body) notice.body = p.body;
    if (typeof p.acceptance === "string" && p.acceptance) notice.acceptance = p.acceptance;

    await post(channelId, sender, title, notice, deps);
    return;
  }

  if (event.kind === "cron.run.finished") {
    const p = event.payload as Partial<CronRunFinishedPayload>;
    const profileName = profileOf(event);
    const jobId = event.job_id ?? p.job_id ?? null;
    if (!profileName || !jobId) return;

    // Only jobs originating from this channel (R30). A different gateway counts as absent.
    const origin = await deps.findCronOriginChannel({
      gatewayId: deps.gatewayId,
      profileName,
      jobId,
    });
    if (!origin || origin.gatewayId !== deps.gatewayId || origin.channelId !== channelId) return;

    const status: "ok" | "error" = p.status === "error" ? "error" : "ok";
    const text = typeof p.result_text === "string" ? p.result_text.trim() : "";
    const max = deps.maxResultLength ?? DEFAULT_RESULT_MAX_CHARS;
    // An empty result is stored empty — the room notice says "failed" / "no result" in the viewer's language.
    const body = text.length > max ? `${text.slice(0, max)}…` : text;
    const sender = await resolveSender(channelId, profileName, deps);
    await post(
      channelId,
      sender,
      body,
      {
        kind: "cron_result",
        jobId,
        jobName: typeof p.job_name === "string" ? p.job_name : jobId,
        npcName: sender.npcName,
        status,
      },
      deps,
    );
  }
}

// ---------------------------------------------------------------------------
// Real wiring — DB lookups and room storage. The poller (and a future push route) builds deps with this.
// ---------------------------------------------------------------------------

export type LiveIngestWiring = {
  gatewayId: string;
  boardSlug: string;
  emitChannel: IngestDeps["emitChannel"];
  emitRoomMessage: IngestDeps["emitRoomMessage"];
};

export function createLiveIngestDeps(wiring: LiveIngestWiring): IngestDeps {
  return {
    gatewayId: wiring.gatewayId,
    boardSlug: wiring.boardSlug,
    emitChannel: wiring.emitChannel,
    emitRoomMessage: wiring.emitRoomMessage,

    async isApprovalBatchCard(channelId, taskId) {
      // No status condition — even if a card from a rejected/changes-requested bundle is later resolved by hand and
      // finished, it is still independent work a human saw in a list. (Same table as isAwaitingApproval, which
      // filters blocked-awaiting-approval, different condition.)
      const [row] = await db
        .select({ id: approvals.id })
        .from(approvalTargets)
        .innerJoin(approvals, eq(approvals.id, approvalTargets.approvalId))
        .where(and(eq(approvals.channelId, channelId), eq(approvalTargets.taskId, taskId)))
        .limit(1);
      return Boolean(row);
    },

    async isAwaitingApproval(channelId, taskId) {
      const [row] = await db
        .select({ id: approvals.id })
        .from(approvalTargets)
        .innerJoin(approvals, eq(approvals.id, approvalTargets.approvalId))
        .where(
          and(
            eq(approvals.channelId, channelId),
            eq(approvals.status, "pending"),
            eq(approvalTargets.taskId, taskId),
          ),
        )
        .limit(1);
      return Boolean(row);
    },

    async findNpcByProfile(channelId, profileName) {
      const [row] = await db
        .select({ profile: hermesProfiles, npc: npcs })
        .from(hermesProfiles)
        .leftJoin(
          npcs,
          and(eq(npcs.hermesProfileId, hermesProfiles.id), eq(npcs.channelId, channelId)),
        )
        .where(
          and(
            eq(hermesProfiles.gatewayId, wiring.gatewayId),
            eq(hermesProfiles.profileName, profileName),
          ),
        )
        .limit(1);
      if (!row) return null;
      return {
        profileName: row.profile.profileName,
        displayName: row.profile.displayName?.trim() || row.profile.profileName,
        npc: row.npc ? { id: row.npc.id, active: Boolean(row.npc.active) } : null,
      };
    },

    async findCronOriginChannel(key) {
      const origin = resolveOriginForGateway(await findCronOrigin(key), key.gatewayId);
      return origin ? { channelId: origin.channelId, gatewayId: origin.gatewayId } : null;
    },

    async ensureOfficeRoomId(channelId) {
      const ownerId = await getChannelOwnerId(channelId);
      if (!ownerId) return null;
      return (await ensureOfficeRoom(channelId, ownerId)).id;
    },

    appendRoomMessage: (args) => appendRoomMessage(args),
  };
}
