import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import {
  authHeaders,
  seedChannel,
  seedGateway,
  seedHermesProfile,
  seedNpc,
  seedUser,
  setupThrowawaySqlite,
} from "@/test-setup/npc-seed";
import { startFakePluginServer, type FakePluginServer } from "@/lib/hermes/fake-plugin-server";

// T7. Artifact REST — list and detail. The server decides channel scope (all channel NPC profiles (including sleeping
// NPCs) OR the channel board). profiles sent by the browser are ignored.
//
// Kept outside the `[id]` segment — the node test runner mistakes `[id]` for a character class and misses
// the *.test.ts inside it.
setupThrowawaySqlite("artifact-routes-test");

let server: FakePluginServer;

type Routes = {
  list: typeof import("./[id]/artifacts/route");
  item: typeof import("./[id]/artifacts/[artifactId]/route");
  versions: typeof import("./[id]/artifacts/[artifactId]/versions/route");
  content: typeof import("./[id]/artifacts/[artifactId]/versions/[v]/content/route");
  sources: typeof import("./[id]/artifacts/[artifactId]/sources/route");
};

let routes: Routes;

before(async () => {
  server = await startFakePluginServer({
    ownerToken: "gateway-owner-key-1234567890",
    profileTokens: { sophie: "profile-key-1234567890" },
  });
  server.setInfo({ capabilities: ["kanban", "cron", "events", "artifacts"], version: "0.8.4" });
  routes = {
    list: await import("./[id]/artifacts/route"),
    item: await import("./[id]/artifacts/[artifactId]/route"),
    versions: await import("./[id]/artifacts/[artifactId]/versions/route"),
    content: await import("./[id]/artifacts/[artifactId]/versions/[v]/content/route"),
    sources: await import("./[id]/artifacts/[artifactId]/sources/route"),
  };
});

after(async () => {
  await server.close();
});

function req(userId: string, method: string, url: string, body?: unknown): NextRequest {
  const headers = new Headers(authHeaders(userId));
  if (body !== undefined) headers.set("content-type", "application/json");
  return new NextRequest(url, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const base = (channelId: string) => `http://localhost/api/channels/${channelId}/artifacts`;
const ctx = (id: string, artifactId = "", v = "") => ({
  params: Promise.resolve({ id, artifactId, v }),
});

/**
 * One channel + a gateway pointing at a fake plugin server (owner = channel owner) + an active NPC
 * for profile `sophie`.
 */
async function seedArtifactChannel() {
  const owner = await seedUser("artifact-owner");
  const gateway = await seedGateway(owner.id, server.baseUrl);
  const channel = await seedChannel(owner.id, "결과물 채널");
  const { bindGatewayToChannel } = await import("@/lib/gateway-resources");
  await bindGatewayToChannel({
    channelId: channel.id,
    gatewayId: gateway.id,
    boundByUserId: owner.id,
  });
  const profile = await seedHermesProfile(gateway.id, {
    profileName: "sophie",
    displayName: "소피",
  });
  await seedNpc({ channelId: channel.id, hermesProfileId: profile.id, positionX: 0, positionY: 0 });
  const { channelBoardSlug } = await import("@/lib/kanban-boards");
  return { owner, channel, boardSlug: channelBoardSlug(channel.id) };
}

test("the server attaches channel NPC profiles and the channel board to the list, ignoring the browser's profiles value", async () => {
  const { owner, channel, boardSlug } = await seedArtifactChannel();
  server.seedArtifact({ id: "mine", title: "내 것", profile: "sophie", body: "x" });
  server.seedArtifact({ id: "card", title: "카드", profile: "other", board: boardSlug, body: "x" });
  server.seedArtifact({
    id: "foreign",
    title: "남의 것",
    profile: "stranger",
    board: "deskrpg-other",
    body: "x",
  });
  const res = await routes.list.GET(
    req(owner.id, "GET", `${base(channel.id)}?profiles=stranger`),
    ctx(channel.id),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.artifacts.map((a: { id: string }) => a.id).sort(), ["card", "mine"]);
  assert.match(server.lastRequest()!.path, /profiles=sophie&board=/);
});

test("the profile filter accepts only channel NPCs", async () => {
  const { owner, channel } = await seedArtifactChannel();
  const bad = await routes.list.GET(
    req(owner.id, "GET", `${base(channel.id)}?profile=stranger`),
    ctx(channel.id),
  );
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, "invalid_field");
});

test("category is forwarded to the plugin as a comma-separated list", async () => {
  const { owner, channel } = await seedArtifactChannel();
  const res = await routes.list.GET(
    req(owner.id, "GET", `${base(channel.id)}?category=media`),
    ctx(channel.id),
  );
  assert.equal(res.status, 200);
  assert.match(server.lastRequest()!.path, /kind=image%2Cmedia|kind=image,media/);
});

test("an unknown category is 400 invalid_field", async () => {
  const { owner, channel } = await seedArtifactChannel();
  const res = await routes.list.GET(
    req(owner.id, "GET", `${base(channel.id)}?category=bogus`),
    ctx(channel.id),
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "invalid_field");
});

test("category and kind together are 400 invalid_field", async () => {
  const { owner, channel } = await seedArtifactChannel();
  const res = await routes.list.GET(
    req(owner.id, "GET", `${base(channel.id)}?category=media&kind=image`),
    ctx(channel.id),
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "invalid_field");
});

test("taskId is 428 when the plugin is below 0.8.4", async () => {
  // The plugin gate is probed and cached at gateway binding time (~1h) — to see a changed version,
  // call setInfo first and only then seed the channel + gateway fresh.
  server.setInfo({ version: "0.8.3" });
  const { owner, channel } = await seedArtifactChannel();
  const res = await routes.list.GET(
    req(owner.id, "GET", `${base(channel.id)}?taskId=t1`),
    ctx(channel.id),
  );
  assert.equal(res.status, 428);
  server.setInfo({ version: "0.8.4" });
});

test("detail outside the channel scope is 404 artifact_not_found", async () => {
  const { owner, channel } = await seedArtifactChannel();
  server.seedArtifact({ id: "foreign2", title: "남", profile: "stranger", body: "x" });
  const res = await routes.item.GET(
    req(owner.id, "GET", `${base(channel.id)}/foreign2`),
    ctx(channel.id, "foreign2"),
  );
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, "artifact_not_found");
});

