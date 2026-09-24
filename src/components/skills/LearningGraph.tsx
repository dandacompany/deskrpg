"use client";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useT } from "@/lib/i18n";
import type { LearningGraph as Graph, LearningNodeDetail } from "@/lib/hermes/plugin-client-types";

import { labelOnLeft, layoutGraph, timeRange, visibleAt } from "./graph-layout";
import { skillErrorText } from "./skill-error-text";
import { SkillsApiError, type SkillsApi } from "./skills-api";

const W = 720;
const H = 420;

export type LearningGraphProps = {
  api: SkillsApi;
  canManage: boolean;
  /** Editing/archiving a skill node may have changed the skill list. */
  onChanged(): void;
};

/**
 * The learning graph — draws skill nodes (and, for owners, file-memory nodes) with a
 * force-layout SVG. Edges just mean "vocabulary overlaps", not causation or mastery. Filtering
 * out memory nodes is the server's job (they're absent from member responses); here we just draw
 * what we receive.
 * Node edit/delete send the hash received on read as `baseHash` — a memory id is a sequence
 * number, so if the file changes in the meantime it can point at a different chunk.
 */
export default function LearningGraph({ api, canManage, onChanged }: LearningGraphProps) {
  const t = useT();
  const [graph, setGraph] = useState<Graph | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [time, setTime] = useState<number | null>(null);
  const [node, setNode] = useState<LearningNodeDetail | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setGraph(await api.graph());
      setLoadError(null);
    } catch (e) {
      setLoadError(skillErrorText(t, e));
    }
  }, [api, t]);
  useEffect(() => {
    void load();
  }, [load]);
  const laid = useMemo(() => (graph ? layoutGraph(graph, { width: W, height: H }) : null), [graph]);

  if (loadError) return <p className="p-5 text-sm text-danger">{loadError}</p>;
  if (!laid) return null;

  const range = timeRange(laid.nodes);
  const shown = visibleAt(laid.nodes, time);
  const shownIds = new Set(shown.map((n) => n.id));
  const pos = new Map(laid.nodes.map((n) => [n.id, n]));
  const hasMemory = laid.nodes.some((n) => n.kind === "memory");

  const openNode = async (id: string) => {
    setError(null);
    setConfirmDelete(false);
    setConflict(false);
    try {
      const d = await api.node(id);
      setNode(d);
      setDraft(d.content);
      setEditing(false);
    } catch (e) {
      setError(skillErrorText(t, e));
    }
  };
  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      if (e instanceof SkillsApiError && e.code === "node_changed") {
        // Leave the edited content as-is and just reload the graph. New content comes via [Reload].
        setConflict(true);
        setConfirmDelete(false);
        await load();
      } else {
        setError(skillErrorText(t, e));
      }
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    act(async () => {
      if (!node) return;
      await api.putNode(node.id, draft, node.hash);
      await openNode(node.id);
      await load();
      onChanged();
    });
  const remove = () =>
    act(async () => {
      if (!node) return;
      await api.deleteNode(node.id, node.hash);
      setNode(null);
      await load();
      onChanged();
    });

  return (
    <div className="flex min-h-0 flex-1 flex-wrap gap-3 overflow-y-auto p-4 text-sm">
      <div className="flex min-w-0 max-w-[720px] flex-1 flex-col gap-2">
        {laid.nodes.length === 0 ? (
          <p className="text-text-dim">{t("skills.graph.empty")}</p>
        ) : (
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="h-auto w-full rounded border border-border bg-surface"
            role="img"
            aria-label={t("skills.tab.graph")}
          >
            {laid.edges
              .filter((e) => shownIds.has(e.source) && shownIds.has(e.target))
              .map((e) => (
                <line
                  key={`${e.source}>${e.target}`}
                  x1={pos.get(e.source)!.x}
                  y1={pos.get(e.source)!.y}
                  x2={pos.get(e.target)!.x}
                  y2={pos.get(e.target)!.y}
                  className="stroke-border"
                />
              ))}
            {shown.map((n) => (
              <g
                key={n.id}
                transform={`translate(${n.x},${n.y})`}
                onClick={() => void openNode(n.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") void openNode(n.id);
                }}
                role="button"
                tabIndex={0}
                aria-label={n.label}
                className="cursor-pointer"
              >
                <circle
                  data-node={n.id}
                  r={n.kind === "memory" ? 5 : 8}
                  className={`${n.kind === "memory" ? "fill-text-muted" : "fill-primary"} ${
                    node?.id === n.id ? "stroke-text" : ""
                  }`}
                />
                <text
                  x={labelOnLeft(n.x, W) ? -10 : 10}
                  y={4}
                  textAnchor={labelOnLeft(n.x, W) ? "end" : "start"}
                  className="fill-text text-[10px]"
                >
                  {n.label.slice(0, 24)}
                </text>
              </g>
            ))}
          </svg>
        )}
        {range && range.max > range.min && (
          <label className="flex items-center gap-2 text-xs text-text-muted">
            {t("skills.graph.time")}
            <input
              type="range"
              min={range.min}
              max={range.max}
              value={time ?? range.max}
              onChange={(e) => {
                const v = Number(e.target.value);
                setTime(v >= range.max ? null : v);
              }}
              className="flex-1"
            />
          </label>
        )}
        <p className="text-xs text-text-muted">{t("skills.graph.edgeMeaning")}</p>
        {hasMemory && <p className="text-xs text-text-muted">{t("skills.graph.fileMemoryOnly")}</p>}
      </div>
      {node && (
        <aside className="flex min-w-[260px] flex-1 flex-col gap-2">
          <h4 className="truncate font-semibold text-text">
            {node.kind === "memory"
              ? `${t("skills.graph.memory")} · ${node.content.split("\n")[0].slice(0, 60)}`
              : node.id}
          </h4>
          <textarea
            value={draft}
            readOnly={!editing}
            onChange={(e) => setDraft(e.target.value)}
            aria-label={node.id}
            className="min-h-40 flex-1 rounded border border-border bg-surface-raised p-2 font-mono text-xs text-text"
          />
          {conflict && (
            <div className="rounded border border-border p-2 text-xs text-text">
              {t("skills.error.node_changed")}{" "}
              <button
                type="button"
                data-action="node-reload"
                className="text-primary"
                onClick={() => void openNode(node.id)}
              >
                {t("skills.reload")}
              </button>
            </div>
          )}
          {error && <p className="text-xs text-danger">{error}</p>}
          {canManage && (
            <div className="flex gap-3 text-xs">
              {editing ? (
                <button
                  type="button"
                  data-action="node-save"
                  disabled={busy}
                  onClick={() => void save()}
                  className="text-primary disabled:opacity-50"
                >
                  {t("skills.save")}
                </button>
              ) : (
                <button
                  type="button"
                  data-action="node-edit"
                  onClick={() => setEditing(true)}
                  className="text-primary"
                >
                  {t("skills.edit")}
                </button>
              )}
              <button
                type="button"
                data-action="node-delete"
                disabled={busy}
                onClick={() => setConfirmDelete(true)}
                className="text-danger disabled:opacity-50"
              >
                {node.kind === "memory" ? t("skills.purge") : t("skills.archive")}
              </button>
            </div>
          )}
          {canManage && confirmDelete && (
            <div className="rounded border border-border p-2 text-xs">
              <p className="text-text">
                {node.kind === "memory"
                  ? t("skills.graph.deleteMemory")
                  : t("skills.graph.deleteSkill")}
              </p>
              <p className="mt-1 whitespace-pre-wrap text-text-muted">
                {node.content.slice(0, 120)}
              </p>
              <div className="mt-2 flex gap-3">
                <button
                  type="button"
                  data-action="node-delete-confirm"
                  disabled={busy}
                  onClick={() => void remove()}
                  className="text-danger disabled:opacity-50"
                >
                  {t("common.confirm")}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="text-text-muted"
                >
                  {t("common.cancel")}
                </button>
              </div>
            </div>
          )}
        </aside>
      )}
    </div>
  );
}
