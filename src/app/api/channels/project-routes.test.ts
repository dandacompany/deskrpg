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

// Project registry REST (design 2026-09-21 project-registry).
//
// What we pin here: the board = project correspondence, lazy creation of metadata rows (so pre-migration channels are not blocked),
// permission layers (view = member, change = channel owner), tenant slug rules, moving the event-receiving board on archive,
// and that **we do not store names or progress** (Hermes values come through as is).
//
// Kept outside the `[id]` segment — the node test runner mistakes `[id]` for a character class.
setupThrowawaySqlite("project-routes-test");

const OWNER_TOKEN = "gateway-owner-key-1234567890";

let server: FakePluginServer;

before(async () => {
  server = await startFakePluginServer({ ownerToken: OWNER_TOKEN, profileTokens: { sophie: "p" } });
  const { registerAutomationHooks } = await import("@/lib/automation-registry");
  registerAutomationHooks({
    pollNow: async () => null,
    refreshPollers: async () => {},
    getWorkingSnapshot: () => [],
    emitRoomMessage: () => {},
  });
});

after(async () => {
  const { resetAutomationHooksForTests } = await import("@/lib/automation-registry");
  resetAutomationHooksForTests();
  await server.close();
});

type Routes = {
  projects: typeof import("./[id]/projects/route");
  project: typeof import("./[id]/projects/[projectId]/route");
  archive: typeof import("./[id]/projects/[projectId]/archive/route");
  subprojects: typeof import("./[id]/projects/[projectId]/subprojects/route");
  subproject: typeof import("./[id]/projects/[projectId]/subprojects/[subprojectId]/route");
};

async function loadRoutes(): Promise<Routes> {
  return {
    projects: await import("./[id]/projects/route"),
    project: await import("./[id]/projects/[projectId]/route"),
    archive: await import("./[id]/projects/[projectId]/archive/route"),
    subprojects: await import("./[id]/projects/[projectId]/subprojects/route"),
    subproject: await import("./[id]/projects/[projectId]/subprojects/[subprojectId]/route"),
  };
}

function req(userId: string, method: string, url: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: authHeaders(userId),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const base = (channelId: string) => `http://localhost/api/channels/${channelId}/projects`;
const ctx = (id: string, projectId = "", subprojectId = "") => ({
  params: Promise.resolve({ id, projectId, subprojectId }),
});

async function seedProjectChannel() {
  const owner = await seedUser("proj-owner");
  const gateway = await seedGateway(owner.id, server.baseUrl);
  const channel = await seedChannel(owner.id, "프로젝트 채널");
  const { bindGatewayToChannel } = await import("@/lib/gateway-resources");
  await bindGatewayToChannel({
    channelId: channel.id,
    gatewayId: gateway.id,
    boundByUserId: owner.id,
  });
  const profile = await seedHermesProfile(gateway.id, { profileName: "sophie" });
  const npc = await seedNpc({
    channelId: channel.id,
    hermesProfileId: profile.id,
    positionX: 0,
    positionY: 0,
  });
  const { channelBoardSlug } = await import("@/lib/kanban-boards");
  return {
    ownerId: owner.id,
    channelId: channel.id,
    npcId: npc.id,
    boardSlug: channelBoardSlug(channel.id),
  };
}

type ProjectView = {
  id: string;
  boardSlug: string;
  isEventCarrier: boolean;
  name: string | null;
  status: string;
  progress: { total: number; counts: Record<string, number> } | null;
};

async function listProjects(routes: Routes, userId: string, channelId: string) {
  const res = await routes.projects.GET(req(userId, "GET", base(channelId)), ctx(channelId));
  assert.equal(res.status, 200, await res.clone().text());
  return ((await res.json()) as { projects: ProjectView[] }).projects;
}

// ---------------------------------------------------------------------------
// Lazy creation — pre-migration channels are not blocked with "no project"
// ---------------------------------------------------------------------------

test("existing channels without a metadata row also get one project in the list", async () => {
  const routes = await loadRoutes();
  const seed = await seedProjectChannel();

  const { db, channelProjects } = await import("@/db");
  assert.equal((await db.select().from(channelProjects)).length, 0, "사전 조건: 메타 행이 없다");

  const projects = await listProjects(routes, seed.ownerId, seed.channelId);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].boardSlug, seed.boardSlug);
  assert.equal(projects[0].isEventCarrier, true, "기본 프로젝트는 사건 수신 보드다");
  assert.equal(projects[0].status, "planned");
});