test("gates: unauthenticated 401, non-member 403/404, no artifacts capability 428", async () => {
  const { channel } = await seedArtifactChannel();
  const stranger = await seedUser("stranger");
  assert.equal(
    (await routes.list.GET(new NextRequest(base(channel.id)), ctx(channel.id))).status,
    401,
  );
  assert.notEqual(
    (await routes.list.GET(req(stranger.id, "GET", base(channel.id)), ctx(channel.id))).status,
    200,
  );
  server.setInfo({ capabilities: ["kanban", "cron", "events"] });
  const { owner: o2, channel: c2 } = await seedArtifactChannel();
  const r = await routes.list.GET(req(o2.id, "GET", base(c2.id)), ctx(c2.id));
  assert.equal(r.status, 428);
  server.setInfo({ capabilities: ["kanban", "cron", "events", "artifacts"] });
});

test("content forwards Range and returns a 206 stream, out of scope gives 404", async () => {
  const { owner, channel } = await seedArtifactChannel();
  server.seedArtifact({
    id: "c1",
    title: "t",
    profile: "sophie",
    body: "0123456789",
    mime: "text/plain",
  });
  const r = new NextRequest(`${base(channel.id)}/c1/versions/1/content`, {
    headers: { ...authHeaders(owner.id), range: "bytes=2-5" },
  });
  const res = await routes.content.GET(r, ctx(channel.id, "c1", "1"));
  assert.equal(res.status, 206);
  assert.equal(await res.text(), "2345");
  assert.equal(res.headers.get("content-security-policy"), "sandbox");
  server.seedArtifact({ id: "c2", title: "t", profile: "stranger", body: "x" });
  const out = await routes.content.GET(
    req(owner.id, "GET", `${base(channel.id)}/c2/versions/1/content`),
    ctx(channel.id, "c2", "1"),
  );
  assert.equal(out.status, 404);
  const bad = await routes.content.GET(
    req(owner.id, "GET", `${base(channel.id)}/c1/versions/x/content`),
    ctx(channel.id, "c1", "x"),
  );
  assert.equal(bad.status, 400);
});

