"use client";
import { useCallback, useEffect, useReducer, useRef } from "react";

import {
  TOOL_APPROVAL_CHOICES,
  TOOL_APPROVAL_EVENTS,
  type ToolApprovalChoice,
  type ToolApprovalPending,
  type ToolApprovalRequest,
  type ToolApprovalResolved,
  type ToolApprovalStatus,
} from "@/lib/tool-approval-types";

/** The part of a socket.io client this hook uses — a real `Socket` fits it as-is. */
export type ToolApprovalSocket = {
  on(event: string, handler: (payload: unknown) => void): unknown;
  off(event: string, handler: (payload: unknown) => void): unknown;
  emit(event: string, payload: unknown, ack?: (reply: unknown) => void): unknown;
};

export type ApprovalCardState = {
  request: ToolApprovalRequest;
  status: ToolApprovalStatus;
  /** A choice was sent and the server has not answered yet. */
  deciding: boolean;
};

/** `roomId` marks a chat-room turn; a meeting's waiting line has none. */
export type ApprovalWaiting = { key: string; npcId: string; approverName: string; roomId?: string };

type State = { cards: ApprovalCardState[]; waiting: ApprovalWaiting[] };

type Action =
  | { type: "request"; request: ToolApprovalRequest }
  | { type: "resolved"; key: string; status: ToolApprovalStatus }
  | { type: "pending"; payload: ToolApprovalPending }
  | { type: "deciding"; key: string }
  | { type: "undecided"; key: string }
  | { type: "remove"; key: string };

/**
 * Keeps cards in arrival order. The server sends a card again with the same key when its summary
 * arrives or a repeat joins it (and on reconnect): that updates the card in place and never reopens
 * or duplicates it. A new card of a group replaces the group's finished card, so a request asked
 * again shows as one card with its count.
 */
export function approvalsReducer(state: State, action: Action): State {
  switch (action.type) {
    case "request": {
      // Defensive: only the three contract choices are ever drawn — `always` never reaches a button.
      const choices = TOOL_APPROVAL_CHOICES.filter((c) => action.request.choices.includes(c));
      // A payload without the grouping or summary fields (an older server) still draws a plain card.
      const incoming = action.request as Partial<ToolApprovalRequest> & ToolApprovalRequest;
      const request: ToolApprovalRequest = {
        ...incoming,
        choices: choices.length ? choices : ["deny" as const],
        groupKey: incoming.groupKey ?? incoming.key,
        repeat: incoming.repeat ?? { count: 1, lastStatus: null },
        summary: incoming.summary ?? { state: "unavailable" },
      };
      if (state.cards.some((c) => c.request.key === request.key)) {
        return {
          ...state,
          cards: state.cards.map((c) => (c.request.key === request.key ? { ...c, request } : c)),
        };
      }
      const kept = state.cards.filter(
        (c) => c.request.groupKey !== request.groupKey || c.status === "pending",
      );
      return {
        ...state,
        cards: [...kept, { request, status: "pending", deciding: false }],
      };
    }
    case "resolved":
      return {
        ...state,
        cards: state.cards.map((c) =>
          c.request.key === action.key ? { ...c, status: action.status, deciding: false } : c,
        ),
      };
    case "undecided":
      return {
        ...state,
        cards: state.cards.map((c) =>
          c.request.key === action.key ? { ...c, deciding: false } : c,
        ),
      };
    case "deciding":
      return {
        ...state,
        cards: state.cards.map((c) =>
          c.request.key === action.key && c.status === "pending" ? { ...c, deciding: true } : c,
        ),
      };
    case "pending": {
      const rest = state.waiting.filter((w) => w.key !== action.payload.key);
      return {
        ...state,
        waiting: "cleared" in action.payload ? rest : [...rest, action.payload],
      };
    }
    case "remove":
      return { ...state, cards: state.cards.filter((c) => c.request.key !== action.key) };
  }
}

/**
 * Pending chat-room approvals per room id — my own cards plus other people's waiting lines
 * (a line with its own card counts once). DM and meeting approvals have no room and are left
 * out. With `now`, a card past its deadline no longer counts; without it, it counts until the
 * hook folds it away.
 */
