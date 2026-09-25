import assert from "node:assert/strict";
import test from "node:test";

import {
  $,
  cleanup,
  click,
  container,
  flush,
  mockFetch,
  render,
  text,
  type,
} from "../skills/skills-test-harness";
import type { McpServerView } from "@/lib/hermes/plugin-client-types";

import ConnectorManagerModal, { paneAfterAdd } from "./ConnectorManagerModal";

const rootOf = (npcId: string) => `/api/channels/c/npcs/${npcId}/connectors`;
const ROOT = rootOf("n");
const LIST = `GET ${ROOT}/`;

const fresh = () => ({ at: new Date(Date.now() - 60_000).toISOString(), ok: true });

const server = (name: string, over: Partial<McpServerView> = {}): McpServerView => ({
  name,
  kind: "custom",
  transport: "http",
  endpointSummary: `${name}.example/mcp`,
  enabled: true,
  trust: "full",
  auth: "none",
  secrets: [],
  oauthTokenPresent: false,
  tools: { total: 2, enabled: 2 },
  lastCheck: fresh(),
  revision: "r1",
  ...over,
});

const listBody = (servers = [server("github")], canManage = true) => ({
  servers,
  canManage,
  capabilityReady: true,
  sharedChannelCount: 0,
});

const detail = (name: string, over: Record<string, unknown> = {}) => ({
  ...server(name),
  url: `https://${name}.example/mcp`,
  command: null,
  args: [],
  cwd: null,
  envKeys: [],
  headerKeys: [],
  toolFilter: {},
  ...over,
});

const tools = [
  { name: "read_a", description: "reads", readOnlyHint: true, destructiveHint: false, on: true },
  { name: "drop_b", description: "drops", readOnlyHint: false, destructiveHint: true, on: true },
];
const toolsBody = { tools, checkedAt: new Date().toISOString(), revision: "r1" };

const modal = (over: Record<string, unknown> = {}) => (
  <ConnectorManagerModal
    channelId="c"
    npcId="n"
    npcName="Ada"
    onClose={() => {}}
    copyTargets={[]}
    pollIntervalMs={0}
    {...over}
  />
);

test.afterEach(cleanup);

test("selecting a server shows its endpoint, trust switch, and test button", async () => {
  mockFetch({ [LIST]: listBody(), [`GET ${ROOT}/servers/github`]: detail("github") });
  await render(modal());
  assert.match(text(), /https:\/\/github\.example\/mcp/);
  assert.ok($("[data-action=trust]"));
  assert.ok($("[data-action=test]"));
});

test("stdio servers show the whole command line", async () => {
  mockFetch({
    [LIST]: listBody([server("fs", { transport: "stdio" })]),
    [`GET ${ROOT}/servers/fs`]: detail("fs", {
      transport: "stdio",
      url: null,
      command: "npx",
      args: ["-y", "@mcp/fs", "/data"],
    }),
  });
  await render(modal());
  assert.equal($("[data-testid=connector-command]").textContent, "npx -y @mcp/fs /data");
});

test("a connection test polls the job and then lists tools with a read-only badge", async () => {
  const routes: Record<string, Record<string, unknown>> = {
    [LIST]: listBody(),
    [`GET ${ROOT}/servers/github`]: detail("github"),
    [`GET ${ROOT}/servers/github/tools`]: {
      status: 404,
      json: { code: "tools_unknown", message: "" },
    },
    [`POST ${ROOT}/servers/github/test`]: { jobId: "j1" },
    [`GET ${ROOT}/jobs/j1`]: { jobId: "j1", state: "succeeded", ok: true, tools },
  };
  const log = mockFetch(routes);
  await render(modal());
  await click("[data-section=tools]");
  assert.ok($("[data-testid=connector-tools-unknown]"));
  routes[`GET ${ROOT}/servers/github/tools`] = toolsBody;
  await click("[data-action=test]");
  await flush();
  assert.ok(log.calls.includes(`GET ${ROOT}/jobs/j1`));
  assert.ok($("[data-tool=read_a]"));
  assert.match($("[data-tool=read_a]").textContent ?? "", /읽기 전용/);
  assert.match($("[data-tool=drop_b]").textContent ?? "", /파괴적/);
});