test("a new version attaches the user id as X-DeskRPG-User and returns 201", async () => {
  const { owner, channel } = await seedArtifactChannel();
  server.seedArtifact({ id: "e1", title: "t", profile: "sophie", body: "v1" });
  const res = await routes.versions.POST(
    req(owner.id, "POST", `${base(channel.id)}/e1/versions`, {
      content: "v2",
      filename: "t.md",
      note: "고침",
    }),
    ctx(channel.id, "e1"),
  );
  assert.equal(res.status, 201);
  assert.equal(server.lastRequest()!.headers["x-deskrpg-user"], owner.id);
  const bad = await routes.versions.POST(
    req(owner.id, "POST", `${base(channel.id)}/e1/versions`, { content: 1 }),
    ctx(channel.id, "e1"),
  );
  assert.equal(bad.status, 400);
});

test("delete is ok within scope, 404 outside", async () => {
  const { owner, channel } = await seedArtifactChannel();
  server.seedArtifact({ id: "d1", title: "t", profile: "sophie", body: "x" });
  const ok = await routes.item.DELETE(
    req(owner.id, "DELETE", `${base(channel.id)}/d1`),
    ctx(channel.id, "d1"),
  );
  assert.equal(ok.status, 200);
  server.seedArtifact({ id: "d2", title: "t", profile: "stranger", body: "x" });
  const out = await routes.item.DELETE(
    req(owner.id, "DELETE", `${base(channel.id)}/d2`),
    ctx(channel.id, "d2"),
  );
  assert.equal(out.status, 404);
});

/**
 * Channels A and B bound to the same gateway. Profile `sophie` is hired in both channels, `solo` only in A.
 * (The plugin gate is cached per gateway — two channels sharing one gateway is exactly this case.)
 */
async function seedSharedGateway() {
  const owner = await seedUser("artifact-shared-owner");
  const gateway = await seedGateway(owner.id, server.baseUrl);
  const { bindGatewayToChannel } = await import("@/lib/gateway-resources");
  const { channelBoardSlug } = await import("@/lib/kanban-boards");
  const a = await seedChannel(owner.id, "채널 A");
  const b = await seedChannel(owner.id, "채널 B");
  for (const ch of [a, b]) {
    await bindGatewayToChannel({
      channelId: ch.id,
      gatewayId: gateway.id,
      boundByUserId: owner.id,
    });
  }
  const sophie = await seedHermesProfile(gateway.id, {
    profileName: "sophie",
    displayName: "소피",
  });
  const solo = await seedHermesProfile(gateway.id, { profileName: "solo", displayName: "솔로" });
  await seedNpc({ channelId: a.id, hermesProfileId: sophie.id, positionX: 0, positionY: 0 });
  await seedNpc({ channelId: b.id, hermesProfileId: sophie.id, positionX: 1, positionY: 0 });
  await seedNpc({ channelId: a.id, hermesProfileId: solo.id, positionX: 2, positionY: 0 });
  return { owner, a, b, boardA: channelBoardSlug(a.id), boardB: channelBoardSlug(b.id) };
}

function mutatingArtifactRequests(since: number) {
  return server
    .requests()
    .slice(since)
    .filter(
      (r) =>
        r.path.startsWith("/deskrpg/artifacts") &&
        (r.method === "DELETE" || (r.method === "POST" && r.path.includes("/versions"))),
    );
}