test("lazy creation is idempotent — reading twice gives the same project id", async () => {
  const routes = await loadRoutes();
  const seed = await seedProjectChannel();
  const first = await listProjects(routes, seed.ownerId, seed.channelId);
  const second = await listProjects(routes, seed.ownerId, seed.channelId);
  assert.equal(first[0].id, second[0].id, "읽을 때마다 새 프로젝트가 생깁니다");
});

test("the path to add only a subproject to a channel without a metadata row is open", async () => {
  const routes = await loadRoutes();
  const seed = await seedProjectChannel();

  // The default path of chunk 1: get the default project id from the list and attach only a subproject.
  const projectId = (await listProjects(routes, seed.ownerId, seed.channelId))[0].id;
  const res = await routes.subprojects.POST(
    req(seed.ownerId, "POST", `${base(seed.channelId)}/${projectId}/subprojects`, {
      name: "가격 개편",
    }),
    ctx(seed.channelId, projectId),
  );
  assert.equal(res.status, 201, await res.clone().text());
  const body = (await res.json()) as { subproject: { tenantSlug: string; name: string } };
  assert.equal(body.subproject.name, "가격 개편");
  assert.equal(body.subproject.tenantSlug, "가격-개편", "한글 이름이 빈 슬러그가 되면 안 됩니다");
});

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

test("creating a project attaches one more board and Hermes holds the name", async () => {
  const routes = await loadRoutes();
  const seed = await seedProjectChannel();

  const res = await routes.projects.POST(
    req(seed.ownerId, "POST", base(seed.channelId), {
      name: "2026 4분기 콘텐츠 파이프라인",
      status: "in_progress",
      subprojects: [{ name: "리서치" }],
    }),
    ctx(seed.channelId),
  );
  assert.equal(res.status, 201, await res.clone().text());
  const body = (await res.json()) as {
    project: ProjectView;
    subprojects: { tenantSlug: string }[];
  };
  assert.equal(body.project.name, "2026 4분기 콘텐츠 파이프라인");
  assert.equal(body.project.status, "in_progress");
  assert.equal(body.project.isEventCarrier, false, "새 보드가 사건 수신 자리를 뺏으면 안 됩니다");
  assert.deepEqual(
    body.subprojects.map((s) => s.tenantSlug),
    ["리서치"],
  );

  // The name is not stored in our table — it must come from Hermes.
  const { db, channelProjects } = await import("@/db");
  const rows = await db.select().from(channelProjects);
  assert.ok(
    !Object.values(rows[0]).includes("2026 4분기 콘텐츠 파이프라인"),
    "프로젝트 이름이 DeskRPG 표에 복사됐습니다 — Hermes 가 정본입니다",
  );

  const projects = await listProjects(routes, seed.ownerId, seed.channelId);
  assert.equal(projects.length, 2);
});

test("a name without letters or digits gets a distinct answer that no slug can be made", async () => {
  const routes = await loadRoutes();
  const seed = await seedProjectChannel();
  const projectId = (await listProjects(routes, seed.ownerId, seed.channelId))[0].id;

  const res = await routes.subprojects.POST(
    req(seed.ownerId, "POST", `${base(seed.channelId)}/${projectId}/subprojects`, {
      name: "!!! ---",
    }),
    ctx(seed.channelId, projectId),
  );
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { code: string }).code, "tenant_slug_underivable");
});

test("a malformed slug given directly is rejected with a different code", async () => {
  const routes = await loadRoutes();
  const seed = await seedProjectChannel();
  const projectId = (await listProjects(routes, seed.ownerId, seed.channelId))[0].id;

  const res = await routes.subprojects.POST(
    req(seed.ownerId, "POST", `${base(seed.channelId)}/${projectId}/subprojects`, {
      name: "리서치",
      tenantSlug: "Has Spaces",
    }),
    ctx(seed.channelId, projectId),
  );
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { code: string }).code, "invalid_tenant_slug");
});

