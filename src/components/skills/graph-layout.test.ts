import assert from "node:assert/strict";
import test from "node:test";

import { GRAPH_PADDING, labelOnLeft, layoutGraph, timeRange, visibleAt } from "./graph-layout";

const g = {
  nodes: [
    { id: "a", label: "a", kind: "skill" as const, timestamp: 1 },
    { id: "b", label: "b", kind: "skill" as const, timestamp: 5 },
    { id: "m", label: "m", kind: "memory" as const, timestamp: null },
  ],
  edges: [
    { source: "a", target: "b" },
    { source: "a", target: "m" },
  ],
  stats: {},
};

test("same input gives the same layout, coordinates stay inside the canvas", () => {
  const one = layoutGraph(g, { width: 400, height: 300, ticks: 50 });
  const two = layoutGraph(g, { width: 400, height: 300, ticks: 50 });
  assert.deepEqual(one, two);
  for (const n of one.nodes) assert.ok(n.x >= 0 && n.x <= 400 && n.y >= 0 && n.y <= 300);
});

test("drops edges with a missing endpoint", () => {
  const out = layoutGraph(
    { ...g, edges: [{ source: "a", target: "ghost" }] },
    { width: 100, height: 100, ticks: 5 },
  );
  assert.equal(out.edges.length, 0);
});

test("does not mutate the input edges array (d3 overwrites source/target with objects)", () => {
  const edges = [{ source: "a", target: "b" }];
  layoutGraph({ ...g, edges }, { width: 100, height: 100, ticks: 5 });
  assert.deepEqual(edges, [{ source: "a", target: "b" }]);
});

test("time filter — nodes without a timestamp always show", () => {
  assert.deepEqual(
    visibleAt(g.nodes, 3).map((n) => n.id),
    ["a", "m"],
  );
  assert.equal(visibleAt(g.nodes, null).length, 3);
});

test("time range uses only nodes with a timestamp, or null if none", () => {
  assert.deepEqual(timeRange(g.nodes), { min: 1, max: 5 });
  assert.equal(timeRange([{ timestamp: null }]), null);
});

test("keeps margin at the edges — even when nodes cluster to one side, coordinates stay inside the margin", () => {
  const many = {
    nodes: Array.from({ length: 30 }, (_, i) => ({
      id: `n${i}`,
      label: `n${i}`,
      kind: "skill" as const,
      timestamp: i,
    })),
    edges: [],
    stats: {},
  };
  const out = layoutGraph(many, { width: 200, height: 120, ticks: 100 });
  for (const n of out.nodes) {
    assert.ok(n.x >= GRAPH_PADDING && n.x <= 200 - GRAPH_PADDING, `x ${n.x}`);
    assert.ok(n.y >= GRAPH_PADDING && n.y <= 120 - GRAPH_PADDING, `y ${n.y}`);
  }
});

test("nodes near the right edge put their label on the left", () => {
  assert.equal(labelOnLeft(700, 720), true);
  assert.equal(labelOnLeft(100, 720), false);
});
