/**
 * Contract for live Hermes tool approvals (dangerous commands, untrusted MCP write tools) in
 * NPC 1:1 chat and meetings. The socket server holds pending approvals in memory; the browser
 * only ever sees these shapes and answers with `tool-approval:decide`.
 *
 * Socket events (registered in socket-event-parity.test.ts):
 * - server → approver sockets `tool-approval:request`  ToolApprovalRequest
 * - server → approver sockets `tool-approval:resolved` ToolApprovalResolved
 * - server → meeting room      `tool-approval:pending`  ToolApprovalPending
 * - client → server            `tool-approval:decide`   ToolApprovalDecide
 */

/** `always` (permanent allow) is never offered or accepted. */
export type ToolApprovalChoice = "once" | "session" | "deny";
export const TOOL_APPROVAL_CHOICES: readonly ToolApprovalChoice[] = ["once", "session", "deny"];

export type ToolApprovalRequest = {
  /** `${runId}:${requestId ?? "0"}` — one card per Hermes queue entry. */
  key: string;
  runId: string;
  requestId: string | null;
  npcId: string;
  channelId: string;
  context: "dm" | "meeting";
  kind: "mcp" | "command";
  /** Hermes-redacted; never logged. */
  command: string;
  description: string;
  choices: ToolApprovalChoice[];
  /** Epoch ms after which Hermes has denied it on its own. */
  expiresAt: number;
};

export type ToolApprovalStatus =
  "pending" | "approved_once" | "approved_session" | "denied" | "expired" | "failed";

export type ToolApprovalResolved = { key: string; status: ToolApprovalStatus };

export type ToolApprovalPending =
  { key: string; npcId: string; approverName: string } | { key: string; cleared: true };

export type ToolApprovalDecide = { key: string; choice: ToolApprovalChoice };

export const TOOL_APPROVAL_EVENTS = {
  request: "tool-approval:request",
  resolved: "tool-approval:resolved",
  pending: "tool-approval:pending",
  decide: "tool-approval:decide",
} as const;

export function toolApprovalKey(runId: string, requestId: string | null): string {
  return `${runId}:${requestId ?? "0"}`;
}

export function statusForChoice(choice: ToolApprovalChoice): ToolApprovalStatus {
  return choice === "once" ? "approved_once" : choice === "session" ? "approved_session" : "denied";
}
