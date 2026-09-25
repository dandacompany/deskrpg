/**
 * Live Hermes tool approvals (dangerous commands, untrusted MCP write tools) in NPC 1:1 chat and
 * meetings. Pending approvals live in this process's memory only: Hermes' own approval queue is
 * the source of truth, and when the socket server restarts Hermes denies the waiting request on
 * its own timeout. The approver — whoever ordered the work — is the only one who may decide; the
 * check happens here, not in the browser.
 */
import { eq } from "drizzle-orm";

import { db, gatewayResources, hermesProfiles, npcs } from "@/db";
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
} from "@/lib/tool-approval-types";

/** Shown when the plugin cannot tell us Hermes' `approvals.timeout` (plugin < 0.18.0, unreachable). */
export const DEFAULT_APPROVAL_TIMEOUT_SECONDS = 300;
const TIMEOUT_CACHE_MS = 10 * 60 * 1000;

export type DecideResult = "ok" | "not_approver" | "closed" | "invalid_choice" | "failed";

export type PendingApproval = ToolApprovalRequest & {
  approverUserId: string;
  approverName: string;
};

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
  /** The profile-key Hermes client of an NPC — null when the NPC lost its profile. */
  clientFor: (npcId: string) => Promise<RunApprovalClient | null>;
};

export type ToolApprovalRegistry = ReturnType<typeof createToolApprovalRegistry>;

export function createToolApprovalRegistry(deps: ToolApprovalRegistryDeps) {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const entries = new Map<string, { req: PendingApproval; timer: unknown; deciding: boolean }>();

  function publicView(req: PendingApproval): ToolApprovalRequest {
    const { approverUserId: _u, approverName: _n, ...view } = req;
    return view;
  }

  function close(key: string, status: ToolApprovalStatus) {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    clearTimer(entry.timer);
    const resolved: ToolApprovalResolved = { key, status };
    deps.emitToUser(entry.req.approverUserId, TOOL_APPROVAL_EVENTS.resolved, resolved);
    if (entry.req.context === "meeting") {
      const cleared: ToolApprovalPending = { key, cleared: true };
      deps.emitToMeeting(entry.req.channelId, TOOL_APPROVAL_EVENTS.pending, cleared);
    }
  }

  return {
    add(req: PendingApproval) {
      if (entries.has(req.key)) return;
      const choices = req.choices.filter((c) => TOOL_APPROVAL_CHOICES.includes(c));
      const stored = { ...req, choices };
      const timer = setTimer(() => close(req.key, "expired"), Math.max(0, req.expiresAt - now()));
      entries.set(req.key, { req: stored, timer, deciding: false });
      deps.emitToUser(req.approverUserId, TOOL_APPROVAL_EVENTS.request, publicView(stored));
      if (req.context === "meeting") {
        const pending: ToolApprovalPending = {
          key: req.key,
          npcId: req.npcId,
          approverName: req.approverName,
        };
        deps.emitToMeeting(req.channelId, TOOL_APPROVAL_EVENTS.pending, pending);
      }
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
      const { runId, requestId, npcId } = entry.req;
      try {
        const client = await deps.clientFor(npcId);
        if (!client) {
          close(entry.req.key, "failed");
          return "failed";
        }
        const res = await client.resolveRunApproval(runId, {
          choice: picked,
          ...(requestId ? { request_id: requestId } : {}),
        });
        if (res.resolved < 1) {
          // Hermes had nothing waiting — it already timed out or the run ended.
          close(entry.req.key, "expired");
          return "closed";
        }
        close(entry.req.key, statusForChoice(picked));
        return "ok";
      } catch (err) {
        if (err instanceof HermesError && (err.status === 404 || err.status === 409)) {
          close(entry.req.key, "expired");
          return "closed";
        }
        close(entry.req.key, "failed");
        return "failed";
      }
    },

    /** The run ended (answered, stopped, or failed) — anything still waiting on it is expired. */
    expireRun(runId: string) {
      for (const [key, entry] of [...entries]) {
        if (entry.req.runId === runId) close(key, "expired");
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
  context: "dm" | "meeting";
  /** Evaluated per request — a meeting's opener can change between turns. null = nobody to ask. */
  approver: () => { userId: string; name: string } | null;
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
      const approver = route.approver();
      if (!approver) return;
      void routing
        .timeoutFor(route.npcId)
        .catch(() => DEFAULT_APPROVAL_TIMEOUT_SECONDS)
        .then((timeoutSeconds) => {
          // The run may have ended while the timeout was being looked up.
          if (finished) return;
          routing.registry.add({
            key: toolApprovalKey(event.runId, event.requestId),
            runId: event.runId,
            requestId: event.requestId,
            npcId: route.npcId,
            channelId: route.channelId,
            context: route.context,
            kind: event.kind,
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

  const wrapped: NpcAdapter = {
    type: adapter.type,
    execute,
    testConnection: (config) => adapter.testConnection(config),
  };
  if (adapter.abort) wrapped.abort = (sessionKey) => adapter.abort!(sessionKey);
  if (adapter.steer) wrapped.steer = (text) => adapter.steer!(text);
  if (adapter.getSessionSummary)
    wrapped.getSessionSummary = (sessionKey) => adapter.getSessionSummary!(sessionKey);
  if (adapter.resetSession)
    wrapped.resetSession = (sessionKey) => adapter.resetSession!(sessionKey);
  if (adapter.getConfigSchema) wrapped.getConfigSchema = () => adapter.getConfigSchema!();
  return wrapped;
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
