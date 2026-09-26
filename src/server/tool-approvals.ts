/**
 * Live Hermes tool approvals (dangerous commands, untrusted MCP write tools) in NPC 1:1 chat and
 * meetings. Pending approvals live in this process's memory only: Hermes' own approval queue is
 * the source of truth, and when the socket server restarts Hermes denies the waiting request on
 * its own timeout. The approver — whoever ordered the work — is the only one who may decide; the
 * check happens here, not in the browser.
 */
import crypto from "node:crypto";

import { eq } from "drizzle-orm";

import { db, gatewayResources, hermesProfiles, npcs } from "@/db";
import { replaceExecute } from "@/lib/adapters/replace-execute";
import type { AdapterExecuteOptions, NpcAdapter } from "@/lib/adapters/types";
import { decryptGatewayToken } from "@/lib/gateway-resources";
import { HermesError } from "@/lib/hermes/hermes-client";
import { createProfilePluginClient } from "@/lib/hermes/plugin-client";
import type { ParsedApprovalEvent } from "@/lib/tool-approval-event";
import {
  TOOL_APPROVAL_CHOICES,
  TOOL_APPROVAL_EVENTS,
  statusForChoice,
  toolApprovalKey,
  type ToolApprovalChoice,
  type ToolApprovalPending,
  type ToolApprovalRequest,
  type ToolApprovalResolved,
  type ToolApprovalStatus,
  type ToolApprovalSummary,
} from "@/lib/tool-approval-types";

/** Shown when the plugin cannot tell us Hermes' `approvals.timeout` (plugin < 0.18.0, unreachable). */
export const DEFAULT_APPROVAL_TIMEOUT_SECONDS = 300;
const TIMEOUT_CACHE_MS = 10 * 60 * 1000;
/**
 * How long a group remembers its count and last decision. There is no meeting or chat id at this
 * layer, so "the same conversation" means the same channel, context, room and approver within an
 * hour of the last request.
 */
export const APPROVAL_GROUP_WINDOW_MS = 60 * 60 * 1000;

export type DecideResult = "ok" | "not_approver" | "closed" | "invalid_choice" | "failed";

/** What a route hands the registry; grouping and the summary are the registry's to fill in. */
export type PendingApproval = Omit<ToolApprovalRequest, "groupKey" | "repeat" | "summary"> & {
  approverUserId: string;
  approverName: string;
  /** Hermes' `pattern_key`. */
  patternKey?: string | null;
};

type StoredApproval = PendingApproval &
  Pick<ToolApprovalRequest, "groupKey" | "repeat" | "summary">;

type RunApprovalClient = {
  resolveRunApproval(
    runId: string,
    body: { choice: ToolApprovalChoice; request_id?: string },
  ): Promise<{ resolved: number }>;
};

export type ToolApprovalRegistryDeps = {
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  emitToUser: (userId: string, event: string, payload: unknown) => void;
  emitToMeeting: (channelId: string, event: string, payload: unknown) => void;
  /** Chat-room turns: the "waiting for approval" line goes to everyone in that room. */
  emitToRoom?: (roomId: string, event: string, payload: unknown) => void;
  /** The profile-key Hermes client of an NPC — null when the NPC lost its profile. */
  clientFor: (npcId: string) => Promise<RunApprovalClient | null>;
  /**
   * A plain-language line for the approver, already redacted. null means none could be made; the
   * card then shows Hermes' own text. Absent means summaries are off.
   */
  summarize?: (req: PendingApproval) => Promise<string | null>;
};

export type ToolApprovalRegistry = ReturnType<typeof createToolApprovalRegistry>;

/** One Hermes request waiting behind a card. */
type Member = { key: string; runId: string; requestId: string | null };

type Entry = {
  req: StoredApproval;
  /** Every Hermes request this card answers — the same request can arrive again from another run. */
  members: Member[];
  timer: unknown;
  deciding: boolean;
};

