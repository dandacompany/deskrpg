import assert from "node:assert/strict";
import test from "node:test";

import CuratorBar from "./CuratorBar";
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
} from "./skills-test-harness";

const CURATOR = `GET ${ROOT}/curator`;
const status = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  paused: false,
  intervalHours: 24,
  lastRunAt: "2026-09-23T08:30:00Z",
  minIdleHours: 2,
  staleAfterDays: 14,
  archiveAfterDays: 30,
  ...over,
});

const bar = (canManage: boolean) => (
  <CuratorBar api={createSkillsApi("ch-1", "n-1")} canManage={canManage} pollIntervalMs={1} />
);

test.afterEach(cleanup);

test("status, last run, and threshold days on one line", async () => {
  mockFetch({ [CURATOR]: status() });
  await render(bar(false));
  assert.ok(text().includes("자동 정리 켜짐"));
  assert.ok(text().includes("2026-09-23 08:30"));
  assert.ok(text().includes("14일"));
  assert.ok(text().includes("30일"));
  assert.ok(!container.querySelector('[data-action="curator-pause"]'));
  assert.ok(!container.querySelector('[data-action="curator-run"]'));
});

test("pause sends PUT …/curator/paused then reloads", async () => {
  const log = mockFetch({ [CURATOR]: status(), [`PUT ${ROOT}/curator/paused`]: { paused: true } });
  await render(bar(true));
  await click('[data-action="curator-pause"]');
  assert.deepEqual(log.bodies[`PUT ${ROOT}/curator/paused`], { paused: true });
  assert.equal(log.calls.filter((c) => c === CURATOR).length, 2);
});

test("run now starts the job after confirmation and polls to completion", async () => {
  const log = mockFetch({
    [CURATOR]: status(),
    [`POST ${ROOT}/curator/runs`]: { jobId: "c1" },
    [`GET ${ROOT}/curator/runs/c1`]: {
      jobId: "c1",
      kind: "curator_run",
      state: "succeeded",
      exitCode: 0,
      outputTail: "",
    },
  });
  await render(bar(true));
  await click('[data-action="curator-run"]');
  assert.ok(text().includes("보관하거나 합칠 수 있습니다"));
  assert.ok(!log.calls.includes(`POST ${ROOT}/curator/runs`));
  await click('[data-action="curator-run-confirm"]');
  await flush();
  assert.ok(log.calls.includes(`GET ${ROOT}/curator/runs/c1`));
  assert.equal($("[data-job-state]").dataset.jobState, "succeeded");
});

test("shows a notice when another job is running (job_busy)", async () => {
  mockFetch({
    [CURATOR]: status(),
    [`POST ${ROOT}/curator/runs`]: { status: 409, json: { code: "job_busy", message: "" } },
  });
  await render(bar(true));
  await click('[data-action="curator-run"]');
  await click('[data-action="curator-run-confirm"]');
  assert.ok(text().includes("다른 설치·정리 작업이 진행 중입니다"));
});
