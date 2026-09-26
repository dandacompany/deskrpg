import assert from "node:assert/strict";
import test from "node:test";

import type { KanbanRun, KanbanTaskDetail } from "@/lib/hermes/deskrpg-plugin-types";

import { buildArtifactProvenance, pickRun } from "./artifact-provenance";

const run = (id: string, started: number, ended?: number): KanbanRun => ({
  id,
  status: "done",
  started_at: started,
  ...(ended !== undefined ? { ended_at: ended } : {}),
});

test("the run whose window holds the artifact's creation time made it", () => {
  const runs = [run("b", 200, 300), run("a", 100, 150), run("c", 400)];
  assert.equal(pickRun(runs, 250_000)?.id, "b");
  assert.equal(pickRun(runs, 450_000)?.id, "c");
});

test("between runs, the last one that started before the artifact made it", () => {
  assert.equal(pickRun([run("a", 100, 150), run("b", 200, 300)], 170_000)?.id, "a");
});

test("without a usable time the latest run is used, and no runs gives null", () => {
  assert.equal(pickRun([run("a", 100, 150), run("b", 200, 300)], null)?.id, "b");
  assert.equal(pickRun([run("a", 100, 150)], 50_000)?.id, "a");
  assert.equal(pickRun([], 1), null);
});

test("parents that could not be read are counted, not shown", () => {
  const detail = {
    task: { id: "t", title: "T", status: "done" },
    comments: [],
    events: [],
    attachments: null,
    links: { parents: ["p1", "p2", "p3"], children: [] },
    runs: [],
  } satisfies KanbanTaskDetail;
  const p = buildArtifactProvenance(detail, null, [
    { id: "p1", title: "P1", status: "done" },
    null,
  ]);
  assert.deepEqual(p.parents, [{ id: "p1", title: "P1", status: "done" }]);
  assert.equal(p.moreParents, 2);
  assert.equal(p.run, null);
  assert.equal(p.task.assignee, null);
});