export function approvalGroupKey(req: PendingApproval): string {
  const parts = [
    req.context,
    req.channelId,
    req.roomId ?? "",
    req.approverUserId,
    req.npcId,
    req.patternKey ?? req.kind,
    req.command,
  ];
  return crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

export function createToolApprovalRegistry(deps: ToolApprovalRegistryDeps) {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const entries = new Map<string, Entry>();
  /** Hermes request key → the card that answers it. */
  const memberOf = new Map<string, string>();
  /** Group → its open card. */
  const openCard = new Map<string, string>();
  const history = new Map<
    string,
    { count: number; last: ToolApprovalStatus | null; at: number; summary?: string }
  >();

  function publicView(req: StoredApproval): ToolApprovalRequest {
    const { approverUserId: _u, approverName: _n, patternKey: _p, ...view } = req;
    return view;
  }

  function sendCard(entry: Entry) {
    deps.emitToUser(entry.req.approverUserId, TOOL_APPROVAL_EVENTS.request, publicView(entry.req));
  }

  function forgetOldGroups() {
    const cutoff = now() - APPROVAL_GROUP_WINDOW_MS;
    for (const [group, seen] of history) {
      if (seen.at < cutoff && !openCard.has(group)) history.delete(group);
    }
  }

  function close(key: string, status: ToolApprovalStatus) {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    clearTimer(entry.timer);
    for (const member of entry.members) memberOf.delete(member.key);
    openCard.delete(entry.req.groupKey);
    const seen = history.get(entry.req.groupKey);
    if (seen) history.set(entry.req.groupKey, { ...seen, last: status, at: now() });
    const resolved: ToolApprovalResolved = { key, status };
    deps.emitToUser(entry.req.approverUserId, TOOL_APPROVAL_EVENTS.resolved, resolved);
    const cleared: ToolApprovalPending = { key, cleared: true };
    emitPending(entry.req, cleared);
  }

  /** Meeting and chat-room turns tell the other participants an approval is waiting; a DM has none. */
  function emitPending(req: PendingApproval, payload: ToolApprovalPending) {
    if (req.context === "meeting")
      deps.emitToMeeting(req.channelId, TOOL_APPROVAL_EVENTS.pending, payload);
    else if (req.context === "room" && req.roomId)
      deps.emitToRoom?.(req.roomId, TOOL_APPROVAL_EVENTS.pending, payload);
  }

  function summarizeInto(key: string, req: PendingApproval) {
    if (!deps.summarize) return;
    void deps
      .summarize(req)
      .catch(() => null)
      .then((text) => {
        const entry = entries.get(key);
        if (!entry) return;
        const seen = history.get(entry.req.groupKey);
        if (text && seen) history.set(entry.req.groupKey, { ...seen, summary: text });
        entry.req = {
          ...entry.req,
          summary: text ? { state: "ready", text } : { state: "unavailable" },
        };
        sendCard(entry);
      });
  }

  return {
    add(req: PendingApproval) {
      if (memberOf.has(req.key)) return;
      forgetOldGroups();
      const groupKey = approvalGroupKey(req);
      const seen = history.get(groupKey);
      const count = (seen?.count ?? 0) + 1;
      history.set(groupKey, { count, last: seen?.last ?? null, at: now(), summary: seen?.summary });
      const member: Member = { key: req.key, runId: req.runId, requestId: req.requestId };

      const openKey = openCard.get(groupKey);
      const open = openKey ? entries.get(openKey) : undefined;
      if (open && !open.deciding) {
        // The same request is already on screen: one card answers both.
        open.members.push(member);
        memberOf.set(req.key, open.req.key);
        open.req = { ...open.req, repeat: { ...open.req.repeat, count } };
        sendCard(open);
        return;
      }

      const choices = req.choices.filter((c) => TOOL_APPROVAL_CHOICES.includes(c));
      const summary: ToolApprovalSummary = seen?.summary
        ? { state: "ready", text: seen.summary }
        : deps.summarize
          ? { state: "pending" }
          : { state: "unavailable" };
      const stored: StoredApproval = {
        ...req,
        choices,
        groupKey,
        repeat: { count, lastStatus: seen?.last ?? null },
        summary,
      };
      const timer = setTimer(() => close(req.key, "expired"), Math.max(0, req.expiresAt - now()));
      const entry: Entry = { req: stored, members: [member], timer, deciding: false };
      entries.set(req.key, entry);
      memberOf.set(req.key, req.key);
      openCard.set(groupKey, req.key);
      sendCard(entry);
      emitPending(req, {
        key: req.key,
        npcId: req.npcId,
        approverName: req.approverName,
        ...(req.roomId ? { roomId: req.roomId } : {}),
      });
      if (summary.state === "pending") summarizeInto(req.key, req);
    },

    async decide(userId: string, key: unknown, choice: unknown): Promise<DecideResult> {
      if (!TOOL_APPROVAL_CHOICES.includes(choice as ToolApprovalChoice)) return "invalid_choice";
      const entry = typeof key === "string" ? entries.get(key) : undefined;
      if (!entry) return "closed";
      if (entry.req.approverUserId !== userId) return "not_approver";
      if (entry.deciding) return "closed";
      const picked = choice as ToolApprovalChoice;
      if (!entry.req.choices.includes(picked)) return "invalid_choice";
      entry.deciding = true;
      const cardKey = entry.req.key;
      const client = await deps.clientFor(entry.req.npcId).catch(() => null);
      if (!client) {
        close(cardKey, "failed");
        return "failed";
      }
      // Hermes keeps one approval session per run, so every request behind the card gets its own answer.
      let answered = 0;
      let failure: unknown = null;
      for (const member of [...entry.members]) {
        try {
          const res = await client.resolveRunApproval(member.runId, {
            choice: picked,
            ...(member.requestId ? { request_id: member.requestId } : {}),
          });
          if (res.resolved >= 1) answered += 1;
        } catch (err) {
          failure = err;
        }
      }
      if (answered > 0) {
        close(cardKey, statusForChoice(picked));
        return "ok";
      }
      if (
        failure === null ||
        (failure instanceof HermesError && (failure.status === 404 || failure.status === 409))
      ) {
        // Hermes had nothing waiting — it already timed out or the run ended.
        close(cardKey, "expired");
        return "closed";
      }
      close(cardKey, "failed");
      return "failed";
    },

    /** The run ended (answered, stopped, or failed) — its requests are no longer waiting. */
    expireRun(runId: string) {
      for (const [key, entry] of [...entries]) {
        const left = entry.members.filter((m) => m.runId !== runId);
        if (left.length === entry.members.length) continue;
        for (const m of entry.members) if (m.runId === runId) memberOf.delete(m.key);
        entry.members = left;
        if (left.length === 0) close(key, "expired");
      }
    },

    pendingFor(userId: string): ToolApprovalRequest[] {
      return [...entries.values()]
        .filter((e) => e.req.approverUserId === userId)
        .map((e) => publicView(e.req));
    },
  };
}

export type ApprovalRoute = {
  npcId: string;
  channelId: string;
  context: "dm" | "meeting" | "room";
  /** `room` only. */
  roomId?: string;
  /**
   * Called when the request arrives (not when the adapter is wrapped) — a meeting's opener or a room turn's caller
   * changes between turns. null = nobody to ask; Hermes then denies on its own timeout.
   */
  approver: () =>
    { userId: string; name: string } | null | Promise<{ userId: string; name: string } | null>;
};

export type ApprovalRouting = {
  registry: Pick<ToolApprovalRegistry, "add" | "expireRun">;
  timeoutFor: (npcId: string) => Promise<number>;
  now?: () => number;
};

/**
 * Wraps an adapter so `approval.request` events of its runs become cards for the approver, and
 * whatever is still pending when a run ends is expired. Every other method delegates unchanged.
 */
export function withToolApprovals(
  adapter: NpcAdapter,
  route: ApprovalRoute,
  routing: ApprovalRouting,
): NpcAdapter {
  const now = routing.now ?? Date.now;
  const execute: NpcAdapter["execute"] = async (options: AdapterExecuteOptions) => {
    const runs = new Set<string>();
    let finished = false;
    const onApprovalRequest = (event: ParsedApprovalEvent) => {
      options.onApprovalRequest?.(event);
      runs.add(event.runId);
      // Read the approver now — the turn it belongs to is the one running at this moment.
      let current: ReturnType<ApprovalRoute["approver"]>;
      try {
        current = route.approver();
      } catch {
        current = null;
      }
      const approverOf = Promise.resolve(current).catch(() => null);
      void Promise.all([
        approverOf,
        routing.timeoutFor(route.npcId).catch(() => DEFAULT_APPROVAL_TIMEOUT_SECONDS),
      ]).then(([approver, timeoutSeconds]) => {
        // The run may have ended while the approver or timeout was being looked up.
        if (finished || !approver) return;
        routing.registry.add({
          key: toolApprovalKey(event.runId, event.requestId),
          runId: event.runId,
          requestId: event.requestId,
          npcId: route.npcId,
          channelId: route.channelId,
          context: route.context,
          ...(route.roomId ? { roomId: route.roomId } : {}),
          kind: event.kind,
          patternKey: event.patternKey,
          command: event.command,
          description: event.description,
          choices: event.choices,
          expiresAt: now() + timeoutSeconds * 1000,
          approverUserId: approver.userId,
          approverName: approver.name,
        });
      });
    };
    try {
      return await adapter.execute({
        ...options,
        onRunStarted: (runId: string) => {
          runs.add(runId);
          options.onRunStarted?.(runId);
        },
        onApprovalRequest,
      });
    } finally {
      finished = true;
      for (const runId of runs) routing.registry.expireRun(runId);
    }
  };

  return replaceExecute(adapter, execute);
}

/**
 * Hermes' `approvals.timeout` for an NPC's profile, read through the plugin (0.18.0
 * `approval-policy`) and cached per NPC for 10 minutes. Falls back to 300 seconds.
 */
export function createApprovalTimeoutLookup(
  read: (npcId: string) => Promise<number | null> = readApprovalTimeout,
  now: () => number = Date.now,
) {
  const cache = new Map<string, { seconds: number; at: number }>();
  return async (npcId: string): Promise<number> => {
    const hit = cache.get(npcId);
    if (hit && now() - hit.at < TIMEOUT_CACHE_MS) return hit.seconds;
    const read_ = await read(npcId).catch(() => null);
    const seconds = read_ && read_ > 0 ? read_ : DEFAULT_APPROVAL_TIMEOUT_SECONDS;
    cache.set(npcId, { seconds, at: now() });
    return seconds;
  };
}

async function readApprovalTimeout(npcId: string): Promise<number | null> {
  const [row] = await db
    .select({
      profileName: hermesProfiles.profileName,
      tokenEncrypted: hermesProfiles.tokenEncrypted,
      baseUrl: gatewayResources.baseUrl,
    })
    .from(npcs)
    .innerJoin(hermesProfiles, eq(npcs.hermesProfileId, hermesProfiles.id))
    .innerJoin(gatewayResources, eq(hermesProfiles.gatewayId, gatewayResources.id))
    .where(eq(npcs.id, npcId))
    .limit(1);
  if (!row) return null;
  const client = createProfilePluginClient({
    baseUrl: row.baseUrl,
    profileName: row.profileName,
    profileToken: decryptGatewayToken(row.tokenEncrypted),
  });
  const res = await client.approvals.getPolicy();
  return res.ok ? res.data.timeoutSeconds : null;
}
