import assert from "node:assert/strict";
import test from "node:test";

import type { McpServerDetail } from "@/lib/hermes/plugin-client-types";

import ConnectorCopyPane from "./ConnectorCopyPane";
import { createConnectorsApi } from "./connectors-api";
import { $, cleanup, click, mockFetch, render, text } from "../skills/skills-test-harness";

const ROOT = "/api/channels/ch-1/npcs/n-1/connectors";

const detail = (over: Partial<McpServerDetail> = {}): McpServerDetail => ({
  name: "github",
  kind: "custom",
  transport: "http",
  endpointSummary: "https://api.github.com/mcp",
  enabled: true,
  trust: "full",
  auth: "bearer",
  secrets: [{ key: "MCP_GITHUB_API_KEY", hasValue: true }],
  oauthTokenPresent: false,
  tools: null,
  lastCheck: null,
  revision: "r1",
  url: "https://api.github.com/mcp",
  command: null,
  args: [],
  cwd: null,
  envKeys: [],
  headerKeys: [],
  toolFilter: {},
  ...over,
});

const targets = [
  { npcId: "n-2", name: "Mia" },
  { npcId: "n-3", name: "Leo" },
  { npcId: "n-4", name: "Ada" },
];

let finished = 0;
const pane = (server = "github", list = targets) => (
  <ConnectorCopyPane
    api={createConnectorsApi("ch-1", "n-1")}
    server={server}
    targets={list}
    onDone={() => {
      finished += 1;
    }}
  />
);
const copyButton = () => $('[data-action="copy"]') as HTMLButtonElement;

test.beforeEach(() => {
  finished = 0;
});
test.afterEach(cleanup);

test("copies to the checked NPCs and lists each result", async () => {
  const log = mockFetch({
    [`GET ${ROOT}/servers/github`]: detail(),
    [`POST ${ROOT}/copy`]: {
      results: [
        { npcId: "n-2", name: "github", ok: true },
        { npcId: "n-3", name: "github", ok: false, code: "name_taken" },
        { npcId: "n-4", name: "github", ok: false, code: "npc_not_found" },
      ],
    },
  });
  await render(pane());
  assert.equal(copyButton().disabled, true);
  await click('[data-target="n-2"]');
  await click('[data-target="n-3"]');
  await click('[data-target="n-4"]');
  assert.equal(copyButton().disabled, false);
  await click('[data-action="copy"]');
  assert.deepEqual(log.bodies[`POST ${ROOT}/copy`], {
    targetNpcIds: ["n-2", "n-3", "n-4"],
    names: ["github"],
  });
  assert.equal($('[data-result="n-2"]').getAttribute("data-ok"), "true");
  assert.ok($('[data-result="n-2"]').textContent?.includes("Mia"));
  assert.ok($('[data-result="n-2"]').textContent?.includes("복사했습니다"));
  assert.equal($('[data-result="n-3"]').getAttribute("data-ok"), "false");
  assert.equal($('[data-result="n-4"]').getAttribute("data-ok"), "false");
  await click('[data-action="copy-done"]');
  assert.equal(finished, 1);
});

test("always states that secrets and sign-ins are not copied", async () => {
  mockFetch({ [`GET ${ROOT}/servers/github`]: detail() });
  await render(pane());
  assert.ok(text().includes("비밀값·로그인은 옮기지 않습니다. 받은 직원은 다시 인증해야 합니다."));
});

test("with no targets the copy button stays off", async () => {
  mockFetch({ [`GET ${ROOT}/servers/github`]: detail() });
  await render(pane("github", []));
  assert.ok(text().includes("복사할 수 있는 다른 직원이 없습니다"));
  assert.equal(copyButton().disabled, true);
});

test("a stdio server shows its command and needs a confirmation before copying", async () => {
  const log = mockFetch({
    [`GET ${ROOT}/servers/fs`]: detail({
      name: "fs",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@x/fs"],
      url: null,
    }),
    [`POST ${ROOT}/copy`]: { results: [{ npcId: "n-2", name: "fs", ok: true }] },
  });
  await render(pane("fs"));
  assert.ok($("[data-stdio-warning]").textContent?.includes("npx -y @x/fs"));
  await click('[data-target="n-2"]');
  assert.equal(copyButton().disabled, true);
  await click('[data-action="stdio-confirm"]');
  assert.equal(copyButton().disabled, false);
  await click('[data-action="copy"]');
  assert.ok(log.calls.includes(`POST ${ROOT}/copy`));
});

test("a failed copy call shows an error and no results", async () => {
  mockFetch({
    [`GET ${ROOT}/servers/github`]: detail(),
    [`POST ${ROOT}/copy`]: { status: 403, json: { code: "forbidden", message: "no" } },
  });
  await render(pane());
  await click('[data-target="n-2"]');
  await click('[data-action="copy"]');
  assert.ok($("[data-error]"));
  assert.ok(!document.querySelector("[data-result]"));
});