test("F3: chat artifacts of a profile shared with another channel are read-only — edit/delete 403, nothing sent to the plugin", async () => {
  const { owner, b } = await seedSharedGateway();
  server.seedArtifact({ id: "shared-chat", title: "공유", profile: "sophie", body: "v1" });

  const got = await routes.item.GET(
    req(owner.id, "GET", `${base(b.id)}/shared-chat`),
    ctx(b.id, "shared-chat"),
  );
  assert.equal(got.status, 200);
  assert.equal((await got.json()).modifiable, false);

  const before = server.requests().length;
  const edit = await routes.versions.POST(
    req(owner.id, "POST", `${base(b.id)}/shared-chat/versions`, {
      content: "v2",
      filename: "t.md",
    }),
    ctx(b.id, "shared-chat"),
  );
  assert.equal(edit.status, 403);
  const editBody = await edit.json();
  assert.equal(editBody.code, "artifact_read_only_other_channel");
  assert.equal(editBody.message, "Artifacts from another channel are read-only here");
  const del = await routes.item.DELETE(
    req(owner.id, "DELETE", `${base(b.id)}/shared-chat`),
    ctx(b.id, "shared-chat"),
  );
  assert.equal(del.status, 403);
  assert.equal((await del.json()).code, "artifact_read_only_other_channel");
  assert.equal(mutatingArtifactRequests(before).length, 0, "플러그인 변경 경로를 부르지 않는다");
});

test("F3: chat artifacts of a profile hired only in this channel can be modified", async () => {
  const { owner, a } = await seedSharedGateway();
  server.seedArtifact({ id: "solo-chat", title: "솔로", profile: "solo", body: "v1" });
  const got = await routes.item.GET(
    req(owner.id, "GET", `${base(a.id)}/solo-chat`),
    ctx(a.id, "solo-chat"),
  );
  assert.equal((await got.json()).modifiable, true);
  const edit = await routes.versions.POST(
    req(owner.id, "POST", `${base(a.id)}/solo-chat/versions`, { content: "v2", filename: "t.md" }),
    ctx(a.id, "solo-chat"),
  );
  assert.equal(edit.status, 201);
  const del = await routes.item.DELETE(
    req(owner.id, "DELETE", `${base(a.id)}/solo-chat`),
    ctx(a.id, "solo-chat"),
  );
  assert.equal(del.status, 200);
});

test("F3: board artifacts are modified only from that board's channel — other channels are read-only", async () => {
  const { owner, a, b, boardA } = await seedSharedGateway();
  server.seedArtifact({
    id: "board-a",
    title: "카드 결과",
    profile: "sophie",
    board: boardA,
    source_kind: "kanban",
    task_id: "t-1",
    body: "v1",
  });
  const inB = await routes.item.GET(
    req(owner.id, "GET", `${base(b.id)}/board-a`),
    ctx(b.id, "board-a"),
  );
  assert.equal(inB.status, 200);
  const inBBody = await inB.json();
  assert.equal(inBBody.modifiable, false);
  assert.equal(inBBody.sourceInChannel, false, "다른 보드의 카드로는 출처 이동을 못 한다");

  const before = server.requests().length;
  const editB = await routes.versions.POST(
    req(owner.id, "POST", `${base(b.id)}/board-a/versions`, { content: "v2", filename: "t.md" }),
    ctx(b.id, "board-a"),
  );
  assert.equal(editB.status, 403);
  const delB = await routes.item.DELETE(
    req(owner.id, "DELETE", `${base(b.id)}/board-a`),
    ctx(b.id, "board-a"),
  );
  assert.equal(delB.status, 403);
  assert.equal(mutatingArtifactRequests(before).length, 0);

  const inA = await routes.item.GET(
    req(owner.id, "GET", `${base(a.id)}/board-a`),
    ctx(a.id, "board-a"),
  );
  const inABody = await inA.json();
  assert.equal(inABody.modifiable, true);
  assert.equal(inABody.sourceInChannel, true);
  const editA = await routes.versions.POST(
    req(owner.id, "POST", `${base(a.id)}/board-a/versions`, { content: "v2", filename: "t.md" }),
    ctx(a.id, "board-a"),
  );
  assert.equal(editA.status, 201);
  const delA = await routes.item.DELETE(
    req(owner.id, "DELETE", `${base(a.id)}/board-a`),
    ctx(a.id, "board-a"),
  );
  assert.equal(delA.status, 200);
});

