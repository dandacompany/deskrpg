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

export type ApprovalWaiting = { key: string; npcId: string; approverName: string };

type State = { cards: ApprovalCardState[]; waiting: ApprovalWaiting[] };

type Action =
  | { type: "request"; request: ToolApprovalRequest }
  | { type: "resolved"; key: string; status: ToolApprovalStatus }
  | { type: "pending"; payload: ToolApprovalPending }
  | { type: "deciding"; key: string }
  | { type: "undecided"; key: string }
  | { type: "remove"; key: string };

/** Keeps cards in arrival order. A repeated request (the server resends on reconnect) never duplicates or reopens a card. */
export function approvalsReducer(state: State, action: Action): State {
  switch (action.type) {
    case "request": {
      if (state.cards.some((c) => c.request.key === action.request.key)) return state;
      // Defensive: only the three contract choices are ever drawn — `always` never reaches a button.
      const choices = TOOL_APPROVAL_CHOICES.filter((c) => action.request.choices.includes(c));
      const request = { ...action.request, choices: choices.length ? choices : ["deny" as const] };
      return {
        ...state,
        cards: [...state.cards, { request, status: "pending", deciding: false }],
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
