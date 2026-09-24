"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Package, X } from "lucide-react";

import { useT } from "@/lib/i18n";
import type { ArtifactSummary } from "@/lib/hermes/deskrpg-plugin-types";
import GateChecklistModal from "@/components/gateway/GateChecklistModal";
import { useGateBlocker } from "@/components/gateway/useGateBlocker";
import { isSetupBlocker } from "@/lib/gate-failure";

import ArtifactList, { type ArtifactFilter, type ArtifactListNpc } from "./ArtifactList";
import ArtifactViewer, { type ArtifactViewerHandle } from "./ArtifactViewer";
import { ArtifactsApiError, createArtifactsApi } from "./artifacts-api";
import type { SourceTarget } from "./artifact-view-model";
import { visibleCardAttachments } from "./card-attachments";
import { useCardAttachments } from "./use-card-attachments";
import { createKanbanApi } from "@/components/kanban/kanban-api";

export type ArtifactsModalProps = {
  channelId: string;
  npcs: ArtifactListNpc[];
  /** Bumps on every `artifact:event` (GamePageClient holds the socket). Debounced to reload the list. */
  refreshTick: number;
  lastEvent: { kind: string; artifactId: string } | null;
  initialArtifactId?: string | null;
  /** Filter used when opening from a card — attached as `taskId` on every list request. */
  initialTaskId?: string | null;
  onOpenSource(target: SourceTarget): void;
  onClose(): void;
  /** Event -> reload debounce (ms). Defaults to `ARTIFACTS_EVENT_DEBOUNCE_MS`. */
  debounceMs?: number;
};

/** Interval that folds rapid-fire `artifact:event`s into a single reload. */
export const ARTIFACTS_EVENT_DEBOUNCE_MS = 300;

/**
 * The channel artifacts modal. The left side is the filter/list, the right side is the viewer
 * for the selected artifact. The list reloads immediately when the filter changes, and reloads
 * from scratch (debounced) when `refreshTick` bumps. 409/428 render a notice instead of the list.
 */
