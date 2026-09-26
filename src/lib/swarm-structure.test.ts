import assert from "node:assert/strict";
import test from "node:test";

import { isSwarmStructureCard, isSwarmStructureRun } from "./swarm-structure";

test("the swarm activation run is recognized by its metadata kind, object or JSON text", () => {
  assert.equal(isSwarmStructureRun({ metadata: { kind: "kanban_swarm_v1" } }), true);
  assert.equal(isSwarmStructureRun({ metadata: '{"kind":"kanban_swarm_v1"}' }), true);
  assert.equal(isSwarmStructureRun({ metadata: { kind: "other" } }), false);
  assert.equal(isSwarmStructureRun({ metadata: "not json" }), false);
  assert.equal(isSwarmStructureRun({}), false);
});

test("the swarm root card is recognized by the body Hermes writes for it", () => {
  assert.equal(
    isSwarmStructureCard({ body: "Kanban Swarm v1 planning/root card. This card is completed…" }),
    true,
  );
  assert.equal(isSwarmStructureCard({ body: "A normal card" }), false);
  assert.equal(isSwarmStructureCard({ body: null }), false);
});
