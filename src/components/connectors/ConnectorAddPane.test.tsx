import assert from "node:assert/strict";
import test from "node:test";

import type { McpServerView } from "@/lib/hermes/plugin-client-types";

import ConnectorAddPane from "./ConnectorAddPane";
import { createConnectorsApi } from "./connectors-api";
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

const ROOT = "/api/channels/ch-1/npcs/n-1/connectors";
const CATALOG = `GET ${ROOT}/catalog`;

const view = (name: string, over: Partial<McpServerView> = {}): McpServerView => ({
  name,
  kind: "custom",
  transport: "http",
  endpointSummary: "",
  enabled: true,
  trust: "full",
  auth: "none",
  secrets: [],
  oauthTokenPresent: false,
  tools: null,
  lastCheck: null,
  revision: "r1",
  ...over,
});

const catalog = {
  entries: [
    {
      name: "linear",
      description: "Linear issues",
      transport: "http",
      installed: false,
      requiredEnv: [
        { name: "LINEAR_API_KEY", prompt: "Linear API key", required: true, secret: true },
      ],
    },
    { name: "github", description: "GitHub", transport: "stdio", installed: true, requiredEnv: [] },
  ],
};

let added: string[] = [];
let cancelled = 0;
const pane = () => (
  <ConnectorAddPane
    api={createConnectorsApi("ch-1", "n-1")}
    onAdded={(name) => {
      added.push(name);
    }}
    onCancel={() => {
      cancelled += 1;
    }}
  />
);

test.beforeEach(() => {
  added = [];
  cancelled = 0;
});
test.afterEach(cleanup);

test("opens on the catalog tab; an installed entry is disabled and marked installed", async () => {
  const log = mockFetch({ [CATALOG]: catalog });
  await render(pane());
  assert.ok(log.calls.includes(CATALOG));
  assert.equal(($('[data-entry="github"]') as HTMLButtonElement).disabled, true);
  assert.ok($('[data-entry="github"]').textContent?.includes("설치됨"));
  assert.equal(($('[data-entry="linear"]') as HTMLButtonElement).disabled, false);
});

test("installing a catalog entry sends the required env, clears it, runs a test, and reports the name", async () => {
  const log = mockFetch({
    [CATALOG]: catalog,
    [`POST ${ROOT}/catalog/linear/install`]: view("linear"),
    [`POST ${ROOT}/servers/linear/test`]: { jobId: "j1" },
  });
  await render(pane());
  await click('[data-entry="linear"]');
  const input = $('[name="env-LINEAR_API_KEY"]') as HTMLInputElement;
  assert.equal(input.type, "password");
  assert.equal(input.getAttribute("data-1p-ignore"), "true");
  assert.equal(input.getAttribute("data-lpignore"), "true");
  assert.equal(($('[data-action="catalog-install"]') as HTMLButtonElement).disabled, true);
  await type('[name="env-LINEAR_API_KEY"]', "lin");
  await click('[data-action="catalog-install"]');
  assert.deepEqual(log.bodies[`POST ${ROOT}/catalog/linear/install`], {
    env: { LINEAR_API_KEY: "lin" },
    enable: true,
  });
  assert.ok(log.calls.includes(`POST ${ROOT}/servers/linear/test`));
  assert.deepEqual(added, ["linear"]);
  assert.ok(!container.querySelector('[name="env-LINEAR_API_KEY"]') || input.value === "");
});

test("pasting mcpServers JSON on the custom tab fills name, command, and arguments", async () => {
  mockFetch({ [CATALOG]: catalog });
  await render(pane());
  await click('[data-tab="custom"]');
  await type(
    '[name="json-import"]',
    JSON.stringify({ mcpServers: { fs: { command: "npx", args: ["-y", "@x/fs"] } } }),
  );
  assert.equal(($('[name="name"]') as HTMLInputElement).value, "fs");
  assert.equal(($('[name="command"]') as HTMLInputElement).value, "npx");
  assert.equal(($('[name="args"]') as HTMLTextAreaElement).value, "-y\n@x/fs");
});

test("saving a stdio server shows the full command and waits for the typed name", async () => {
  const log = mockFetch({
    [CATALOG]: catalog,
    [`POST ${ROOT}/servers`]: view("fs", { transport: "stdio" }),
    [`POST ${ROOT}/servers/fs/test`]: { jobId: "j1" },
  });
  await render(pane());
  await click('[data-tab="custom"]');
  await type(
    '[name="json-import"]',
    JSON.stringify({ mcpServers: { fs: { command: "npx", args: ["-y", "@x/fs"] } } }),
  );
  await click('[data-action="save"]');
  assert.ok($('[data-dialog="stdio-confirm"]').textContent?.includes("npx -y @x/fs"));
  assert.ok(!log.calls.includes(`POST ${ROOT}/servers`));
  const submit = () => $('[data-action="confirm-save"]') as HTMLButtonElement;
  assert.equal(submit().disabled, true);
  await type('[name="confirm-name"]', "f");
  assert.equal(submit().disabled, true);
  await type('[name="confirm-name"]', "fs");
  assert.equal(submit().disabled, false);
  await click('[data-action="confirm-save"]');
  const body = log.bodies[`POST ${ROOT}/servers`] as Record<string, unknown>;
  assert.equal(body.confirmName, "fs");
  assert.equal(body.command, "npx");
  assert.deepEqual(body.args, ["-y", "@x/fs"]);
  assert.deepEqual(added, ["fs"]);
});