test("the same slug does not go into one project twice", async () => {
  const routes = await loadRoutes();
  const seed = await seedProjectChannel();
  const projectId = (await listProjects(routes, seed.ownerId, seed.channelId))[0].id;
  const url = `${base(seed.channelId)}/${projectId}/subprojects`;

  assert.equal(
    (
      await routes.subprojects.POST(
        req(seed.ownerId, "POST", url, { name: "리서치" }),
        ctx(seed.channelId, projectId),
      )
    ).status,
    201,
  );
  const dup = await routes.subprojects.POST(
    req(seed.ownerId, "POST", url, { name: "리서치" }),
    ctx(seed.channelId, projectId),
  );
  assert.equal(dup.status, 409);
  assert.equal(((await dup.json()) as { code: string }).code, "subproject_exists");
});

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

test("members can view but not create", async () => {
  const routes = await loadRoutes();
  const seed = await seedProjectChannel();
  const member = await seedUser("proj-member");
  const { db, channelMembers } = await import("@/db");
  await db
    .insert(channelMembers)
    .values({ channelId: seed.channelId, userId: member.id, role: "member" });

  const view = await routes.projects.GET(
    req(member.id, "GET", base(seed.channelId)),
    ctx(seed.channelId),
  );
  assert.equal(view.status, 200);

  const create = await routes.projects.POST(
    req(member.id, "POST", base(seed.channelId), { name: "멤버가 만든 프로젝트" }),
    ctx(seed.channelId),
  );
  assert.equal(create.status, 403);
  assert.equal(((await create.json()) as { code: string }).code, "forbidden");
});

test("non-members cannot even see the list", async () => {
  const routes = await loadRoutes();
  const seed = await seedProjectChannel();
  const stranger = await seedUser("proj-stranger");
  const res = await routes.projects.GET(
    req(stranger.id, "GET", base(seed.channelId)),
    ctx(seed.channelId),
  );
  assert.equal(res.status, 403);
});

test("a project id of another channel does not open", async () => {
  const routes = await loadRoutes();
  const mine = await seedProjectChannel();
  const theirs = await seedProjectChannel();
  const theirProjectId = (await listProjects(routes, theirs.ownerId, theirs.channelId))[0].id;

  const res = await routes.project.GET(
    req(mine.ownerId, "GET", `${base(mine.channelId)}/${theirProjectId}`),
    ctx(mine.channelId, theirProjectId),
  );
  assert.equal(res.status, 404);
  assert.equal(((await res.json()) as { code: string }).code, "project_not_found");
});

// ---------------------------------------------------------------------------
// Edit and archive
// ---------------------------------------------------------------------------

test("name edits go to the Hermes board", async () => {
  const routes = await loadRoutes();
  const seed = await seedProjectChannel();
  const projectId = (await listProjects(routes, seed.ownerId, seed.channelId))[0].id;

  const res = await routes.project.PATCH(
    req(seed.ownerId, "PATCH", `${base(seed.channelId)}/${projectId}`, {
      name: "새 이름",
      status: "in_progress",
      leadNpcId: seed.npcId,
    }),
    ctx(seed.channelId, projectId),
  );
  assert.equal(res.status, 200, await res.clone().text());
  const body = (await res.json()) as { project: ProjectView & { leadNpcId: string } };
  assert.equal(body.project.name, "새 이름");
  assert.equal(body.project.status, "in_progress");
  assert.equal(body.project.leadNpcId, seed.npcId);

  // Reading again still shows the Hermes-side name.
  assert.equal((await listProjects(routes, seed.ownerId, seed.channelId))[0].name, "새 이름");
});

test("an NPC of another channel cannot be lead", async () => {
  const routes = await loadRoutes();
  const mine = await seedProjectChannel();
  const theirs = await seedProjectChannel();
  const projectId = (await listProjects(routes, mine.ownerId, mine.channelId))[0].id;

  const res = await routes.project.PATCH(
    req(mine.ownerId, "PATCH", `${base(mine.channelId)}/${projectId}`, { leadNpcId: theirs.npcId }),
    ctx(mine.channelId, projectId),
  );
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { code: string }).code, "lead_npc_not_in_channel");
});

