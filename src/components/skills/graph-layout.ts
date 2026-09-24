import {
  forceCenter,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationNodeDatum,
} from "d3-force";

import type { LearningGraph, LearningNode } from "@/lib/hermes/plugin-client-types";

type Sim = LearningNode & SimulationNodeDatum;

/** Canvas edge padding (px) — keeps circles and label tops from being clipped. */
export const GRAPH_PADDING = 16;
/** Rough width a label (max 24 chars, 10px) takes up. Flip the label to the left once a node gets this close to the right edge. */
const LABEL_WIDTH = 160;

/** Nodes near the right edge flip their label to the left of the circle — padding alone isn't enough for a long label. */
export const labelOnLeft = (x: number, width: number) => x > width - LABEL_WIDTH;
export type PlacedNode = LearningNode & { x: number; y: number };

/** Spreads an id over [0,1) with FNV-1a — used instead of randomness for the initial position so layout is deterministic. */
function seed(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) / 2 ** 32;
}

/**
 * Lays out the learning graph with a 2D force simulation. Deterministic (initial positions come
 * from an id hash, and the simulation stays stopped, only ticking `ticks` times).
 * Edges with a missing endpoint are dropped, and coordinates are clamped inside the canvas
 * (`GRAPH_PADDING` margin). d3 overwrites edge objects, so the input is passed in as a copy.
 */
export function layoutGraph(
  graph: LearningGraph,
  opts: { width: number; height: number; ticks?: number },
): { nodes: PlacedNode[]; edges: { source: string; target: string }[] } {
  const ids = new Set(graph.nodes.map((n) => n.id));
  const nodes: Sim[] = graph.nodes.map((n) => ({
    ...n,
    x: seed(n.id) * opts.width,
    y: seed(`${n.id}#`) * opts.height,
  }));
  const edges = graph.edges
    .filter((e) => ids.has(e.source) && ids.has(e.target))
    .map((e) => ({ source: e.source, target: e.target }));
  const sim = forceSimulation(nodes)
    .force("charge", forceManyBody().strength(-60))
    .force(
      "link",
      forceLink(edges.map((e) => ({ ...e })))
        .id((d) => (d as Sim).id)
        .distance(60),
    )
    .force("center", forceCenter(opts.width / 2, opts.height / 2))
    .stop();
  for (let i = 0; i < (opts.ticks ?? 200); i += 1) sim.tick();
  const clamp = (v: number, max: number) =>
    Math.max(GRAPH_PADDING, Math.min(max - GRAPH_PADDING, v));
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      label: n.label,
      kind: n.kind,
      timestamp: n.timestamp ?? null,
      category: n.category,
      x: clamp(n.x ?? 0, opts.width),
      y: clamp(n.y ?? 0, opts.height),
    })),
    edges,
  };
}

/** Time slider — only nodes with a timestamp at or before `t`. Nodes without one (e.g. memory) always show. `t=null` shows all. */
export function visibleAt<T extends { timestamp?: number | null }>(
  nodes: T[],
  t: number | null,
): T[] {
  return t === null ? nodes : nodes.filter((n) => n.timestamp == null || n.timestamp <= t);
}

/** Both ends of the slider. `null` if no node has a timestamp (the slider then isn't drawn). */
export function timeRange(
  nodes: { timestamp?: number | null }[],
): { min: number; max: number } | null {
  const stamps = nodes.map((n) => n.timestamp).filter((s): s is number => typeof s === "number");
  if (stamps.length === 0) return null;
  return { min: Math.min(...stamps), max: Math.max(...stamps) };
}
