import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";

import LearningGraph from "./LearningGraph";
import { createSkillsApi } from "./skills-api";
import {
  $,
  ROOT,
  cleanup,
  click,
  container,
  flush,
  mockFetch,
  render,
  text,
  type,
} from "./skills-test-harness";

const GRAPH = `GET ${ROOT}/learning/graph`;
const MEM_ID = "memory:MEMORY.md:0";
const NODE = `GET ${ROOT}/learning/node?id=${encodeURIComponent(MEM_ID)}`;
const graph = (withMemory = true) => ({
  nodes: [
    { id: "weekly", label: "weekly", kind: "skill", timestamp: 100 },
    { id: "pdf", label: "pdf", kind: "skill", timestamp: 200 },
    ...(withMemory ? [{ id: MEM_ID, label: "월요일 보고", kind: "memory", timestamp: null }] : []),
  ],
  edges: [
    { source: "weekly", target: "pdf" },
    ...(withMemory ? [{ source: "weekly", target: MEM_ID }] : []),
  ],
  stats: {},
});
const memDetail = { id: MEM_ID, kind: "memory", content: "월요일 보고는 9시\n둘째 줄", hash: "m1" };

const view = (canManage: boolean) => (
  <LearningGraph api={createSkillsApi("ch-1", "n-1")} canManage={canManage} onChanged={() => {}} />
);

async function clickNode(id: string) {
  const el = $(`[data-node="${id}"]`);
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

test.afterEach(cleanup);

test("one circle per node, an edge-meaning caption, and a file-memory note when a memory node exists", async () => {
  mockFetch({ [GRAPH]: graph() });
  await render(view(true));
  assert.equal(container.querySelectorAll("circle[data-node]").length, 3);
  assert.equal(container.querySelectorAll("line").length, 2);
  assert.ok(text().includes("어휘가 겹친다"));
  assert.ok(text().includes("파일 메모리"));
});

test("no memory (member response) means no file-memory note either", async () => {
  mockFetch({ [GRAPH]: graph(false) });
  await render(view(false));
  assert.equal(container.querySelectorAll("circle[data-node]").length, 2);
  assert.ok(!text().includes("파일 메모리"));
});

test("deleting a memory node goes through an irreversible-action confirmation showing the content start, then DELETEs with {id, baseHash}", async () => {
  const log = mockFetch({
    [GRAPH]: graph(),
    [NODE]: memDetail,
    [`DELETE ${ROOT}/learning/node`]: { id: MEM_ID, kind: "memory", result: "deleted" },
  });
  await render(view(true));
  await clickNode(MEM_ID);
  assert.ok(text().includes("월요일 보고는 9시"));
  await click('[data-action="node-delete"]');
  assert.ok(text().includes("되돌릴 수 없습니다"));
  assert.ok(!log.calls.includes(`DELETE ${ROOT}/learning/node`));
  await click('[data-action="node-delete-confirm"]');
  assert.deepEqual(log.bodies[`DELETE ${ROOT}/learning/node`], { id: MEM_ID, baseHash: "m1" });
  assert.equal(log.calls.filter((c) => c === GRAPH).length, 2);
});

test("the delete notice for a skill node is really an archive", async () => {
  mockFetch({
    [GRAPH]: graph(),
    [`GET ${ROOT}/learning/node?id=weekly`]: {
      id: "weekly",
      kind: "skill",
      content: "---\nname: weekly\n---",
      hash: "s1",
    },
  });
  await render(view(true));
  await clickNode("weekly");
  await click('[data-action="node-delete"]');
  assert.ok(text().includes("보관함에서 복원"));
});

test("saving an edit sends {id, content, baseHash}; a 409 node_changed keeps the edit and reloads", async () => {
  const log = mockFetch({
    [GRAPH]: graph(),
    [NODE]: memDetail,
    [`PUT ${ROOT}/learning/node`]: { status: 409, json: { code: "node_changed", message: "" } },
  });
  await render(view(true));
  await clickNode(MEM_ID);
  assert.equal(($("textarea") as HTMLTextAreaElement).readOnly, true);
  await click('[data-action="node-edit"]');
  await type("textarea", "고친 기억");
  await click('[data-action="node-save"]');
  assert.deepEqual(log.bodies[`PUT ${ROOT}/learning/node`], {
    id: MEM_ID,
    content: "고친 기억",
    baseHash: "m1",
  });
  assert.equal(($("textarea") as HTMLTextAreaElement).value, "고친 기억");
  assert.ok(container.querySelector('[data-action="node-reload"]'));
  assert.equal(log.calls.filter((c) => c === GRAPH).length, 2);
});

test("members have no edit/delete buttons", async () => {
  mockFetch({
    [GRAPH]: graph(false),
    [`GET ${ROOT}/learning/node?id=weekly`]: {
      id: "weekly",
      kind: "skill",
      content: "x",
      hash: "s1",
    },
  });
  await render(view(false));
  await clickNode("weekly");
  assert.ok(container.querySelector("textarea"));
  assert.ok(!container.querySelector('[data-action="node-edit"]'));
  assert.ok(!container.querySelector('[data-action="node-delete"]'));
});

test("pulling the time slider earlier hides later nodes", async () => {
  mockFetch({ [GRAPH]: graph() });
  await render(view(true));
  const slider = $('input[type="range"]') as HTMLInputElement;
  assert.equal(slider.min, "100");
  assert.equal(slider.max, "200");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(slider, "150");
    slider.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
  assert.ok(!container.querySelector('[data-node="pdf"]'));
  assert.ok(container.querySelector('[data-node="weekly"]'));
  assert.ok(container.querySelector(`[data-node="${MEM_ID}"]`));
});

test("deleting a skill node with a 409 skill_pinned shows an unpin-first notice", async () => {
  mockFetch({
    [GRAPH]: graph(),
    [`GET ${ROOT}/learning/node?id=weekly`]: {
      id: "weekly",
      kind: "skill",
      content: "x",
      hash: "s1",
    },
    [`DELETE ${ROOT}/learning/node`]: {
      status: 409,
      json: { code: "skill_pinned", message: "" },
    },
  });
  await render(view(true));
  await clickNode("weekly");
  await click('[data-action="node-delete"]');
  await click('[data-action="node-delete-confirm"]');
  assert.ok(text().includes("먼저 고정을 해제하세요"));
});

test("labels draw beside the circle, and right-edge nodes flip to the left", async () => {
  mockFetch({ [GRAPH]: graph() });
  await render(view(true));
  for (const el of Array.from(container.querySelectorAll("g[role=button]"))) {
    const x = Number(/translate\(([-\d.]+),/.exec(el.getAttribute("transform")!)![1]);
    const label = el.querySelector("text")!;
    assert.equal(label.getAttribute("text-anchor"), x > 720 - 160 ? "end" : "start");
  }
});