test("F4: ids like '.', '..', 'a/b' are 404 artifact_not_found before the plugin is called", async () => {
  const { owner, channel } = await seedArtifactChannel();
  for (const bad of [".", "..", "a/b", "", "x".repeat(129), "a b"]) {
    const before = server.requests().length;
    const responses = [
      await routes.item.GET(req(owner.id, "GET", `${base(channel.id)}/x`), ctx(channel.id, bad)),
      await routes.item.DELETE(
        req(owner.id, "DELETE", `${base(channel.id)}/x`),
        ctx(channel.id, bad),
      ),
      await routes.versions.POST(
        req(owner.id, "POST", `${base(channel.id)}/x/versions`, { content: "v", filename: "t" }),
        ctx(channel.id, bad),
      ),
      await routes.content.GET(
        req(owner.id, "GET", `${base(channel.id)}/x/versions/1/content`),
        ctx(channel.id, bad, "1"),
      ),
    ];
    for (const res of responses) {
      assert.equal(res.status, 404, `id ${JSON.stringify(bad)}`);
      assert.equal((await res.json()).code, "artifact_not_found");
    }
    assert.equal(
      server
        .requests()
        .slice(before)
        .filter((r) => r.path.startsWith("/deskrpg/artifacts")).length,
      0,
      `id ${JSON.stringify(bad)} 로 결과물 경로를 부르지 않는다`,
    );
  }
});

test("F4: a plugin detail response without artifact is treated as 404", async () => {
  const { loadScopedArtifact } = await import("@/lib/artifact-access");
  const fakeCtx = {
    userId: "u",
    channelId: "c",
    gatewayId: "g",
    boardSlug: "deskrpg-c",
    profiles: ["sophie"],
    pluginVersion: "0.8.4",
    client: { artifacts: { get: async () => ({ ok: true, data: {} }) } },
  } as unknown as Parameters<typeof loadScopedArtifact>[0];
  const loaded = await loadScopedArtifact(fakeCtx, "abc");
  assert.equal(loaded.ok, false);
  if (!loaded.ok) {
    assert.equal(loaded.response.status, 404);
    assert.equal((await loaded.response.json()).code, "artifact_not_found");
  }
});