test("the last active project is not archived", async () => {
  const routes = await loadRoutes();
  const seed = await seedProjectChannel();
  const projectId = (await listProjects(routes, seed.ownerId, seed.channelId))[0].id;

  const res = await routes.archive.POST(
    req(seed.ownerId, "POST", `${base(seed.channelId)}/${projectId}/archive`, {}),
    ctx(seed.channelId, projectId),
  );
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { code: string }).code, "last_board");
});

test("archiving the event-receiving board moves that role to another board", async () => {
  const routes = await loadRoutes();
  const seed = await seedProjectChannel();

  const created = await routes.projects.POST(
    req(seed.ownerId, "POST", base(seed.channelId), { name: "둘째 프로젝트" }),
    ctx(seed.channelId),
  );
  assert.equal(created.status, 201);
  const secondSlug = ((await created.json()) as { project: ProjectView }).project.boardSlug;

  const projects = await listProjects(routes, seed.ownerId, seed.channelId);
  const carrier = projects.find((p) => p.isEventCarrier);
  assert.ok(carrier);

  const res = await routes.archive.POST(
    req(seed.ownerId, "POST", `${base(seed.channelId)}/${carrier.id}/archive`, {
      status: "completed",
    }),
    ctx(seed.channelId, carrier.id),
  );
  assert.equal(res.status, 200, await res.clone().text());
  const body = (await res.json()) as { carrierMovedTo: string | null };
  assert.equal(body.carrierMovedTo, secondSlug);

  const { listChannelBoards } = await import("@/lib/kanban-boards");
  const rows = await listChannelBoards(seed.channelId);
  assert.equal(
    rows.filter((r) => r.isEventCarrier).length,
    1,
    "사건 수신 보드가 하나가 아니면 크론 사건이 중복되거나 사라집니다",
  );
  assert.equal(rows.find((r) => r.isEventCarrier)?.boardSlug, secondSlug);
});

test("after moving the event-receiving role, unreceived card events of the target board are still received", async () => {
  const routes = await loadRoutes();
  const seed = await seedProjectChannel();
  const created = await routes.projects.POST(
    req(seed.ownerId, "POST", base(seed.channelId), { name: "둘째 프로젝트" }),
    ctx(seed.channelId),
  );
  const secondSlug = ((await created.json()) as { project: ProjectView }).project.boardSlug;

  // Store the target board's real first polling token, then create a card event not yet received.
  const { db, channelKanbanBoards } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  const { createOwnerPluginClient } = await import("@/lib/hermes/plugin-client");
  const { listChannelBoards } = await import("@/lib/kanban-boards");
  const events = createOwnerPluginClient({
    baseUrl: server.baseUrl,
    ownerToken: OWNER_TOKEN,
  }).events;
  const first = await events.poll({ board: secondSlug });
  assert.ok(first.ok);
  const pending = server.pushEvent({
    kind: "task.created",
    board: secondSlug,
    task_id: "pending-target-card",
    payload: { title: "미수신 카드" },
  });
  const second = (await listChannelBoards(seed.channelId)).find((r) => r.boardSlug === secondSlug);
  assert.ok(second);
  await db
    .update(channelKanbanBoards)
    .set({ eventCursor: first.data.cursor })
    .where(eq(channelKanbanBoards.id, second.id));

  const carrier = (await listProjects(routes, seed.ownerId, seed.channelId)).find(
    (p) => p.isEventCarrier,
  );
  assert.ok(carrier);
  const archived = await routes.archive.POST(
    req(seed.ownerId, "POST", `${base(seed.channelId)}/${carrier.id}/archive`, {}),
    ctx(seed.channelId, carrier.id),
  );
  assert.equal(archived.status, 200, await archived.clone().text());

  const promoted = (await listChannelBoards(seed.channelId)).find((r) => r.isEventCarrier);
  assert.equal(promoted?.boardSlug, secondSlug);
  assert.ok(promoted?.eventCursor);
  const next = await events.poll({ board: secondSlug, cursor: promoted.eventCursor });
  assert.ok(next.ok);
  assert.deepEqual(
    next.data.events.map((event) => event.id),
    [pending.id],
  );
});

