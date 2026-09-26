"use client";

import { useEffect, useState } from "react";

import { createAttentionApi } from "@/components/attention/attention-api";
import type { AttentionRow } from "@/lib/attention-inbox";

/** Fallback refresh when no card event arrives — approvals decided elsewhere, a card unblocked in Hermes. */
const REFRESH_MS = 60_000;
/** Card events come in bursts (a run starts, a status changes); one read covers the burst. */
const EVENT_DEBOUNCE_MS = 2_000;

type EventSocket = {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
};

/**
 * The judgments inbox rows for the office state map (D08) — who waits on a person, per employee.
 *
 * Read on join, again after card events settle, and once a minute. A failed read keeps the last rows: the
 * state map then shows the last known approvals rather than dropping them. The inbox modal reads on its own.
 */
export function useAttentionRows(
  channelId: string | null,
  socket: EventSocket | null,
): readonly AttentionRow[] {
  // Keyed by channel so a previous channel's rows are never returned for the next one.
  const [loaded, setLoaded] = useState<{ channelId: string; rows: readonly AttentionRow[] } | null>(
    null,
  );

  useEffect(() => {
    if (!channelId) return;
    const api = createAttentionApi(channelId);
    let alive = true;
    let controller: AbortController | null = null;
    let debounce: ReturnType<typeof setTimeout> | null = null;

    const load = () => {
      controller?.abort();
      controller = new AbortController();
      api
        .load(controller.signal)
        .then((inbox) => {
          if (alive) setLoaded({ channelId, rows: inbox.rows });
        })
        .catch(() => {});
    };
    const onCardEvent = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(load, EVENT_DEBOUNCE_MS);
    };

    load();
    const interval = setInterval(load, REFRESH_MS);
    socket?.on("kanban:event", onCardEvent);
    return () => {
      alive = false;
      controller?.abort();
      clearInterval(interval);
      if (debounce) clearTimeout(debounce);
      socket?.off("kanban:event", onCardEvent);
    };
  }, [channelId, socket]);

  return loaded && loaded.channelId === channelId ? loaded.rows : NO_ROWS;
}

const NO_ROWS: readonly AttentionRow[] = [];
