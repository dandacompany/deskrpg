"use client";
import { createContext, useContext, useMemo, type ReactNode } from "react";

import {
  pendingApprovalsByRoom,
  useToolApprovals,
  type ToolApprovalSocket,
} from "./use-tool-approvals";

type SharedApprovals = ReturnType<typeof useToolApprovals>;

const ToolApprovalsContext = createContext<SharedApprovals | null>(null);

/**
 * Holds the approval cards for the whole game page. A stack only mounts while its chat is shown,
 * and a request that arrives while another chat is open (a room NPC walking over opens its DM)
 * would otherwise be dropped — the server resends pending cards only on reconnect.
 */
export function ToolApprovalsProvider({
  socket,
  children,
}: {
  socket: ToolApprovalSocket | null | undefined;
  children: ReactNode;
}) {
  const approvals = useToolApprovals(socket);
  return (
    <ToolApprovalsContext.Provider value={approvals}>{children}</ToolApprovalsContext.Provider>
  );
}

/** The page-wide approvals when a provider is mounted, otherwise null. */
export function useSharedToolApprovals(): SharedApprovals | null {
  return useContext(ToolApprovalsContext);
}

const NO_COUNTS: Record<string, number> = {};

/**
 * Pending approvals per chat room, for the navigator's room badges. Empty without a provider.
 */
export function useRoomApprovalCounts(): Record<string, number> {
  const shared = useContext(ToolApprovalsContext);
  const cards = shared?.cards;
  const waiting = shared?.waiting;
  return useMemo(
    () => (cards && waiting ? pendingApprovalsByRoom(cards, waiting) : NO_COUNTS),
    [cards, waiting],
  );
}
