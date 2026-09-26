"use client";

import { useEffect, useMemo, useRef } from "react";

import { useNpcApprovalCounts } from "@/components/approvals/ToolApprovalsProvider";
import { EventBus } from "@/game/EventBus";
import { useT } from "@/lib/i18n";
import type { AttentionRow } from "@/lib/attention-inbox";
import { npcAttentionById } from "@/lib/npc-attention";
import { npcStates, type NpcConnection, type NpcStateKind } from "@/lib/npc-state-map";

export type NpcStatesById = Record<string, NpcStateKind[]>;

/**
 * Computes every employee's state list (D08) and hands it up. It lives **inside** `ToolApprovalsProvider`
 * because pending tool approvals are only readable there, while the page that draws the navigator and the
 * map wraps itself in that provider. Renders nothing.
 */
export default function NpcStatesBridge(props: {
  npcs: readonly { id: string; profileName?: string | null }[];
  connection: NpcConnection;
  attentionRows: readonly AttentionRow[];
  workingCounts: Readonly<Record<string, number>>;
  responding: Readonly<Record<string, unknown>>;
  responseFailed: ReadonlySet<string>;
  reporting: ReadonlySet<string>;
  onStates: (states: NpcStatesById) => void;
}) {
  const t = useT();
  const toolApprovals = useNpcApprovalCounts();
  const { npcs, connection, attentionRows, workingCounts, responding, responseFailed, reporting } =
    props;

  const states = useMemo(() => {
    const attention = npcAttentionById({ rows: attentionRows, roster: npcs, toolApprovals });
    const out: NpcStatesById = {};
    for (const npc of npcs) {
      out[npc.id] = npcStates({
        connection,
        approvals: attention[npc.id]?.approvals ?? 0,
        failedCards: attention[npc.id]?.failedCards ?? 0,
        responseFailed: responseFailed.has(npc.id),
        responding: Boolean(responding[npc.id]),
        workingCount: workingCounts[npc.id] ?? 0,
        reporting: reporting.has(npc.id),
      });
    }
    return out;
  }, [
    npcs,
    connection,
    attentionRows,
    toolApprovals,
    workingCounts,
    responding,
    responseFailed,
    reporting,
  ]);

  // The leading state in words for the name tag's tooltip — the renderer has no translator.
  const labels = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [npcId, list] of Object.entries(states)) {
      const first = list[0];
      if (first && first !== "responding")
        out[npcId] = t(`workspace.state.${first}`, { count: workingCounts[npcId] ?? 1 });
    }
    return out;
  }, [states, t, workingCounts]);

  // Hand up only real changes — the parent re-renders the whole page on every state set.
  const last = useRef("");
  const onStates = props.onStates;
  useEffect(() => {
    const serialized = JSON.stringify(states);
    if (serialized === last.current) return;
    last.current = serialized;
    onStates(states);
  }, [states, onStates]);

  // The map gets the same lists; resent when the scene comes up late, like `npc:working-state`.
  useEffect(() => {
    const publish = () => EventBus.emit("npc:states", { states, labels });
    publish();
    EventBus.on("scene-ready", publish);
    return () => {
      EventBus.off("scene-ready", publish);
    };
  }, [states, labels]);

  return null;
}