test("a security rejection shows the error and does not report an added server", async () => {
  mockFetch({
    [CATALOG]: catalog,
    [`POST ${ROOT}/servers`]: {
      status: 422,
      json: { code: "mcp_security_rejected", message: "bad", reasons: ["pipes to sh"] },
    },
  });
  await render(pane());
  await click('[data-tab="custom"]');
  await type('[name="name"]', "evil");
  await click('[data-transport="stdio"]');
  await type('[name="command"]', "sh");
  await click('[data-action="save"]');
  await type('[name="confirm-name"]', "evil");
  await click('[data-action="confirm-save"]');
  assert.ok(container.querySelector("[data-error]"));
  assert.deepEqual(added, []);
});

test("an http Bearer server stores the token under the key the server reports", async () => {
  const log = mockFetch({
    [CATALOG]: catalog,
    [`POST ${ROOT}/servers`]: view("notion", {
      auth: "bearer",
      secrets: [{ key: "MCP_NOTION_API_KEY", hasValue: false }],
    }),
    [`PUT ${ROOT}/servers/notion/secrets/MCP_NOTION_API_KEY`]: {
      key: "MCP_NOTION_API_KEY",
      hasValue: true,
    },
    [`POST ${ROOT}/servers/notion/test`]: { jobId: "j1" },
  });
  await render(pane());
  await click('[data-tab="custom"]');
  await type('[name="name"]', "notion");
  await type('[name="url"]', "https://mcp.notion.com/mcp");
  await click('[data-auth="bearer"]');
  const token = $('[name="token"]') as HTMLInputElement;
  assert.equal(token.type, "password");
  await type('[name="token"]', "ntn_fake");
  await click('[data-action="save"]');
  const body = log.bodies[`POST ${ROOT}/servers`] as Record<string, unknown>;
  assert.equal(body.auth, "bearer");
  assert.equal(JSON.stringify(body).includes("ntn_fake"), false);
  assert.deepEqual(log.bodies[`PUT ${ROOT}/servers/notion/secrets/MCP_NOTION_API_KEY`], {
    value: "ntn_fake",
  });
  assert.deepEqual(added, ["notion"]);
});

test("an OAuth server is reported without a connection test so the manager can open sign-in", async () => {
  const log = mockFetch({
    [CATALOG]: catalog,
    [`POST ${ROOT}/servers`]: view("canva", { auth: "oauth" }),
  });
  await render(pane());
  await click('[data-tab="custom"]');
  await type('[name="name"]', "canva");
  await type('[name="url"]', "https://mcp.canva.com/mcp");
  await click('[data-auth="oauth"]');
  await click('[data-action="save"]');
  assert.equal((log.bodies[`POST ${ROOT}/servers`] as Record<string, unknown>).auth, "oauth");
  assert.ok(!log.calls.some((c) => c.endsWith("/test")));
  assert.deepEqual(added, ["canva"]);
});

test("cancel reports back", async () => {
  mockFetch({ [CATALOG]: catalog });
  await render(pane());
  await click('[data-action="add-cancel"]');
  assert.equal(cancelled, 1);
  assert.ok(text().length > 0);
});

test("stdio env values are sent only as secrets for keys the server reports", async () => {
  const log = mockFetch({
    [CATALOG]: catalog,
    [`POST ${ROOT}/servers`]: view("fs", {
      transport: "stdio",
      auth: "env",
      secrets: [{ key: "FS_TOKEN", hasValue: false }],
    }),
    [`PUT ${ROOT}/servers/fs/secrets/FS_TOKEN`]: { key: "FS_TOKEN", hasValue: true },
    [`POST ${ROOT}/servers/fs/test`]: { jobId: "j1" },
  });
  await render(pane());
  await click('[data-tab="custom"]');
  await type('[name="name"]', "fs");
  await click('[data-transport="stdio"]');
  await type('[name="command"]', "npx");
  await click('[data-action="add-env"]');
  await type('[name="env-key-0"]', "FS_TOKEN");
  assert.equal(($('[name="env-value-0"]') as HTMLInputElement).type, "password");
  await type('[name="env-value-0"]', "ghp_abc");
  await click('[data-action="save"]');
  await type('[name="confirm-name"]', "fs");
  await click('[data-action="confirm-save"]');
  const body = log.bodies[`POST ${ROOT}/servers`] as Record<string, unknown>;
  assert.deepEqual(body.env, { FS_TOKEN: "" });
  assert.equal(JSON.stringify(body).includes("ghp_abc"), false);
  assert.deepEqual(log.bodies[`PUT ${ROOT}/servers/fs/secrets/FS_TOKEN`], { value: "ghp_abc" });
  assert.deepEqual(added, ["fs"]);
});