test("[Read-only only] saves the read-only tools against the revision", async () => {
  const log = mockFetch({
    [LIST]: listBody(),
    [`GET ${ROOT}/servers/github`]: detail("github"),
    [`GET ${ROOT}/servers/github/tools`]: toolsBody,
    [`PUT ${ROOT}/servers/github/tools`]: server("github"),
  });
  await render(modal());
  await click("[data-section=tools]");
  await click("[data-quick=readOnly]");
  assert.deepEqual(log.bodies[`PUT ${ROOT}/servers/github/tools`], {
    include: ["read_a"],
    baseRevision: "r1",
  });
  assert.ok($("[data-testid=connectors-reload-banner]"));
});

test("a revision conflict shows the message and a reload button, keeping the selection", async () => {
  mockFetch({
    [LIST]: listBody([server("github"), server("slack")]),
    [`GET ${ROOT}/servers/github`]: detail("github"),
    [`GET ${ROOT}/servers/github/tools`]: toolsBody,
    [`PUT ${ROOT}/servers/github/tools`]: {
      status: 409,
      json: { code: "revision_conflict", message: "" },
    },
  });
  await render(modal());
  await click("[data-section=tools]");
  await click("[data-quick=readOnly]");
  assert.match(text(), /다른 곳에서 먼저 바뀌었습니다/);
  assert.ok($("[data-action=reload-tools]"));
  assert.equal($("[data-server=github]").getAttribute("aria-current"), "true");
  assert.equal($("[data-tool=drop_b] [role=switch]").getAttribute("aria-checked"), "true");
  assert.equal(container.querySelector("[data-testid=connectors-reload-banner]"), null);
});

test("secret inputs never echo the stored value and opt out of password managers", async () => {
  mockFetch({
    [LIST]: listBody([
      server("github", { auth: "env", secrets: [{ key: "GH_TOKEN", hasValue: true }] }),
    ]),
    [`GET ${ROOT}/servers/github`]: detail("github", {
      auth: "env",
      secrets: [{ key: "GH_TOKEN", hasValue: true }],
    }),
  });
  await render(modal());
  await click("[data-section=auth]");
  const input = $("[data-secret=GH_TOKEN]") as HTMLInputElement;
  assert.equal(input.type, "password");
  assert.equal(input.value, "");
  assert.match(input.placeholder, /저장됨/);
  assert.equal(input.getAttribute("autocomplete"), "off");
  assert.ok(input.hasAttribute("data-1p-ignore"));
  assert.equal(input.getAttribute("data-lpignore"), "true");
});

test("saving a secret raises the reload banner; applying explains a next-session refresh", async () => {
  const log = mockFetch({
    [LIST]: listBody([
      server("github", { auth: "env", secrets: [{ key: "GH_TOKEN", hasValue: false }] }),
    ]),
    [`GET ${ROOT}/servers/github`]: detail("github", {
      auth: "env",
      secrets: [{ key: "GH_TOKEN", hasValue: false }],
    }),
    [`PUT ${ROOT}/servers/github/secrets/GH_TOKEN`]: { key: "GH_TOKEN", hasValue: true },
    [`POST ${ROOT}/reload`]: { reloaded: true, servers: ["github"], agentsRefreshed: false },
  });
  await render(modal());
  await click("[data-section=auth]");
  await type("[data-secret=GH_TOKEN]", "ghp_abc");
  await click("[data-action=save-secret]");
  assert.deepEqual(log.bodies[`PUT ${ROOT}/servers/github/secrets/GH_TOKEN`], { value: "ghp_abc" });
  assert.equal(($("[data-secret=GH_TOKEN]") as HTMLInputElement).value, "");
  await click("[data-testid=connectors-reload-banner] button");
  assert.ok(log.calls.includes(`POST ${ROOT}/reload`));
  assert.match(text(), /새 대화부터 반영/);
});