test("archiving keeps the board link — polling must continue", async () => {
  const routes = await loadRoutes();
  const seed = await seedProjectChannel();
  const created = await routes.projects.POST(
    req(seed.ownerId, "POST", base(seed.channelId), { name: "보관될 프로젝트" }),
    ctx(seed.channelId),
  );
  const target = ((await created.json()) as { project: ProjectView }).project;

  await routes.archive.POST(
    req(seed.ownerId, "POST", `${base(seed.channelId)}/${target.id}/archive`, {}),
    ctx(seed.channelId, target.id),
  );

  const { listChannelBoards } = await import("@/lib/kanban-boards");
  const rows = await listChannelBoards(seed.channelId);
  assert.ok(
    rows.some((r) => r.boardSlug === target.boardSlug),
    "보관이 연결 행을 지웠습니다 — 돌고 있던 카드의 사건이 끊깁니다",
  );
  const projects = await listProjects(routes, seed.ownerId, seed.channelId);
  assert.equal(projects.find((p) => p.id === target.id)?.status, "completed");
});

// ---------------------------------------------------------------------------
// Observed tenants
// ---------------------------------------------------------------------------

test("tenants of cards made outside are not hidden but included as unregistered", async () => {
  const routes = await loadRoutes();
  const seed = await seedProjectChannel();
  const projectId = (await listProjects(routes, seed.ownerId, seed.channelId))[0].id;

  // Cards appeared on the board without going through DeskRPG — made by the Hermes CLI or another tool.
  const kanban = await import("./[id]/kanban/tasks/route");
  const made = await kanban.POST(
    new NextRequest(`http://localhost/api/channels/${seed.channelId}/kanban/tasks`, {
      method: "POST",
      headers: authHeaders(seed.ownerId),
      body: JSON.stringify({ title: "밖에서 온 카드", tenant: "외부-테넌트" }),
    }),
    ctx(seed.channelId),
  );
  assert.equal(made.status, 201, await made.clone().text());

  const res = await routes.subprojects.GET(
    req(seed.ownerId, "GET", `${base(seed.channelId)}/${projectId}/subprojects`),
    ctx(seed.channelId, projectId),
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { subprojects: unknown[]; unregisteredTenants: string[] };
  assert.deepEqual(body.unregisteredTenants, ["외부-테넌트"]);
  assert.equal(body.subprojects.length, 0);
});

test("a registered subproject's display name can change but its slug is fixed", async () => {
  const routes = await loadRoutes();
  const seed = await seedProjectChannel();
  const projectId = (await listProjects(routes, seed.ownerId, seed.channelId))[0].id;

  const made = await routes.subprojects.POST(
    req(seed.ownerId, "POST", `${base(seed.channelId)}/${projectId}/subprojects`, {
      name: "리서치",
    }),
    ctx(seed.channelId, projectId),
  );
  const sub = ((await made.json()) as { subproject: { id: string; tenantSlug: string } })
    .subproject;

  const res = await routes.subproject.PATCH(
    req(seed.ownerId, "PATCH", `${base(seed.channelId)}/${projectId}/subprojects/${sub.id}`, {
      name: "리서치(개편)",
      tenantSlug: "무시되어야-한다",
      status: "in_progress",
    }),
    ctx(seed.channelId, projectId, sub.id),
  );
  assert.equal(res.status, 200, await res.clone().text());
  const body = (await res.json()) as {
    subproject: { name: string; tenantSlug: string; status: string };
  };
  assert.equal(body.subproject.name, "리서치(개편)");
  assert.equal(body.subproject.status, "in_progress");
  assert.equal(
    body.subproject.tenantSlug,
    sub.tenantSlug,
    "슬러그가 바뀌면 이미 만들어진 카드가 고아가 됩니다",
  );
});