export function pendingApprovalsByRoom(
  cards: readonly ApprovalCardState[],
  waiting: readonly ApprovalWaiting[],
  now?: number,
): Record<string, number> {
  const counts: Record<string, number> = {};
  const seen = new Set<string>();
  for (const { request, status } of cards) {
    if (request.context !== "room" || !request.roomId || status !== "pending") continue;
    if (now !== undefined && request.expiresAt <= now) continue;
    seen.add(request.key);
    counts[request.roomId] = (counts[request.roomId] ?? 0) + 1;
  }
  for (const line of waiting) {
    if (!line.roomId || seen.has(line.key)) continue;
    counts[line.roomId] = (counts[line.roomId] ?? 0) + 1;
  }
  return counts;
}

/**
 * Pending approvals per NPC across every context (DM, meeting, room) — the office shows an employee waiting on a
 * person whichever chat the approval belongs to. Counted the same way as `pendingApprovalsByRoom`.
 */
export function pendingApprovalsByNpc(
  cards: readonly ApprovalCardState[],
  waiting: readonly ApprovalWaiting[],
  now?: number,
): Record<string, number> {
  const counts: Record<string, number> = {};
  const seen = new Set<string>();
  for (const { request, status } of cards) {
    if (status !== "pending") continue;
    if (now !== undefined && request.expiresAt <= now) continue;
    seen.add(request.key);
    counts[request.npcId] = (counts[request.npcId] ?? 0) + 1;
  }
  for (const line of waiting) {
    if (!line.npcId || seen.has(line.key)) continue;
    counts[line.npcId] = (counts[line.npcId] ?? 0) + 1;
  }
  return counts;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";

/**
 * Subscribes to the tool-approval socket events. Cards are kept for every NPC and channel —
 * the caller filters when rendering, so reopening another NPC's chat still shows its card. A
 * resolved card folds away `collapseMs` after its result shows; an unanswered one folds away
 * the same delay after it expires (Hermes has denied it on its own by then).
 */
export function useToolApprovals(
  socket: ToolApprovalSocket | null | undefined,
  { collapseMs = 5_000 }: { collapseMs?: number } = {},
) {
  const [state, dispatch] = useReducer(approvalsReducer, { cards: [], waiting: [] });
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  const later = useCallback((ms: number, key: string) => {
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      dispatch({ type: "remove", key });
    }, ms);
    timers.current.add(timer);
  }, []);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  useEffect(() => {
    if (!socket) return;
    const onRequest = (payload: unknown) => {
      if (!isObject(payload) || typeof payload.key !== "string") return;
      const request = payload as ToolApprovalRequest;
      dispatch({ type: "request", request });
      later(Math.max(0, request.expiresAt - Date.now()) + collapseMs, request.key);
    };
    const onResolved = (payload: unknown) => {
      if (!isObject(payload) || typeof payload.key !== "string") return;
      const { key, status } = payload as ToolApprovalResolved;
      dispatch({ type: "resolved", key, status });
      if (status !== "pending") later(collapseMs, key);
    };
    const onPending = (payload: unknown) => {
      if (!isObject(payload) || typeof payload.key !== "string") return;
      dispatch({ type: "pending", payload: payload as ToolApprovalPending });
    };
    socket.on(TOOL_APPROVAL_EVENTS.request, onRequest);
    socket.on(TOOL_APPROVAL_EVENTS.resolved, onResolved);
    socket.on(TOOL_APPROVAL_EVENTS.pending, onPending);
    return () => {
      socket.off(TOOL_APPROVAL_EVENTS.request, onRequest);
      socket.off(TOOL_APPROVAL_EVENTS.resolved, onResolved);
      socket.off(TOOL_APPROVAL_EVENTS.pending, onPending);
    };
  }, [socket, collapseMs, later]);

  const decide = useCallback(
    (key: string, choice: ToolApprovalChoice) => {
      if (!socket) return;
      dispatch({ type: "deciding", key });
      // The server acks with {result}. `closed`/`failed` also arrive as `resolved`; a refusal
      // (not_approver, invalid_choice) does not, so unlock the buttons here.
      socket.emit(TOOL_APPROVAL_EVENTS.decide, { key, choice }, (reply: unknown) => {
        const result = isObject(reply) ? reply.result : undefined;
        if (result === "not_approver" || result === "invalid_choice") {
          dispatch({ type: "undecided", key });
        }
      });
    },
    [socket],
  );

  return { cards: state.cards, waiting: state.waiting, decide };
}