test("switching NPCs while open drops the previous NPC's late response", async () => {
  mockFetch({
    [LIST]: { ...listBody([server("old-srv")]), delayMs: 80 },
    [`GET ${ROOT}/servers/old-srv`]: detail("old-srv"),
    [`GET ${rootOf("m")}/`]: listBody([server("new-srv")]),
    [`GET ${rootOf("m")}/servers/new-srv`]: detail("new-srv"),
  });
  await render(modal());
  await render(modal({ npcId: "m" }));
  await new Promise((r) => setTimeout(r, 150));
  await flush();
  assert.ok($("[data-server=new-srv]"));
  assert.equal(container.querySelector("[data-server=old-srv]"), null);
});

test("delete asks for the server name before sending DELETE", async () => {
  const log = mockFetch({
    [LIST]: listBody(),
    [`GET ${ROOT}/servers/github`]: detail("github"),
    [`DELETE ${ROOT}/servers/github`]: { ok: true },
  });
  await render(modal());
  await click("[data-action=delete]");
  await type("[data-testid=delete-confirm-input]", "gith");
  assert.equal(($("[data-action=confirm-delete]") as HTMLButtonElement).disabled, true);
  await type("[data-testid=delete-confirm-input]", "github");
  assert.equal(($("[data-action=confirm-delete]") as HTMLButtonElement).disabled, false);
  await click("[data-action=confirm-delete]");
  assert.ok(log.calls.includes(`DELETE ${ROOT}/servers/github`));
});

test("opening re-checks stale enabled servers one at a time", async () => {
  const log = mockFetch({
    [LIST]: listBody([server("github"), server("canva", { auth: "oauth", lastCheck: null })]),
    [`GET ${ROOT}/servers/github`]: detail("github"),
    [`POST ${ROOT}/servers/canva/test`]: { jobId: "j2" },
    [`GET ${ROOT}/jobs/j2`]: { jobId: "j2", state: "succeeded", ok: true, tools: [] },
  });
  await render(modal());
  await flush();
  assert.equal(log.calls.filter((c) => c === `POST ${ROOT}/servers/canva/test`).length, 1);
  assert.equal(log.calls.filter((c) => c === `POST ${ROOT}/servers/github/test`).length, 0);
});

test("members get no stale re-check and no detail fetch", async () => {
  const log = mockFetch({
    [LIST]: listBody([server("canva", { lastCheck: null })], false),
  });
  await render(modal());
  assert.ok($("[data-server=canva]"));
  assert.equal(log.calls.filter((c) => c.startsWith("POST")).length, 0);
  assert.equal(log.calls.includes(`GET ${ROOT}/servers/canva`), false);
  assert.equal(container.querySelector("[data-action=add]"), null);
});

test("initialServer preselects that server", async () => {
  mockFetch({
    [LIST]: listBody([server("github"), server("slack")]),
    [`GET ${ROOT}/servers/slack`]: detail("slack"),
  });
  await render(modal({ initialServer: "slack" }));
  assert.equal($("[data-server=slack]").getAttribute("aria-current"), "true");
});

test("after adding, an OAuth server goes straight to the OAuth step", () => {
  const view = listBody([server("canva", { auth: "oauth" }), server("github")]);
  assert.equal(paneAfterAdd(view, "canva"), "oauth");
  assert.equal(paneAfterAdd(view, "github"), "detail");
  assert.equal(paneAfterAdd(null, "github"), "detail");
});

test("the trust switch says write tools are blocked, not approved", async () => {
  mockFetch({ [LIST]: listBody(), [`GET ${ROOT}/servers/github`]: detail("github") });
  await render(modal());
  assert.match(text(), /모든 도구 허용/);
  assert.equal($("[data-action=trust]").getAttribute("aria-label"), "쓰기 도구 막기");
  // A fully trusted server describes its own state — not the blocked one.
  assert.match(text(), /묻지 않고 실행됩니다/);
  assert.doesNotMatch(text(), /DeskRPG 대화에서 실행되지 않습니다/);
  assert.doesNotMatch(text(), /호출마다 승인/);
});

