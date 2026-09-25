"use client";
import { createContext, useContext, type ReactNode } from "react";

import { useToolApprovals, type ToolApprovalSocket } from "./use-tool-approvals";

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
