import test, { after, before } from "node:test";
import assert from "node:assert/strict";

import { createOwnerPluginClient } from "./plugin-client";
import { startFakePluginServer, type FakePluginServer } from "./fake-plugin-server";

const OWNER = "owner-key-1234567890";
let server: FakePluginServer;

before(async () => {
  server = await startFakePluginServer({
    ownerToken: OWNER,
    profileTokens: { sophie: "p-1234567890" },
  });
});
after(async () => server.close());

const client = () => createOwnerPluginClient({ baseUrl: server.baseUrl, ownerToken: OWNER });

test("list sends profiles·board·taskId as query params and returns a page", async () => {
  server.seedArtifact({
    id: "a1",
    title: "보고서",
    profile: "sophie",
    board: "b1",
    task_id: "t1",
    body: "# hi",
  });
  const res = await client().artifacts.list({
    profiles: ["sophie"],
    board: "b1",
    taskId: "t1",
    limit: 10,
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(
    res.data.artifacts.map((a) => a.id),
    ["a1"],
  );
  assert.match(server.lastRequest()!.path, /profiles=sophie&board=b1.*task_id=t1/);
});

test("content returns the raw Response and forwards Range", async () => {
  server.seedArtifact({ id: "a2", title: "t", profile: "sophie", body: "0123456789" });
  const res = await client().artifacts.content("a2", 1, { range: "bytes=2-5" });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.response.status, 206);
  assert.equal(await res.response.text(), "2345");
  assert.equal(res.response.headers.get("content-security-policy"), "sandbox");
});

test("content failure folds into PluginFailure", async () => {
  const res = await client().artifacts.content("nope", 1, {});
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.status, 404);
  assert.equal(res.failure.code, "artifact_not_found");
});

test("addVersion·remove attach X-DeskRPG-User", async () => {
  server.seedArtifact({ id: "a3", title: "t", profile: "sophie", body: "v1" });
  const added = await client().artifacts.addVersion(
    "a3",
    { content: "v2", filename: "t.md" },
    "user-1",
  );
  assert.equal(added.ok, true);
  assert.equal(server.lastRequest()!.headers["x-deskrpg-user"], "user-1");
  const removed = await client().artifacts.remove("a3", "user-1");
  assert.equal(removed.ok, true);
});

test("events.poll sends include as a query param", async () => {
  await client().events.poll({ board: "b1", include: "artifacts" });
  assert.match(server.lastRequest()!.path, /include=artifacts/);
});

test("attachment bytes are streamed via attachmentContent", async () => {
  const board = server.seedAttachment({
    board: "b1",
    taskId: "t1",
    filename: "a.txt",
    body: "hello",
  });
  const res = await client().kanban.attachmentContent("b1", board.id, {});
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(await res.response.text(), "hello");
});