test("an untrusted server explains that write tools do not run in DeskRPG chat", async () => {
  const untrusted = server("github", { trust: "untrusted" });
  mockFetch({
    [LIST]: listBody([untrusted]),
    [`GET ${ROOT}/servers/github`]: detail("github", { trust: "untrusted" }),
  });
  await render(modal());
  assert.match(text(), /쓰기 도구 막기/);
  assert.match(text(), /DeskRPG 대화에서 실행되지 않습니다/);
  assert.doesNotMatch(text(), /묻지 않고 실행됩니다/);
});

test("after adding a non-OAuth server, the manager runs its connection test and re-reads the list", async () => {
  const routes: Record<string, Record<string, unknown>> = {
    [LIST]: listBody(),
    [`GET ${ROOT}/servers/github`]: detail("github"),
    [`GET ${ROOT}/catalog`]: {
      entries: [
        { name: "docs", description: "Docs", transport: "http", installed: false, requiredEnv: [] },
      ],
    },
    [`POST ${ROOT}/catalog/docs/install`]: server("docs", { lastCheck: null }),
    [`GET ${ROOT}/servers/docs`]: detail("docs"),
    [`POST ${ROOT}/servers/docs/test`]: { jobId: "j3" },
    [`GET ${ROOT}/jobs/j3`]: { jobId: "j3", state: "succeeded", ok: true, tools: [] },
  };
  const log = mockFetch(routes);
  await render(modal());
  routes[LIST] = listBody([server("github"), server("docs", { lastCheck: null })]);
  await click("[data-action=add]");
  await click('[data-entry="docs"]');
  await click('[data-action="catalog-install"]');
  await flush();
  const install = log.calls.indexOf(`POST ${ROOT}/catalog/docs/install`);
  const started = log.calls.indexOf(`POST ${ROOT}/servers/docs/test`);
  const polled = log.calls.indexOf(`GET ${ROOT}/jobs/j3`);
  assert.ok(install >= 0 && started > install && polled > started, log.calls.join("\n"));
  assert.equal(log.calls.filter((c) => c === `POST ${ROOT}/servers/docs/test`).length, 1);
  assert.ok(log.calls.slice(polled).includes(LIST));
  assert.equal($("[data-server=docs]").getAttribute("aria-current"), "true");
});

test("finishing OAuth runs a connection test right away and re-reads the list", async () => {
  const originalOpen = window.open;
  window.open = (() => ({})) as unknown as typeof window.open;
  try {
    const canva = server("canva", { auth: "oauth" });
    const routes: Record<string, Record<string, unknown>> = {
      [LIST]: listBody([canva]),
      [`GET ${ROOT}/servers/canva`]: detail("canva", { auth: "oauth" }),
      [`POST ${ROOT}/servers/canva/oauth`]: { sessionId: "s1", authUrl: "https://canva.example/a" },
      [`POST ${ROOT}/oauth/s1/callback`]: { ok: true },
      [`GET ${ROOT}/oauth/s1`]: { status: "approved" },
      [`POST ${ROOT}/servers/canva/test`]: { jobId: "j4" },
      [`GET ${ROOT}/jobs/j4`]: { jobId: "j4", state: "succeeded", ok: true, tools: [] },
    };
    const log = mockFetch(routes);
    await render(modal());
    await click("[data-section=auth]");
    await click("[data-action=oauth]");
    await click('[data-action="oauth-start"]');
    await type('[name="oauth-paste"]', "http://127.0.0.1:8412/callback?code=a&state=b");
    routes[LIST] = listBody([{ ...canva, oauthTokenPresent: true }]);
    await click('[data-action="oauth-submit"]');
    await new Promise((r) => setTimeout(r, 20));
    await flush();
    const approved = log.calls.indexOf(`GET ${ROOT}/oauth/s1`);
    const started = log.calls.indexOf(`POST ${ROOT}/servers/canva/test`);
    const polled = log.calls.indexOf(`GET ${ROOT}/jobs/j4`);
    assert.ok(approved >= 0 && started > approved && polled > started, log.calls.join("\n"));
    assert.ok(log.calls.slice(polled).includes(LIST));
  } finally {
    window.open = originalOpen;
  }
});