export default function ArtifactsModal({
  channelId,
  npcs,
  refreshTick,
  lastEvent,
  initialArtifactId = null,
  initialTaskId = null,
  onOpenSource,
  onClose,
  debounceMs = ARTIFACTS_EVENT_DEBOUNCE_MS,
}: ArtifactsModalProps) {
  const t = useT();
  const api = useMemo(() => createArtifactsApi(channelId), [channelId]);
  const cardAttachments = useCardAttachments(channelId);
  const [filter, setFilter] = useState<ArtifactFilter>({});
  const [items, setItems] = useState<ArtifactSummary[]>([]);
  const [cursor, setCursor] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ArtifactsApiError | null>(null);
  const gateBlocker = useGateBlocker();
  const [checklistOpen, setChecklistOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(initialArtifactId);
  const [viewerReload, setViewerReload] = useState(0);
  const sequence = useRef(0);
  const viewerRef = useRef<ArtifactViewerHandle | null>(null);

  // Every way to close the modal (Escape/backdrop/X) and picking a different artifact first confirms unsaved edits.
  const guarded = useCallback((proceed: () => void) => {
    if (viewerRef.current) viewerRef.current.requestClose(proceed);
    else proceed();
  }, []);
  const requestModalClose = useCallback(() => guarded(onClose), [guarded, onClose]);

  useEffect(() => {
    if (initialArtifactId) setSelectedId(initialArtifactId);
  }, [initialArtifactId]);

  const load = useCallback(
    async (after?: string) => {
      const mine = ++sequence.current;
      setLoading(true);
      try {
        const page = await api.list({ ...filter, taskId: initialTaskId ?? undefined }, after);
        if (mine !== sequence.current) return;
        setItems((prev) => {
          if (!after) return page.artifacts;
          const seen = new Set(prev.map((a) => a.id));
          return [...prev, ...page.artifacts.filter((a) => !seen.has(a.id))];
        });
        setCursor(page.cursor);
        setHasMore(page.has_more);
        setError(null);
      } catch (err) {
        if (mine !== sequence.current) return;
        const apiErr =
          err instanceof ArtifactsApiError
            ? err
            : new ArtifactsApiError(0, "unknown", err instanceof Error ? err.message : String(err));
        setError(apiErr);
        gateBlocker.showFromError(apiErr);
      } finally {
        if (mine === sequence.current) setLoading(false);
      }
    },
    // useGateBlocker() gives a new object on every render, so including gateBlocker whole would
    // recreate load every time and cause a reload loop. showFromError is stable, so only that goes in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, filter, initialTaskId, gateBlocker.showFromError],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // `artifact:event` — reload from scratch after a debounce. Reads the latest `load` via a ref
  // so that a filter change alone doesn't re-arm this timer.
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (refreshTick === 0) return;
    const timer = setTimeout(() => void loadRef.current(), debounceMs);
    return () => clearTimeout(timer);
  }, [refreshTick, debounceMs]);

  const removeItem = useCallback((id: string) => {
    setItems((prev) => prev.filter((a) => a.id !== id));
    setSelectedId((cur) => (cur === id ? null : cur));
  }, []);

  useEffect(() => {
    if (!lastEvent) return;
    if (lastEvent.kind === "artifact.deleted") removeItem(lastEvent.artifactId);
    else if (lastEvent.kind === "artifact.versioned" && lastEvent.artifactId === selectedId)
      setViewerReload((n) => n + 1);
    // selectedId is deliberately left out — changing the selection shouldn't reapply a past event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastEvent, removeItem]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // If the list's image zoom view gets it first and calls preventDefault, the modal doesn't close.
      if (e.key === "Escape" && !e.defaultPrevented) requestModalClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestModalClose]);

  const gate = error?.status === 409 ? "gateway" : error?.status === 428 ? "upgrade" : null;

  return (
    // Must float above the kanban modal (z-50) when opened from a kanban card's artifacts section.
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60"
      onClick={requestModalClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="artifacts-modal-title"
        className="bg-bg border border-border rounded-xl shadow-2xl w-[96vw] max-w-[1400px] h-[88dvh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-b border-border flex-shrink-0">
          <h2 id="artifacts-modal-title" className="text-sm font-bold flex items-center gap-1.5">
            <Package className="w-4 h-4" />
            {t("artifacts.title")}
          </h2>
          <button
            type="button"
            onClick={requestModalClose}
            aria-label={t("common.close")}
            className="ml-1 text-text-muted hover:text-text"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {gate ? (
          <div className="flex-1 overflow-y-auto p-4">
            <div
              data-gate={gate}
              className="mx-auto mt-8 max-w-[560px] rounded-xl border border-border bg-surface p-5 text-xs"
            >
              <div className="text-sm font-bold text-text flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4 text-npc-dark" />
                {gate === "gateway"
                  ? t("artifacts.gate.gateway")
                  : t("artifacts.gate.upgrade", { minVersion: error?.minVersion ?? "0.8.0" })}
              </div>
              {gateBlocker.blocker && isSetupBlocker(gateBlocker.blocker) && (
                <button
                  type="button"
                  onClick={() => setChecklistOpen(true)}
                  className="mt-2 underline"
                >
                  {t("gateChecklist.whatIsNeeded")}
                </button>
              )}
            </div>
          </div>
        ) : (
          <>
            {error && (
              <div className="flex items-center gap-2 px-5 py-2 border-b border-border text-xs text-danger">
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                <span className="break-words">
                  {t("artifacts.error")} — {error.message}
                </span>
                {gateBlocker.blocker && isSetupBlocker(gateBlocker.blocker) && (
                  <button
                    type="button"
                    onClick={() => setChecklistOpen(true)}
                    className="underline"
                  >
                    {t("gateChecklist.whatIsNeeded")}
                  </button>
                )}
                <button type="button" className="ml-auto underline" onClick={() => void load()}>
                  {t("common.retry")}
                </button>
              </div>
            )}
            <div className="flex flex-1 min-h-0">
              <div
                className={`w-full md:w-[380px] md:flex-shrink-0 md:border-r border-border min-h-0 ${
                  selectedId ? "hidden md:block" : "block"
                }`}
              >
                <ArtifactList
                  items={items}
                  filter={filter}
                  onFilter={setFilter}
                  npcs={npcs}
                  selectedId={selectedId}
                  onSelect={(id) => guarded(() => setSelectedId(id))}
                  hasMore={hasMore}
                  loading={loading}
                  onLoadMore={() => void load(cursor)}
                  thumbnailUrl={(a) => api.contentUrl(a.id, a.current_version)}
                  cardAttachments={visibleCardAttachments(
                    cardAttachments.items,
                    items,
                    filter,
                    initialTaskId,
                  )}
                  cardAttachmentsSupported={cardAttachments.supported}
                  cardAttachmentsHasMore={cardAttachments.hasMore}
                  onLoadMoreCardAttachments={() => void cardAttachments.loadMore()}
                  cardAttachmentUrl={(file) =>
                    createKanbanApi(
                      channelId,
                      undefined,
                      file.boardSlug || undefined,
                    ).attachmentUrl(file.id)
                  }
                />
              </div>
              <div className={`flex-1 min-w-0 min-h-0 ${selectedId ? "block" : "hidden md:block"}`}>
                {selectedId ? (
                  <ArtifactViewer
                    ref={viewerRef}
                    key={selectedId}
                    api={api}
                    artifactId={selectedId}
                    reloadKey={viewerReload}
                    onOpenSource={onOpenSource}
                    onDeleted={removeItem}
                    onClose={() => setSelectedId(null)}
                  />
                ) : (
                  <div className="h-full flex items-center justify-center text-text-dim">
                    <Package className="w-10 h-10 opacity-30" aria-hidden="true" />
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
      <GateChecklistModal
        blocker={checklistOpen ? gateBlocker.blocker : null}
        onClose={() => setChecklistOpen(false)}
      />
    </div>
  );
}