async function ownerPost(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${server.baseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: "Bearer gateway-owner-key-1234567890",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  assert.equal(res.ok, true, `${path} → ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

test("a board artifact's detail carries the card it came from and that card's parents", async () => {
  const { owner, channel, boardSlug } = await seedArtifactChannel();
  await ownerPost("/deskrpg/kanban/boards", { slug: boardSlug, name: "b" });
  const q = `?board=${encodeURIComponent(boardSlug)}`;
  const parent = (await ownerPost(`/deskrpg/kanban/tasks${q}`, { title: "Research" })).task as {
    id: string;
  };
  const child = (
    await ownerPost(`/deskrpg/kanban/tasks${q}`, {
      title: "Newsletter draft",
      assignee: "sophie",
      parents: [parent.id],
    })
  ).task as { id: string };
  server.seedArtifact({
    id: "made",
    title: "draft",
    profile: "sophie",
    board: boardSlug,
    task_id: child.id,
    source_kind: "kanban",
    body: "x",
  });
  server.seedArtifact({ id: "chatty", title: "chat", profile: "sophie", body: "x" });

  const res = await routes.item.GET(
    req(owner.id, "GET", `${base(channel.id)}/made`),
    ctx(channel.id, "made"),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.provenance.task.id, child.id);
  assert.equal(body.provenance.task.title, "Newsletter draft");
  assert.equal(body.provenance.task.assignee, "sophie");
  // The employee's display name, not the Hermes profile name.
  assert.equal(body.provenance.workerName, "소피");
  assert.deepEqual(
    body.provenance.parents.map((p: { id: string; title: string }) => [p.id, p.title]),
    [[parent.id, "Research"]],
  );
  assert.equal(body.provenance.moreParents, 0);

  const chat = await routes.item.GET(
    req(owner.id, "GET", `${base(channel.id)}/chatty`),
    ctx(channel.id, "chatty"),
  );
  assert.equal("provenance" in (await chat.json()), false);
});

test("an unreadable source card leaves the provenance out but the detail still opens", async () => {
  const { owner, channel, boardSlug } = await seedArtifactChannel();
  server.seedArtifact({
    id: "orphan",
    title: "orphan",
    profile: "sophie",
    board: boardSlug,
    task_id: "t_gone",
    source_kind: "kanban",
    body: "x",
  });
  const res = await routes.item.GET(
    req(owner.id, "GET", `${base(channel.id)}/orphan`),
    ctx(channel.id, "orphan"),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.artifact.id, "orphan");
  assert.equal("provenance" in body, false);
});

async function withSessionSources<T>(fn: () => Promise<T>): Promise<T> {
  server.setInfo({
    capabilities: ["kanban", "cron", "events", "artifacts", "session_sources"],
    version: "0.23.0",
  });
  try {
    return await fn();
  } finally {
    server.setInfo({ capabilities: ["kanban", "cron", "events", "artifacts"], version: "0.8.4" });
  }
}

const sourcesOf = async (userId: string, channelId: string, artifactId: string) => {
  const res = await routes.sources.GET(
    req(userId, "GET", `${base(channelId)}/${artifactId}/sources`),
    ctx(channelId, artifactId),
  );
  return { status: res.status, body: await res.json() };
};

test("sources are read with the artifact profile's own key and come back as a view", async () => {
  await withSessionSources(async () => {
    const { owner, channel } = await seedArtifactChannel();
    const artifact = server.seedArtifact({ id: "src1", title: "t", profile: "sophie", body: "x" });
    server.setSessionSources("sophie", artifact.session_id, {
      session_id: artifact.session_id,
      sources: [
        { kind: "web", ref: "https://a.example", title: "A", via: "web_extract", at: null },
        { kind: "file", ref: "notes.md", title: null, via: "read_file", at: null },
      ],
      outside_workdir_files: 2,
      truncated: false,
    });
    const { status, body } = await sourcesOf(owner.id, channel.id, "src1");
    assert.equal(status, 200);
    assert.equal(body.status, "ok");
    assert.deepEqual(
      body.sources.map((s: { ref: string }) => s.ref),
      ["https://a.example", "notes.md"],
    );
    assert.equal(body.outsideWorkdirFiles, 2);
    const last = server.lastRequest()!;
    assert.match(last.path, /^\/p\/sophie\/deskrpg\/sessions\/[^/]+\/sources$/);
    assert.equal(last.auth, "Bearer profile-key-1234567890");
  });
});

test("a session Hermes has deleted reads as expired", async () => {
  await withSessionSources(async () => {
    const { owner, channel } = await seedArtifactChannel();
    server.seedArtifact({ id: "old", title: "t", profile: "sophie", body: "x" });
    const { status, body } = await sourcesOf(owner.id, channel.id, "old");
    assert.equal(status, 200);
    assert.deepEqual(body, { status: "expired" });
  });
});

test("without the session_sources capability the view asks for a plugin update", async () => {
  const { owner, channel } = await seedArtifactChannel();
  server.seedArtifact({ id: "nocap", title: "t", profile: "sophie", body: "x" });
  const before = server.requests().length;
  const { body } = await sourcesOf(owner.id, channel.id, "nocap");
  assert.equal(body.status, "unavailable");
  assert.equal(body.reason, "plugin_upgrade_required");
  assert.equal(
    server
      .requests()
      .slice(before)
      .some((r) => r.path.includes("/sessions/")),
    false,
  );
});

test("a profile without a key on this gateway is unavailable, never read with the owner key", async () => {
  await withSessionSources(async () => {
    const { owner, channel, boardSlug } = await seedArtifactChannel();
    server.seedArtifact({
      id: "foreign-profile",
      title: "t",
      profile: "other",
      board: boardSlug,
      body: "x",
    });
    const before = server.requests().length;
    const { status, body } = await sourcesOf(owner.id, channel.id, "foreign-profile");
    assert.equal(status, 200);
    assert.deepEqual(body, { status: "unavailable", reason: "no_profile_key" });
    assert.equal(
      server
        .requests()
        .slice(before)
        .some((r) => r.path.includes("/sessions/")),
      false,
    );
  });
});

test("sources of an artifact outside the channel scope are 404", async () => {
  await withSessionSources(async () => {
    const { owner, channel } = await seedArtifactChannel();
    server.seedArtifact({ id: "far", title: "t", profile: "stranger", board: "x", body: "x" });
    const { status, body } = await sourcesOf(owner.id, channel.id, "far");
    assert.equal(status, 404);
    assert.equal(body.code, "artifact_not_found");
  });
});
