"use client";
import { useCallback, useEffect, useRef, useState } from "react";

import { createKanbanApi, type FetchLike } from "@/components/kanban/kanban-api";

import type { GalleryAttachment } from "./card-attachments";

type BoardCursor = { boardSlug: string | undefined; cursor: string };

/**
 * Reads the card attachments the artifact gallery appends, **once per board** in the channel
 * (regardless of card count).
 *
 * - `supported` false means the plugin doesn't know the board's full attachment list — the
 *   screen renders only artifacts and notes in one line why there are none. null means it
 *   doesn't know yet (stay quiet).
 * - A failed board list/attachment lookup doesn't break the gallery. The kanban-connection
 *   notice on the artifacts side already covers that, and raising another error here would say
 *   the same thing twice.
 */
export function useCardAttachments(channelId: string, fetchImpl?: FetchLike) {
  const [items, setItems] = useState<GalleryAttachment[]>([]);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [cursors, setCursors] = useState<BoardCursor[]>([]);
  const sequence = useRef(0);

  const readBoard = useCallback(
    async (boardSlug: string | undefined, cursor?: string) => {
      const page = await createKanbanApi(channelId, fetchImpl, boardSlug).boardAttachments(cursor);
      return {
        supported: page.supported,
        items: page.attachments.map((a) => ({ ...a, boardSlug: boardSlug ?? "" })),
        next: page.next_cursor ? { boardSlug, cursor: page.next_cursor } : null,
      };
    },
    [channelId, fetchImpl],
  );

  useEffect(() => {
    const mine = ++sequence.current;
    void (async () => {
      let boards: Array<string | undefined>;
      try {
        const { projects } = await createKanbanApi(channelId, fetchImpl).projects();
        boards = projects.length > 0 ? projects.map((p) => p.boardSlug) : [undefined];
      } catch {
        boards = [undefined];
      }
      const pages = await Promise.all(boards.map((b) => readBoard(b).catch(() => null)));
      if (mine !== sequence.current) return;
      const ok = pages.filter((p): p is NonNullable<typeof p> => p !== null);
      setSupported(ok.length === 0 ? null : ok.some((p) => p.supported));
      setItems(ok.flatMap((p) => p.items));
      setCursors(ok.flatMap((p) => (p.next ? [p.next] : [])));
    })();
  }, [channelId, fetchImpl, readBoard]);

  const loadMore = useCallback(async () => {
    const mine = sequence.current;
    const pages = await Promise.all(
      cursors.map((c) => readBoard(c.boardSlug, c.cursor).catch(() => null)),
    );
    if (mine !== sequence.current) return;
    const ok = pages.filter((p): p is NonNullable<typeof p> => p !== null);
    setItems((prev) => {
      const seen = new Set(prev.map((a) => `${a.boardSlug}\u0000${a.id}`));
      return [
        ...prev,
        ...ok.flatMap((p) => p.items).filter((a) => !seen.has(`${a.boardSlug}\u0000${a.id}`)),
      ];
    });
    setCursors(ok.flatMap((p) => (p.next ? [p.next] : [])));
  }, [cursors, readBoard]);

  return { items, supported, hasMore: cursors.length > 0, loadMore };
}
