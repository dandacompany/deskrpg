/**
 * Per-employee counts of what waits on a person, folded from the judgments inbox and the live tool-approval
 * cards — the input the state map needs for `awaiting_approval` and `stopped_after_failures`.
 *
 * The inbox names people by **Hermes profile** (a card's assignee, an approval's requester); the office knows
 * employees by NPC id. The roster links the two. A profile no employee in this channel uses is dropped.
 *
 * Pure — safe for the client bundle.
 */

import { parseRequester } from "@/lib/approval-requester";
import type { AttentionRow } from "@/lib/attention-inbox";

export type NpcAttention = { approvals: number; failedCards: number };

export function npcAttentionById(input: {
  rows: readonly AttentionRow[];
  roster: readonly { id: string; profileName?: string | null }[];
  /** Pending tool approvals per NPC id (`pendingApprovalsByNpc`). */
  toolApprovals: Readonly<Record<string, number>>;
}): Record<string, NpcAttention> {
  const npcByProfile = new Map<string, string>();
  for (const npc of input.roster) if (npc.profileName) npcByProfile.set(npc.profileName, npc.id);

  const out: Record<string, NpcAttention> = {};
  const bump = (npcId: string | undefined, key: keyof NpcAttention, by = 1) => {
    if (!npcId) return;
    const entry = (out[npcId] ??= { approvals: 0, failedCards: 0 });
    entry[key] += by;
  };

  for (const [npcId, count] of Object.entries(input.toolApprovals)) {
    if (count > 0) bump(npcId, "approvals", count);
  }
  for (const row of input.rows) {
    if (row.kind === "approval" && row.requestedBy) {
      const requester = parseRequester(row.requestedBy);
      if (requester.kind === "profile") bump(npcByProfile.get(requester.profileName), "approvals");
    } else if (row.kind === "blocked" && row.failures && row.assignee) {
      bump(npcByProfile.get(row.assignee), "failedCards");
    }
  }
  return out;
}
