import assert from "node:assert/strict";
import test from "node:test";

import ApprovalPolicyModal from "./ApprovalPolicyModal";
import type { ApprovalPolicyView } from "./approval-policy-api";
import {
  $,
  cleanup,
  click,
  container,
  mockFetch,
  render,
  text,
  type,
} from "../skills/skills-test-harness";

const ROOT = "/api/channels/ch-1/npcs/n-1/approval-policy";
const GET = `GET ${ROOT}`;
const PUT = `PUT ${ROOT}`;
const ADD = `POST ${ROOT}/allowlist`;
const DEL = `DELETE ${ROOT}/allowlist`;

const policy = (over: Partial<ApprovalPolicyView> = {}): ApprovalPolicyView => ({
  cronMode: "deny",
  singleQueryMode: "deny",
  allowlist: ["recursive delete"],
  timeoutSeconds: 300,
  workerPropagation: true,
  canManage: true,
  capabilityReady: true,
  sharedChannelCount: 0,
  ...over,
});
const bare = ({
  canManage: _c,
  capabilityReady: _r,
  sharedChannelCount: _s,
  ...rest
}: ApprovalPolicyView) => rest;

let closed = 0;
const modal = () => (
  <ApprovalPolicyModal
    channelId="ch-1"
    npcId="n-1"
    npcName="Mia"
    onClose={() => {
      closed += 1;
    }}
  />
);
const btn = (sel: string) => $(sel) as HTMLButtonElement;

test.beforeEach(() => {
  closed = 0;
});
test.afterEach(cleanup);

test("loads the policy and shows both modes and the allowlist", async () => {
  mockFetch({ [GET]: policy({ cronMode: "approve" }) });
  await render(modal());
  assert.equal(btn('[data-mode="cron:approve"]').getAttribute("aria-pressed"), "true");
  assert.equal(btn('[data-mode="single:deny"]').getAttribute("aria-pressed"), "true");
  assert.ok($('[data-allow="recursive delete"]'));
  assert.ok(text().includes("Mia"));
});

test("switching to allow asks for confirmation first; cancelling sends nothing", async () => {
  const log = mockFetch({ [GET]: policy(), [PUT]: bare(policy({ singleQueryMode: "approve" })) });
  await render(modal());
  await click('[data-mode="single:approve"]');
  assert.ok(
    $('[data-dialog="approve-confirm"]').textContent?.includes(
      "승인 없이 모든 위험 명령이 실행됩니다",
    ),
  );
  assert.ok(!log.calls.includes(PUT));
  await click('[data-action="approve-cancel"]');
  assert.equal(container.querySelector('[data-dialog="approve-confirm"]'), null);
  assert.ok(!log.calls.includes(PUT));
  await click('[data-mode="single:approve"]');
  await click('[data-action="approve-confirm"]');
  assert.deepEqual(log.bodies[PUT], { singleQueryMode: "approve" });
  assert.equal(btn('[data-mode="single:approve"]').getAttribute("aria-pressed"), "true");
  assert.ok($('[data-action="add-allow"]'), "permission fields survive the PUT response");
});

test("switching back to block needs no confirmation", async () => {
  const log = mockFetch({ [GET]: policy({ cronMode: "approve" }), [PUT]: bare(policy()) });
  await render(modal());
  await click('[data-mode="cron:deny"]');
  assert.deepEqual(log.bodies[PUT], { cronMode: "deny" });
  assert.equal(btn('[data-mode="cron:deny"]').getAttribute("aria-pressed"), "true");
});

test("adds and removes allowlist entries", async () => {
  const log = mockFetch({
    [GET]: policy(),
    [ADD]: bare(policy({ allowlist: ["recursive delete", "git push"] })),
    [DEL]: bare(policy({ allowlist: ["git push"] })),
  });
  await render(modal());
  await type('[name="allow-entry"]', "  git push ");
  await click('[data-action="add-allow"]');
  assert.deepEqual(log.bodies[ADD], { entry: "git push" });
  assert.ok($('[data-allow="git push"]'));
  assert.equal(($('[name="allow-entry"]') as HTMLInputElement).value, "");
  await click('[data-remove-allow="recursive delete"]');
  assert.deepEqual(log.bodies[DEL], { entry: "recursive delete" });
  assert.equal(container.querySelector('[data-allow="recursive delete"]'), null);
});

test("a malformed entry is refused on the spot, and a server format error shows the same text", async () => {
  const log = mockFetch({
    [GET]: policy(),
    [ADD]: { status: 400, json: { code: "invalid_allowlist_entry", message: "bad" } },
  });
  await render(modal());
  await type('[name="allow-entry"]', "x".repeat(201));
  await click('[data-action="add-allow"]');
  assert.ok(!log.calls.includes(ADD));
  const refused = $("[data-error]").textContent;
  assert.ok(refused?.includes("200자"));
  await type('[name="allow-entry"]', "rm");
  await click('[data-action="add-allow"]');
  assert.ok(log.calls.includes(ADD));
  assert.equal($("[data-error]").textContent, refused);
});

test("a member sees the policy read-only", async () => {
  mockFetch({ [GET]: policy({ canManage: false }) });
  await render(modal());
  assert.equal(btn('[data-mode="cron:approve"]').disabled, true);
  assert.equal(btn('[data-mode="single:deny"]').disabled, true);
  assert.equal(container.querySelector('[name="allow-entry"]'), null);
  assert.equal(container.querySelector("[data-remove-allow]"), null);
  assert.ok(text().includes("게이트웨이 소유자만"));
});

test("warns when worker propagation is off", async () => {
  mockFetch({ [GET]: policy({ workerPropagation: false }) });
  await render(modal());
  assert.ok($("[data-worker-propagation-off]").textContent?.includes("워커 전파"));
});

test("an old plugin gets the upgrade notice", async () => {
  mockFetch({ [GET]: { status: 428, json: { code: "plugin_upgrade_required", message: "" } } });
  await render(modal());
  assert.ok($("[data-upgrade-required]").textContent?.includes("0.18.0"));
});

test("escape closes", async () => {
  mockFetch({ [GET]: policy() });
  await render(modal());
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  assert.equal(closed, 1);
});
