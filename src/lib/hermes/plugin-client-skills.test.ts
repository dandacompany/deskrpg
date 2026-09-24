import test, { after, before } from "node:test";
import assert from "node:assert/strict";

import { createProfilePluginClient } from "./plugin-client";
import { startFakePluginServer, type FakePluginServer } from "./fake-plugin-server";

let server: FakePluginServer;
before(async () => {
  server = await startFakePluginServer({
    ownerToken: "gateway-owner-key-1234567890",
    profileTokens: { sophie: "profile-key-1234567890" },
  });
});
after(async () => server.close());

const client = () =>
  createProfilePluginClient({
    baseUrl: server.baseUrl,
    profileName: "sophie",
    profileToken: "profile-key-1234567890",
  });

test("list, detail and file read paths and shapes", async () => {
  server.skills("sophie").seed("weekly", { files: { "references/a.md": "a" } });
  const list = await client().skills.list();
  assert.ok(list.ok);
  assert.equal(list.data.skills[0].source, "local");
  const detail = await client().skills.detail("weekly");
  assert.ok(detail.ok);
  assert.deepEqual(detail.data.files.map((f) => f.path).sort(), ["SKILL.md", "references/a.md"]);
  const file = await client().skills.readFile("weekly", "SKILL.md");
  assert.ok(file.ok);
  assert.match(
    server.lastRequest()!.path,
    /^\/p\/sophie\/deskrpg\/skills\/weekly\/file\?path=SKILL\.md$/,
  );
});

test("writes carry X-DeskRPG-Actor, and a conflict comes back as skill_changed", async () => {
  server.skills("sophie").seed("weekly");
  const res = await client().skills.writeFile(
    "weekly",
    { path: "SKILL.md", content: "x", baseHash: "0".repeat(64) },
    "u-1",
  );
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.status, 409);
    assert.equal(res.failure.code, "skill_changed");
  }
  assert.equal(server.skills("sophie").lastActor, "u-1");
  assert.equal(server.lastRequest()!.headers["x-deskrpg-actor"], "u-1");
});

test("read requests carry no X-DeskRPG-Actor", async () => {
  await client().skills.list();
  assert.equal(server.lastRequest()!.headers["x-deskrpg-actor"], undefined);
});

test("the name is encoded as a single segment", async () => {
  await client().skills.detail("a/b");
  assert.equal(server.lastRequest()!.path, "/p/sophie/deskrpg/skills/a%2Fb");
});

test("Hub search does not append source= when source is absent", async () => {
  await client().skills.hubSearch("pdf");
  assert.equal(server.lastRequest()!.path, "/p/sophie/deskrpg/skills/hub/search?q=pdf");
  await client().skills.hubSearch("pdf", "official");
  assert.equal(
    server.lastRequest()!.path,
    "/p/sophie/deskrpg/skills/hub/search?q=pdf&source=official",
  );
});

test("Hub install, job lookup, curator and relationship graph paths", async () => {
  const install = await client().skills.hubInstall({ identifier: "a/b" }, "u-1");
  assert.ok(install.ok);
  const job = await client().skills.job("hub", install.data.jobId);
  assert.ok(job.ok);
  assert.equal(job.data.kind, "hub_install");
  const run = await client().skills.runCurator("u-1");
  assert.ok(run.ok);
  assert.ok((await client().skills.job("curator", run.data.jobId)).ok);
  await client().skills.graph(false);
  assert.equal(server.lastRequest()!.path, "/p/sophie/deskrpg/learning/graph?includeMemory=0");
  await client().skills.deleteNode({ id: "memory:memory:0", baseHash: "h" }, "u-1");
  assert.equal(server.lastRequest()!.method, "DELETE");
});

test("archive→restore→permanent delete paths", async () => {
  server.skills("sophie").seed("old");
  assert.ok((await client().skills.archive("old", "u-1")).ok);
  const archived = await client().skills.listArchived();
  assert.ok(archived.ok);
  assert.ok(archived.data.archived.some((a) => a.name === "old"));
  assert.ok((await client().skills.restore("old", "u-1")).ok);
  assert.ok((await client().skills.archive("old", "u-1")).ok);
  const purged = await client().skills.purge("old", "u-1");
  assert.ok(purged.ok);
  assert.equal(server.lastRequest()!.path, "/p/sophie/deskrpg/skills/archive/old");
  assert.equal(server.lastRequest()!.method, "DELETE");
});
