import assert from "node:assert/strict";
import test from "node:test";

import { cleanup, click, container, mockFetch, render, text } from "../skills/skills-test-harness";
import NpcConnectorsTab from "./NpcConnectorsTab";

const ROOT = "/api/channels/c/npcs/n/connectors";
const LIST = `GET ${ROOT}/`;

const view = (over: Record<string, unknown> = {}) => ({
  servers: [
    {
      name: "github",
      kind: "custom",
      transport: "http",
      endpointSummary: "gh.example/mcp",
      enabled: true,
      trust: "full",
      auth: "none",
      secrets: [],
      oauthTokenPresent: false,
      tools: { total: 30, enabled: 12 },
      lastCheck: { at: new Date(Date.now() - 120_000).toISOString(), ok: true },
      revision: "r1",
    },
    {
      name: "canva",
      kind: "catalog",
      transport: "http",
      endpointSummary: "mcp.canva.com/mcp",
      enabled: true,
      trust: "full",
      auth: "oauth",
      secrets: [],
      oauthTokenPresent: false,
      tools: null,
      lastCheck: null,
      revision: "r2",
    },
  ],
  canManage: true,
  capabilityReady: true,
  sharedChannelCount: 2,
  ...over,
});

const tab = (onOpenManager: (s?: string) => void = () => {}) => (
  <NpcConnectorsTab channelId="c" npcId="n" onOpenManager={onOpenManager} />
);

test.afterEach(cleanup);

test("owner sees cards, tool counts, the shared warning, and the manage button", async () => {
  mockFetch({ [LIST]: view() });
  await render(tab());
  assert.match(text(), /github/);
  assert.match(text(), /12\/30/);
  assert.ok(container.querySelector("[data-testid=connector-state-canva][data-state=needsAuth]"));
  assert.ok(container.querySelector("[data-testid=connector-state-github][data-state=connected]"));
  assert.ok(container.querySelector("[data-testid=connectors-shared-warning]"));
  assert.ok(container.querySelector("[data-testid=connectors-open-manager]"));
});

test("members get a read-only list without action buttons", async () => {
  mockFetch({ [LIST]: view({ canManage: false }) });
  await render(tab());
  assert.match(text(), /canva/);
  assert.equal(container.querySelector("[data-testid=connectors-open-manager]"), null);
  assert.equal(container.querySelector("[data-testid=connector-action-canva]"), null);
});

test("428 shows the upgrade notice instead of an error", async () => {
  mockFetch({
    [LIST]: {
      status: 428,
      json: { code: "plugin_upgrade_required", message: "x", minVersion: "0.17.0" },
    },
  });
  await render(tab());
  assert.ok(container.querySelector("[data-testid=connectors-upgrade-required]"));
  assert.match(text(), /0\.17\.0/);
});

test("409 shows the gateway notice", async () => {
  mockFetch({ [LIST]: { status: 409, json: { code: "gateway_not_connected", message: "x" } } });
  await render(tab());
  assert.equal(container.querySelector("[data-testid=npc-connectors-tab]"), null);
  assert.match(text(), /게이트웨이/);
});

test("the manage button opens the manager; a card action opens it on that server", async () => {
  const opened: (string | undefined)[] = [];
  mockFetch({ [LIST]: view() });
  await render(tab((s) => opened.push(s)));
  await click("[data-testid=connectors-open-manager]");
  await click("[data-testid=connector-action-canva]");
  assert.deepEqual(opened, [undefined, "canva"]);
  // A connected server has no action button.
  assert.equal(container.querySelector("[data-testid=connector-action-github]"), null);
});
