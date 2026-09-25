import assert from "node:assert/strict";
import test from "node:test";

import SkillArchivePane from "./SkillArchivePane";
import { createSkillsApi } from "./skills-api";
import {
  $,
  ROOT,
  cleanup,
  click,
  container,
  mockFetch,
  render,
  text,
  type,
} from "./skills-test-harness";

const ARCHIVE = `GET ${ROOT}/archive`;
const archived = { archived: [{ name: "weekly", archivedAt: "2026-09-20T10:00:00Z" }] };

const pane = (canManage: boolean) => (
  <SkillArchivePane
    api={createSkillsApi("ch-1", "n-1")}
    canManage={canManage}
    onChanged={() => {}}
  />
);

test.afterEach(cleanup);

test("shows the list and date; [Restore] sends POST …/archive/weekly/restore then reloads", async () => {
  const log = mockFetch({
    [ARCHIVE]: archived,
    [`POST ${ROOT}/archive/weekly/restore`]: { name: "weekly" },
  });
  await render(pane(true));
  assert.ok(text().includes("weekly"));
  assert.ok(text().includes("2026-09-20"));
  await click('[data-action="restore"]');
  assert.deepEqual(log.calls, [ARCHIVE, `POST ${ROOT}/archive/weekly/restore`, ARCHIVE]);
});

test("[Permanently delete] enables the confirm button only on an exact name match, then sends DELETE …/archive/weekly", async () => {
  const log = mockFetch({
    [ARCHIVE]: archived,
    [`DELETE ${ROOT}/archive/weekly`]: { name: "weekly", ledgerId: "l1" },
  });
  await render(pane(true));
  await click('[data-action="purge"]');
  assert.ok(text().includes("Hermes CLI"));
  assert.equal(($('[data-action="confirm-purge"]') as HTMLButtonElement).disabled, true);
  await type('[name="purge-name"]', "week");
  assert.equal(($('[data-action="confirm-purge"]') as HTMLButtonElement).disabled, true);
  await type('[name="purge-name"]', "weekly");
  await click('[data-action="confirm-purge"]');
  assert.ok(log.calls.includes(`DELETE ${ROOT}/archive/weekly`));
});

test("members have no restore/permanently-delete buttons", async () => {
  mockFetch({ [ARCHIVE]: archived });
  await render(pane(false));
  assert.ok(text().includes("weekly"));
  assert.ok(!container.querySelector('[data-action="restore"]'));
  assert.ok(!container.querySelector('[data-action="purge"]'));
});

test("shows a notice when empty", async () => {
  mockFetch({ [ARCHIVE]: { archived: [] } });
  await render(pane(true));
  assert.ok(text().includes("보관한 스킬이 없습니다"));
});
