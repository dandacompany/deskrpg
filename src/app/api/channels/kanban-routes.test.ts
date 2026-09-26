import test, { after, before, beforeEach } from "node:test";
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

// T6. Kanban REST + automation status + immediate polling wiring.
//
// Hermes is the source of truth and not a single card is stored here. What we pin here is the
// permission table (view and card operations = member, board work folder = channel owner, reading host operation settings = channel
// owner, modifying = gateway owner), assignee validation (only the channel's active NPCs), one
// dispatch + immediate poll after create and status changes, and the gates (428, 409, 503, 404 attachments_unsupported).
//
// Kept outside the `[id]` segment — the node test runner mistakes `[id]` for a character class and misses
// the *.test.ts inside it.
setupThrowawaySqlite("kanban-routes-test");

const OWNER_TOKEN = "gateway-owner-key-1234567890";
const PROFILE_TOKEN = "profile-key-1234567890";

let server: FakePluginServer;
/** Channel ids of the immediate polls the routes requested — collected here instead of by a real poller. */
let polled: string[] = [];

before(async () => {
  server = await startFakePluginServer({
    ownerToken: OWNER_TOKEN,
    profileTokens: { sophie: PROFILE_TOKEN, noah: PROFILE_TOKEN },
  });
  // Routes do not look at `@/server/*` directly; they meet the poller through the registry — plug a recorder in here.
  const { registerAutomationHooks } = await import("@/lib/automation-registry");
  registerAutomationHooks({
    pollNow: async (channelId) => {
      polled.push(channelId);
      return null;
    },
    refreshPollers: async () => {},
    getWorkingSnapshot: () => [],
    emitRoomMessage: () => {},
  });
});

beforeEach(() => {
  polled = [];
});

after(async () => {
  const { resetAutomationHooksForTests } = await import("@/lib/automation-registry");
  resetAutomationHooksForTests();
  await server.close();
});

type Routes = {
  board: typeof import("./[id]/kanban/board/route");
  runs: typeof import("./[id]/kanban/runs/route");
  events: typeof import("./[id]/kanban/events/route");
  boardAttachments: typeof import("./[id]/kanban/attachments/route");
  tasks: typeof import("./[id]/kanban/tasks/route");
  task: typeof import("./[id]/kanban/tasks/[taskId]/route");
  comments: typeof import("./[id]/kanban/tasks/[taskId]/comments/route");
  reassign: typeof import("./[id]/kanban/tasks/[taskId]/reassign/route");
  reclaim: typeof import("./[id]/kanban/tasks/[taskId]/reclaim/route");
  approve: typeof import("./[id]/kanban/tasks/[taskId]/approve/route");
  requestChanges: typeof import("./[id]/kanban/tasks/[taskId]/request-changes/route");
  unblock: typeof import("./[id]/kanban/tasks/[taskId]/unblock/route");
  terminate: typeof import("./[id]/kanban/tasks/[taskId]/terminate/route");
  archive: typeof import("./[id]/kanban/tasks/[taskId]/archive/route");
  specify: typeof import("./[id]/kanban/tasks/[taskId]/specify/route");
  log: typeof import("./[id]/kanban/tasks/[taskId]/log/route");
  taskAttachments: typeof import("./[id]/kanban/tasks/[taskId]/attachments/route");
  attachment: typeof import("./[id]/kanban/attachments/[attachmentId]/route");
  links: typeof import("./[id]/kanban/links/route");
  dispatch: typeof import("./[id]/kanban/dispatch/route");
  settings: typeof import("./[id]/kanban/settings/route");
  status: typeof import("./[id]/automation/status/route");
};

async function loadRoutes(): Promise<Routes> {
  return {
    board: await import("./[id]/kanban/board/route"),
    tasks: await import("./[id]/kanban/tasks/route"),
    task: await import("./[id]/kanban/tasks/[taskId]/route"),
    comments: await import("./[id]/kanban/tasks/[taskId]/comments/route"),
    reassign: await import("./[id]/kanban/tasks/[taskId]/reassign/route"),
    reclaim: await import("./[id]/kanban/tasks/[taskId]/reclaim/route"),
    approve: await import("./[id]/kanban/tasks/[taskId]/approve/route"),
    requestChanges: await import("./[id]/kanban/tasks/[taskId]/request-changes/route"),
    unblock: await import("./[id]/kanban/tasks/[taskId]/unblock/route"),
    terminate: await import("./[id]/kanban/tasks/[taskId]/terminate/route"),
    archive: await import("./[id]/kanban/tasks/[taskId]/archive/route"),
    specify: await import("./[id]/kanban/tasks/[taskId]/specify/route"),
    log: await import("./[id]/kanban/tasks/[taskId]/log/route"),
    taskAttachments: await import("./[id]/kanban/tasks/[taskId]/attachments/route"),
    attachment: await import("./[id]/kanban/attachments/[attachmentId]/route"),
    links: await import("./[id]/kanban/links/route"),
    runs: await import("./[id]/kanban/runs/route"),
    events: await import("./[id]/kanban/events/route"),
    boardAttachments: await import("./[id]/kanban/attachments/route"),
    dispatch: await import("./[id]/kanban/dispatch/route"),
    settings: await import("./[id]/kanban/settings/route"),
    status: await import("./[id]/automation/status/route"),
  };
}

function req(
  userId: string,
  method: string,
  url: string,
  body?: unknown,
  cookie?: string,
): NextRequest {
  return new NextRequest(url, {
    method,
    headers: cookie ? { ...authHeaders(userId), cookie } : authHeaders(userId),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const base = (channelId: string) => `http://localhost/api/channels/${channelId}/kanban`;
const ctx = (id: string, taskId = "", attachmentId = "") => ({
  params: Promise.resolve({ id, taskId, attachmentId }),
});

/**
 * One channel + a gateway pointing at a fake plugin server (owner = channel owner) + an active NPC for profile
 * `sophie`. Passing `gatewayOwnerId` sets a separate gateway owner.
 */
async function seedKanbanChannel(
  opts: { extraProfiles?: string[]; gatewayOwnerId?: string; baseUrl?: string } = {},
) {
  const owner = await seedUser("kanban-owner");
  const gatewayOwnerId = opts.gatewayOwnerId ?? owner.id;
  const gateway = await seedGateway(gatewayOwnerId, opts.baseUrl ?? server.baseUrl);
  const channel = await seedChannel(owner.id, "칸반 채널");
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
  const npc = await seedNpc({
    channelId: channel.id,
    hermesProfileId: profile.id,
    name: "STALE-NPC-NAME",
    positionX: 0,
    positionY: 0,
  });
  const extras: Array<{ profileId: string; npcId: string; name: string }> = [];
  let column = 1;
  for (const name of opts.extraProfiles ?? []) {
    const extra = await seedHermesProfile(gateway.id, { profileName: name });
    const extraNpc = await seedNpc({
      channelId: channel.id,
      hermesProfileId: extra.id,
      positionX: column++,
      positionY: 0,
    });
    extras.push({ profileId: extra.id, npcId: extraNpc.id, name });
  }
  const { channelBoardSlug } = await import("@/lib/kanban-boards");
  return {
    ownerId: owner.id,
    gatewayOwnerId,
    gatewayId: gateway.id,
    channelId: channel.id,
    profileId: profile.id,
    npcId: npc.id,
    boardSlug: channelBoardSlug(channel.id),
    extras,
  };
}

async function addMember(channelId: string, userId: string) {
  const { db, channelMembers } = await import("@/db");
  await db.insert(channelMembers).values({ channelId, userId, role: "member" });
}

async function createTask(
  routes: Routes,
  userId: string,
  channelId: string,
  overrides: Record<string, unknown> = {},
  cookie?: string,
) {
  const res = await routes.tasks.POST(
    req(userId, "POST", `${base(channelId)}/tasks`, { title: "첫 카드", ...overrides }, cookie),
    ctx(channelId),
  );
  return { status: res.status, body: await res.json() };
}

function dispatchCalls(sinceIndex: number) {
  return server
    .requests()
    .slice(sinceIndex)
    .filter((r) => r.method === "POST" && r.path.startsWith("/deskrpg/kanban/dispatch"));
}

test("viewing the board — members get 200 + roster, non-members 403, no login 401", async () => {
  server.reset();
  const routes = await loadRoutes();
  const seed = await seedKanbanChannel({ extraProfiles: ["noah"] });
  const member = await seedUser("member");
  await addMember(seed.channelId, member.id);
  const stranger = await seedUser("stranger");

  // Even asleep, noah stays in the roster with active=false (for mapping assignee → npc).
  const { setNpcActive } = await import("@/lib/npc-roster");
  await setNpcActive(seed.extras[0].npcId, false);

  const ok = await routes.board.GET(
    req(member.id, "GET", `${base(seed.channelId)}/board`),
    ctx(seed.channelId),
  );
  assert.equal(ok.status, 200, JSON.stringify(await ok.clone().json()));
  const body = await ok.json();
  assert.ok(Array.isArray(body.columns));
  assert.ok(!body.columns.some((c: { name: string }) => c.name === "archived"));
  assert.deepEqual(
    body.npcs
      .toSorted((a: { profileName: string }, b: { profileName: string }) =>
        a.profileName.localeCompare(b.profileName),
      )
      .map((n: Record<string, unknown>) => ({
        npcId: n.npcId,
        npcName: n.npcName,
        profileName: n.profileName,
        active: n.active,
      })),
    [
      { npcId: seed.extras[0].npcId, npcName: "noah", profileName: "noah", active: false },
      { npcId: seed.npcId, npcName: "소피", profileName: "sophie", active: true },
    ],
  );

  const archived = await routes.board.GET(
    req(seed.ownerId, "GET", `${base(seed.channelId)}/board?include_archived=true`),
    ctx(seed.channelId),
  );
  assert.ok((await archived.json()).columns.some((c: { name: string }) => c.name === "archived"));

  const forbidden = await routes.board.GET(
    req(stranger.id, "GET", `${base(seed.channelId)}/board`),
    ctx(seed.channelId),
  );
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).code, "not_a_member");

  const anonymous = await routes.board.GET(
    new NextRequest(`${base(seed.channelId)}/board`),
    ctx(seed.channelId),
  );
  assert.equal(anonymous.status, 401);
});

test("409 gateway_not_bound when no gateway is bound", async () => {
  server.reset();
  const routes = await loadRoutes();
  const owner = await seedUser("unbound-owner");
  const channel = await seedChannel(owner.id);
  const res = await routes.board.GET(
    req(owner.id, "GET", `${base(channel.id)}/board`),
    ctx(channel.id),
  );
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "gateway_not_bound");
});

test("if the cache says 0.5.0, Hermes is not called and it is 428 plugin_upgrade_required", async () => {
  server.reset();
  const routes = await loadRoutes();
  const seed = await seedKanbanChannel();
  const { db, gatewayResources, nowForDb } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  await db
    .update(gatewayResources)
    .set({
      pluginStatus: "plugin_ready",
      pluginVersion: "0.5.0",
      pluginCheckedAt: nowForDb(),
      pluginInfoJson: JSON.stringify({
        plugin: "deskrpg",
        version: "0.5.0",
        capabilities: [],
        timezone: null,
        kanban: { dispatcher_present: false, attachments: false },
      }),
    })
    .where(eq(gatewayResources.id, seed.gatewayId));

  const before = server.requests().length;
  const res = await routes.board.GET(
    req(seed.ownerId, "GET", `${base(seed.channelId)}/board`),
    ctx(seed.channelId),
  );
  assert.equal(res.status, 428);
  const body = await res.json();
  assert.equal(body.code, "plugin_upgrade_required");
  assert.equal(body.minVersion, "0.6.0");
  assert.equal(server.requests().length, before, "신선한 캐시면 Hermes 를 부르지 않는다");
});

test("503 {code, message} when the board cannot be secured", async () => {
  server.reset();
  const routes = await loadRoutes();
  // The gateway points at an unreachable address, but the plugin cache is a fresh "ready", so
  // the 428 gate passes — it must be blocked at securing the board (createBoard).
  const seed = await seedKanbanChannel({ baseUrl: "http://127.0.0.1:1" });
  const { db, gatewayResources, nowForDb } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  await db
    .update(gatewayResources)
    .set({
      pluginStatus: "plugin_ready",
      pluginVersion: "0.6.0",
      pluginCheckedAt: nowForDb(),
      pluginInfoJson: JSON.stringify({
        plugin: "deskrpg",
        version: "0.6.0",
        capabilities: ["kanban", "cron", "events"],
        timezone: "Asia/Seoul",
        kanban: { dispatcher_present: true, attachments: true },
      }),
    })
    .where(eq(gatewayResources.id, seed.gatewayId));

  const res = await routes.board.GET(
    req(seed.ownerId, "GET", `${base(seed.channelId)}/board`),
    ctx(seed.channelId),
  );
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(typeof body.code, "string");
  assert.equal(typeof body.message, "string");
});

test("card creation — assignee is taken as npcId and sent as profile_name, one dispatch + immediate poll", async () => {
  server.reset();
  const routes = await loadRoutes();
  const seed = await seedKanbanChannel();
  const member = await seedUser("member");
  await addMember(seed.channelId, member.id);

  const before = server.requests().length;
  const created = await createTask(routes, member.id, seed.channelId, {
    assignee: seed.npcId,
    body: "본문",
    priority: "high",
    skills: ["research"],
    workspace_kind: "scratch",
    goal_mode: true,
    goal_max_turns: 3,
    max_runtime_seconds: 600,
    unknown_field: "버린다",
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.task.assignee, "sophie");
  assert.equal(created.body.task.priority, "high");

  const sent = server
    .requests()
    .slice(before)
    .find((r) => r.method === "POST" && r.path.startsWith("/deskrpg/kanban/tasks?"));
  assert.ok(sent);
  assert.equal(sent.auth, `Bearer ${OWNER_TOKEN}`, "오너 토큰으로 부른다");
  const sentBody = sent.json as Record<string, unknown>;
  assert.equal(sentBody.assignee, "sophie");
  assert.equal(sentBody.npcId, undefined);
  assert.equal(sentBody.unknown_field, undefined);
  assert.deepEqual(sentBody.skills, ["research"]);
  assert.equal(sentBody.goal_max_turns, 3);
  // The creator is the card's requester — the plugin records `created_by: deskrpg:<userId>` from this header, the
  // person told when an unattended run of the card is blocked.
  assert.equal(sent.headers["x-deskrpg-actor"], member.id);

  assert.equal(dispatchCalls(before).length, 1, "생성 직후 dispatch 를 한 번 요청한다");
  assert.deepEqual(polled, [seed.channelId], "생성 직후 즉시 폴링을 요청한다");
});

test("card creation — a requester line at the end of the body if the creator has a character, otherwise the body as is", async () => {
  server.reset();
  const routes = await loadRoutes();
  const seed = await seedKanbanChannel();
  const { db, characters } = await import("@/db");
  const withChar = await seedUser("requester");
  await addMember(seed.channelId, withChar.id);
  await db
    .insert(characters)
    .values({ userId: withChar.id, name: "곽지호", bio: "단테랩스 대표", appearance: "{}" });
  const noChar = await seedUser("no-character");
  await addMember(seed.channelId, noChar.id);

  const sentBodies = (since: number) =>
    server
      .requests()
      .slice(since)
      .filter((r) => r.method === "POST" && r.path.startsWith("/deskrpg/kanban/tasks?"))
      .map((r) => (r.json as Record<string, unknown>).body);

  // The requester line is written in the requester's language (their language cookie).
  const ko = "deskrpg-locale=ko";
  let before = server.requests().length;
  assert.equal(
    (await createTask(routes, withChar.id, seed.channelId, { body: "본문" }, ko)).status,
    201,
  );
  assert.deepEqual(sentBodies(before), ["본문\n\n요청자: 곽지호 — 단테랩스 대표"]);

  before = server.requests().length;
  assert.equal((await createTask(routes, withChar.id, seed.channelId, {}, ko)).status, 201);
  assert.deepEqual(sentBodies(before), ["요청자: 곽지호 — 단테랩스 대표"]);

  // No language cookie falls back to English, like every other server-written text.
  before = server.requests().length;
  assert.equal(
    (await createTask(routes, withChar.id, seed.channelId, { body: "body" })).status,
    201,
  );
  assert.deepEqual(sentBodies(before), ["body\n\nRequested by: 곽지호 — 단테랩스 대표"]);

  before = server.requests().length;
  assert.equal(
    (await createTask(routes, noChar.id, seed.channelId, { body: "본문" })).status,
    201,
    "캐릭터가 없어도 카드는 만들어진다",
  );
  assert.deepEqual(sentBodies(before), ["본문"]);
});

test("assignee validation — sleeping NPCs and other channels' NPCs are 400 assignee_not_in_channel and Hermes is not called", async () => {
  server.reset();
  const routes = await loadRoutes();
  const seed = await seedKanbanChannel({ extraProfiles: ["noah"] });
  const other = await seedKanbanChannel();
  const { setNpcActive } = await import("@/lib/npc-roster");
  await setNpcActive(seed.extras[0].npcId, false);

  const before = server.requests().length;
  for (const assignee of [seed.extras[0].npcId, other.npcId, "no-such-npc"]) {
    const res = await createTask(routes, seed.ownerId, seed.channelId, { assignee });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.code, "assignee_not_in_channel");
  }
  assert.equal(
    server
      .requests()
      .slice(before)
      .filter((r) => r.method === "POST").length,
    0,
    "검증 실패는 플러그인에 닿기 전에 끝난다",
  );
  assert.deepEqual(polled, []);

  // Created without an assignee, it follows Hermes rules (triage) — the status is not reinterpreted here.
  const none = await createTask(routes, seed.ownerId, seed.channelId, { title: "담당 없음" });
  assert.equal(none.status, 201);
  assert.equal(none.body.task.assignee, undefined);
});

test("creation without a title is 400, and Hermes 400/404 pass through with status code and {code, message}", async () => {
  server.reset();
  const routes = await loadRoutes();
  const seed = await seedKanbanChannel();

  const missing = await routes.tasks.POST(
    req(seed.ownerId, "POST", `${base(seed.channelId)}/tasks`, { body: "제목 없음" }),
    ctx(seed.channelId),
  );
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).code, "invalid_body");

  // A missing parent → the plugin's 404 unknown_parent as is.
  const bad = await createTask(routes, seed.ownerId, seed.channelId, { parents: ["ghost"] });
  assert.equal(bad.status, 404);
  assert.equal(bad.body.code, "unknown_parent");
  assert.equal(typeof bad.body.message, "string");
  assert.deepEqual(polled, [], "실패한 생성은 폴링하지 않는다");

  // An invalid status → the plugin's 400 invalid_status as is.
  const created = await createTask(routes, seed.ownerId, seed.channelId);
  const patched = await routes.task.PATCH(
    req(seed.ownerId, "PATCH", `${base(seed.channelId)}/tasks/${created.body.task.id}`, {
      status: "flying",
    }),
    ctx(seed.channelId, created.body.task.id),
  );
  assert.equal(patched.status, 400);
  assert.equal((await patched.json()).code, "invalid_status");
});

test("detail, PATCH, delete, comments, links, log, dispatch — any member, immediate poll after changes", async () => {
  server.reset();
  const routes = await loadRoutes();
  const seed = await seedKanbanChannel({ extraProfiles: ["noah"] });
  const member = await seedUser("member");
  await addMember(seed.channelId, member.id);

  const parent = await createTask(routes, member.id, seed.channelId, { title: "부모" });
  const child = await createTask(routes, member.id, seed.channelId, { title: "자식" });
  const parentId = parent.body.task.id as string;
  const childId = child.body.task.id as string;
  polled = [];

  // PATCH — status and assignee (npcId → profile). One dispatch after a status change.
  const before = server.requests().length;
  const patched = await routes.task.PATCH(
    req(member.id, "PATCH", `${base(seed.channelId)}/tasks/${childId}`, {
      status: "ready",
      assignee: seed.extras[0].npcId,
      title: "자식(수정)",
    }),
    ctx(seed.channelId, childId),
  );
  assert.equal(patched.status, 200, JSON.stringify(await patched.clone().json()));
  const patchedBody = await patched.json();
  assert.equal(patchedBody.task.assignee, "noah");
  assert.equal(patchedBody.task.title, "자식(수정)");
  // The fake server's dispatch launches ready cards as running.
  assert.equal(dispatchCalls(before).length, 1);
  assert.deepEqual(polled, [seed.channelId]);

  // Editing only the title does not dispatch (it is not a status change).
  const before2 = server.requests().length;
  const renamed = await routes.task.PATCH(
    req(member.id, "PATCH", `${base(seed.channelId)}/tasks/${parentId}`, { title: "부모2" }),
    ctx(seed.channelId, parentId),
  );
  assert.equal(renamed.status, 200);
  assert.equal(dispatchCalls(before2).length, 0);

  // Comments — author is deskrpg:<nickname>.
  const { db, users } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  const [memberRow] = await db.select().from(users).where(eq(users.id, member.id));
  const commented = await routes.comments.POST(
    req(member.id, "POST", `${base(seed.channelId)}/tasks/${childId}/comments`, {
      body: "잘 부탁해",
    }),
    ctx(seed.channelId, childId),
  );
  assert.equal(commented.status, 201);
  assert.equal((await commented.json()).comment.author, `deskrpg:${memberRow.nickname}`);

  // add/delete links
  const linked = await routes.links.POST(
    req(member.id, "POST", `${base(seed.channelId)}/links`, {
      parent_id: parentId,
      child_id: childId,
    }),
    ctx(seed.channelId),
  );
  assert.equal(linked.status, 200);
  const detail = await routes.task.GET(
    req(member.id, "GET", `${base(seed.channelId)}/tasks/${childId}`),
    ctx(seed.channelId, childId),
  );
  assert.equal(detail.status, 200);
  const detailBody = await detail.json();
  assert.deepEqual(detailBody.links.parents, [parentId]);
  assert.equal(detailBody.comments.length, 1);
  const unlinked = await routes.links.DELETE(
    req(member.id, "DELETE", `${base(seed.channelId)}/links`, {
      parent_id: parentId,
      child_id: childId,
    }),
    ctx(seed.channelId),
  );
  assert.equal(unlinked.status, 200);

  // log tail
  server.setTaskLog(seed.boardSlug, childId, "a\nb\nc\n");
  const log = await routes.log.GET(
    req(member.id, "GET", `${base(seed.channelId)}/tasks/${childId}/log?tail=1`),
    ctx(seed.channelId, childId),
  );
  assert.equal(log.status, 200);
  const logBody = await log.json();
  assert.equal(logBody.content, "c\n");
  assert.equal(logBody.truncated, true);

  // explicit dispatch
  const dispatched = await routes.dispatch.POST(
    req(member.id, "POST", `${base(seed.channelId)}/dispatch`),
    ctx(seed.channelId),
  );
  assert.equal(dispatched.status, 200);
  assert.ok(Array.isArray((await dispatched.json()).spawned));

  // delete
  const deleted = await routes.task.DELETE(
    req(member.id, "DELETE", `${base(seed.channelId)}/tasks/${parentId}`),
    ctx(seed.channelId, parentId),
  );
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { ok: true });
  const gone = await routes.task.GET(
    req(member.id, "GET", `${base(seed.channelId)}/tasks/${parentId}`),
    ctx(seed.channelId, parentId),
  );
  assert.equal(gone.status, 404);

  // Every change requested an immediate poll: PATCH×2, comment, link×2, dispatch, delete.
  assert.equal(polled.length, 7);
  assert.ok(polled.every((id) => id === seed.channelId));
});

test("dispatch — a max query is carried into the plugin call; without arguments it is not", async () => {
  server.reset();
  const routes = await loadRoutes();
  const seed = await seedKanbanChannel();
  const member = await seedUser("member");
  await addMember(seed.channelId, member.id);

  const before = server.requests().length;
  const withMax = await routes.dispatch.POST(
    req(member.id, "POST", `${base(seed.channelId)}/dispatch?max=3`),
    ctx(seed.channelId),
  );
  assert.equal(withMax.status, 200);
  const maxCalls = dispatchCalls(before);
  assert.equal(maxCalls.length, 1);
  assert.match(maxCalls[0].path, /[?&]max=3(&|$)/);

  const before2 = server.requests().length;
  const noMax = await routes.dispatch.POST(
    req(member.id, "POST", `${base(seed.channelId)}/dispatch`),
    ctx(seed.channelId),
  );
  assert.equal(noMax.status, 200);
  const noMaxCalls = dispatchCalls(before2);
  assert.equal(noMaxCalls.length, 1);
  assert.doesNotMatch(noMaxCalls[0].path, /[?&]max=/);

  // Negative and non-integer values are ignored — called without max.
  const before3 = server.requests().length;
  const badMax = await routes.dispatch.POST(
    req(member.id, "POST", `${base(seed.channelId)}/dispatch?max=-1`),
    ctx(seed.channelId),
  );
  assert.equal(badMax.status, 200);
  const badMaxCalls = dispatchCalls(before3);
  assert.equal(badMaxCalls.length, 1);
  assert.doesNotMatch(badMaxCalls[0].path, /[?&]max=/);
});

test("card actions — approve/request-changes/unblock/reassign/reclaim/terminate/archive/specify", async () => {
  server.reset();
  const routes = await loadRoutes();
  const seed = await seedKanbanChannel({ extraProfiles: ["noah"] });
  const member = await seedUser("member");
  await addMember(seed.channelId, member.id);
  const created = await createTask(routes, member.id, seed.channelId, { assignee: seed.npcId });
  const taskId = created.body.task.id as string;
  const url = (action: string) => `${base(seed.channelId)}/tasks/${taskId}/${action}`;

  // reassign — {npcId} → {profile, reclaim_first:true}; sleeping/other-channel NPCs are 400.
  const before = server.requests().length;
  const reassigned = await routes.reassign.POST(
    req(member.id, "POST", url("reassign"), { npcId: seed.extras[0].npcId }),
    ctx(seed.channelId, taskId),
  );
  assert.equal(reassigned.status, 200, JSON.stringify(await reassigned.clone().json()));
  assert.equal((await reassigned.json()).task.assignee, "noah");
  const sent = server
    .requests()
    .slice(before)
    .find((r) => r.path.startsWith(`/deskrpg/kanban/tasks/${taskId}/reassign`));
  assert.ok(sent);
  assert.deepEqual(sent.json, { profile: "noah", reclaim_first: true });
  assert.equal(dispatchCalls(before).length, 1);

  const other = await seedKanbanChannel();
  const badReassign = await routes.reassign.POST(
    req(member.id, "POST", url("reassign"), { npcId: other.npcId }),
    ctx(seed.channelId, taskId),
  );
  assert.equal(badReassign.status, 400);
  assert.equal((await badReassign.json()).code, "assignee_not_in_channel");

  // request-changes requires comment.
  const noComment = await routes.requestChanges.POST(
    req(member.id, "POST", url("request-changes"), {}),
    ctx(seed.channelId, taskId),
  );
  assert.equal(noComment.status, 400);
  assert.equal((await noComment.json()).code, "invalid_body");
  const changes = await routes.requestChanges.POST(
    req(member.id, "POST", url("request-changes"), { comment: "다시" }),
    ctx(seed.channelId, taskId),
  );
  assert.equal(changes.status, 200);

  const unblocked = await routes.unblock.POST(
    req(member.id, "POST", url("unblock"), { comment: "풀었다" }),
    ctx(seed.channelId, taskId),
  );
  assert.equal(unblocked.status, 200);
  assert.equal((await unblocked.json()).task.status, "ready");

  const reclaimed = await routes.reclaim.POST(
    req(member.id, "POST", url("reclaim"), {}),
    ctx(seed.channelId, taskId),
  );
  assert.equal(reclaimed.status, 200);

  const terminated = await routes.terminate.POST(
    req(member.id, "POST", url("terminate"), {}),
    ctx(seed.channelId, taskId),
  );
  assert.equal(terminated.status, 200);
  assert.equal((await terminated.json()).task.status, "blocked");

  const specified = await routes.specify.POST(
    req(member.id, "POST", url("specify"), {}),
    ctx(seed.channelId, taskId),
  );
  assert.equal(specified.status, 200);

  const approved = await routes.approve.POST(
    req(member.id, "POST", url("approve"), {}),
    ctx(seed.channelId, taskId),
  );
  assert.equal(approved.status, 200);
  assert.equal((await approved.json()).task.status, "done");

  const archived = await routes.archive.POST(
    req(member.id, "POST", url("archive"), {}),
    ctx(seed.channelId, taskId),
  );
  assert.equal(archived.status, 200);
  assert.equal((await archived.json()).task.status, "archived");

  // Non-members cannot perform any action.
  const stranger = await seedUser("stranger");
  const denied = await routes.approve.POST(
    req(stranger.id, "POST", url("approve"), {}),
    ctx(seed.channelId, taskId),
  );
  assert.equal(denied.status, 403);
});

test("attachments — list, upload, read, delete; 404 attachments_unsupported when the plugin does not support them", async () => {
  server.reset();
  const routes = await loadRoutes();
  const seed = await seedKanbanChannel();
  const created = await createTask(routes, seed.ownerId, seed.channelId);
  const taskId = created.body.task.id as string;

  const form = new FormData();
  form.append("file", new Blob(["hello"]), "hello.txt");
  const uploaded = await routes.taskAttachments.POST(
    new NextRequest(`${base(seed.channelId)}/tasks/${taskId}/attachments`, {
      method: "POST",
      headers: { "x-user-id": seed.ownerId },
      body: form,
    }),
    ctx(seed.channelId, taskId),
  );
  assert.equal(uploaded.status, 201, JSON.stringify(await uploaded.clone().json()));
  const attachment = (await uploaded.json()).attachment;
  assert.equal(attachment.filename, "hello.txt");
  assert.equal(attachment.size, 5);

  const listed = await routes.taskAttachments.GET(
    req(seed.ownerId, "GET", `${base(seed.channelId)}/tasks/${taskId}/attachments`),
    ctx(seed.channelId, taskId),
  );
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).attachments.length, 1);

  const fetched = await routes.attachment.GET(
    req(seed.ownerId, "GET", `${base(seed.channelId)}/attachments/${attachment.id}`),
    ctx(seed.channelId, "", attachment.id),
  );
  assert.equal(fetched.status, 200);
  assert.equal(await fetched.text(), "hello");
  assert.match(fetched.headers.get("content-disposition") ?? "", /attachment/);
  assert.equal(fetched.headers.get("content-security-policy"), "sandbox");
  assert.equal(fetched.headers.get("x-content-type-options"), "nosniff");

  const removed = await routes.attachment.DELETE(
    req(seed.ownerId, "DELETE", `${base(seed.channelId)}/attachments/${attachment.id}`),
    ctx(seed.channelId, "", attachment.id),
  );
  assert.equal(removed.status, 200);

  // When the plugin says it does not support attachments — refresh the cache so the route sees it.
  server.setInfo({ kanban: { dispatcher_present: true, attachments: false } });
  try {
    const { db, gatewayResources } = await import("@/db");
    const { eq } = await import("drizzle-orm");
    await db
      .update(gatewayResources)
      .set({ pluginCheckedAt: null, pluginInfoJson: null })
      .where(eq(gatewayResources.id, seed.gatewayId));
    const before = server.requests().length;
    const unsupported = await routes.taskAttachments.GET(
      req(seed.ownerId, "GET", `${base(seed.channelId)}/tasks/${taskId}/attachments`),
      ctx(seed.channelId, taskId),
    );
    assert.equal(unsupported.status, 404);
    assert.equal((await unsupported.json()).code, "attachments_unsupported");
    assert.equal(
      server
        .requests()
        .slice(before)
        .filter((r) => r.path.includes("/attachments")).length,
      0,
      "지원하지 않으면 Hermes 첨부 경로를 부르지 않는다",
    );
  } finally {
    server.setInfo({ kanban: { dispatcher_present: true, attachments: true } });
  }
});

test("attachments — even HTML uploads always download as attachment with CSP sandbox and nosniff enforced", async () => {
  server.reset();
  const routes = await loadRoutes();
  const seed = await seedKanbanChannel();
  const created = await createTask(routes, seed.ownerId, seed.channelId);
  const taskId = created.body.task.id as string;

  const form = new FormData();
  form.append("file", new Blob(["<script>alert(1)</script>"]), "a.html");
  const uploaded = await routes.taskAttachments.POST(
    new NextRequest(`${base(seed.channelId)}/tasks/${taskId}/attachments`, {
      method: "POST",
      headers: { "x-user-id": seed.ownerId },
      body: form,
    }),
    ctx(seed.channelId, taskId),
  );
  assert.equal(uploaded.status, 201, JSON.stringify(await uploaded.clone().json()));
  const attachment = (await uploaded.json()).attachment;

  const fetched = await routes.attachment.GET(
    req(seed.ownerId, "GET", `${base(seed.channelId)}/attachments/${attachment.id}`),
    ctx(seed.channelId, "", attachment.id),
  );
  assert.equal(fetched.status, 200);
  assert.match(fetched.headers.get("content-disposition") ?? "", /^attachment/);
  assert.equal(fetched.headers.get("content-security-policy"), "sandbox");
  assert.equal(fetched.headers.get("x-content-type-options"), "nosniff");
});

test("settings — members get orchestration:null, the channel owner edits the board folder, the gateway owner edits operation settings", async () => {
  server.reset();
  const routes = await loadRoutes();
  const gatewayOwner = await seedUser("gateway-owner");
  const seed = await seedKanbanChannel({ gatewayOwnerId: gatewayOwner.id });
  await addMember(seed.channelId, gatewayOwner.id);
  const member = await seedUser("member");
  await addMember(seed.channelId, member.id);

  // Member: sees the board with editable=false, orchestration is null.
  const asMember = await routes.settings.GET(
    req(member.id, "GET", `${base(seed.channelId)}/settings`),
    ctx(seed.channelId),
  );
  assert.equal(asMember.status, 200, JSON.stringify(await asMember.clone().json()));
  const memberBody = await asMember.json();
  assert.equal(memberBody.board.slug, seed.boardSlug);
  assert.equal(memberBody.board.name, "칸반 채널");
  assert.equal(memberBody.board.editable, false);
  assert.equal(memberBody.orchestration, null);
  assert.deepEqual(memberBody.hints, { default_assignee_recommend_empty: true });

  // Channel owner: board editable; orchestration visible but editable=false (not the gateway owner).
  const asOwner = await routes.settings.GET(
    req(seed.ownerId, "GET", `${base(seed.channelId)}/settings`),
    ctx(seed.channelId),
  );
  const ownerBody = await asOwner.json();
  assert.equal(ownerBody.board.editable, true);
  assert.equal(ownerBody.orchestration.editable, false);
  assert.equal(typeof ownerBody.orchestration.auto_decompose, "boolean");

  // A member editing the board folder gets 403 settings_forbidden — before calling Hermes.
  const before = server.requests().length;
  const memberPatch = await routes.settings.PATCH(
    req(member.id, "PATCH", `${base(seed.channelId)}/settings`, {
      board: { default_workdir: "/tmp/x" },
    }),
    ctx(seed.channelId),
  );
  assert.equal(memberPatch.status, 403);
  assert.equal((await memberPatch.json()).code, "settings_forbidden");
  assert.equal(
    server
      .requests()
      .slice(before)
      .filter((r) => r.method === "PATCH" || r.method === "PUT").length,
    0,
  );

  // A channel owner editing operation settings gets 403 (not the gateway owner).
  const ownerPatchOrch = await routes.settings.PATCH(
    req(seed.ownerId, "PATCH", `${base(seed.channelId)}/settings`, {
      orchestration: { auto_decompose: true },
    }),
    ctx(seed.channelId),
  );
  assert.equal(ownerPatchOrch.status, 403);
  assert.equal((await ownerPatchOrch.json()).code, "settings_forbidden");

  // The channel owner can change the board folder.
  const ownerPatch = await routes.settings.PATCH(
    req(seed.ownerId, "PATCH", `${base(seed.channelId)}/settings`, {
      board: { default_workdir: "/srv/work" },
    }),
    ctx(seed.channelId),
  );
  assert.equal(ownerPatch.status, 200, JSON.stringify(await ownerPatch.clone().json()));
  assert.equal((await ownerPatch.json()).board.default_workdir, "/srv/work");

  // The gateway owner (a member) can edit operation settings.
  const gwPatch = await routes.settings.PATCH(
    req(gatewayOwner.id, "PATCH", `${base(seed.channelId)}/settings`, {
      orchestration: { auto_decompose: true, max_in_progress: 3 },
    }),
    ctx(seed.channelId),
  );
  assert.equal(gwPatch.status, 200, JSON.stringify(await gwPatch.clone().json()));
  const gwBody = await gwPatch.json();
  assert.equal(gwBody.orchestration.auto_decompose, true);
  assert.equal(gwBody.orchestration.max_in_progress, 3);
  assert.equal(gwBody.orchestration.editable, true);

  // Non-members cannot even see the settings.
  const stranger = await seedUser("stranger");
  const denied = await routes.settings.GET(
    req(stranger.id, "GET", `${base(seed.channelId)}/settings`),
    ctx(seed.channelId),
  );
  assert.equal(denied.status, 403);
});

test("automation status — a summary of plugin, board, polling and in-progress work for members", async () => {
  server.reset();
  const routes = await loadRoutes();
  const seed = await seedKanbanChannel();
  const member = await seedUser("member");
  await addMember(seed.channelId, member.id);

  const res = await routes.status.GET(
    req(member.id, "GET", `http://localhost/api/channels/${seed.channelId}/automation/status`),
    ctx(seed.channelId),
  );
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const body = await res.json();
  assert.equal(body.pluginStatus, "plugin_ready");
  assert.equal(body.pluginVersion, "0.6.0");
  assert.deepEqual(body.capabilities, [
    "kanban",
    "cron",
    "events",
    "swarm",
    "kanban_views",
    "kanban_task_events",
    "initial_status",
    "kanban_review_policy_v1",
    "event_cursor_handoff",
    "card_proposals",
  ]);
  assert.equal(body.timezone, "Asia/Seoul");
  assert.equal(body.boardSlug, seed.boardSlug);
  assert.equal(body.dispatcherPresent, true);
  assert.equal(body.attachments, true);
  assert.equal(body.minVersion, "0.6.0");
  assert.ok("lastPolledAt" in body);
  assert.equal(body.lastError, null);
  assert.deepEqual(body.working, []);

  const stranger = await seedUser("stranger");
  const denied = await routes.status.GET(
    req(stranger.id, "GET", `http://localhost/api/channels/${seed.channelId}/automation/status`),
    ctx(seed.channelId),
  );
  assert.equal(denied.status, 403);

  // An unbound channel is 409.
  const owner = await seedUser("unbound-owner");
  const channel = await seedChannel(owner.id);
  const unbound = await routes.status.GET(
    req(owner.id, "GET", `http://localhost/api/channels/${channel.id}/automation/status`),
    ctx(channel.id),
  );
  assert.equal(unbound.status, 409);
  assert.equal((await unbound.json()).code, "gateway_not_bound");
});

test("cron changes also request an immediate poll", async () => {
  server.reset();
  const routes = await import("./[id]/cron/jobs/route");
  const jobRoute = await import("./[id]/cron/jobs/[jobId]/route");
  const seed = await seedKanbanChannel();
  const created = await routes.POST(
    req(seed.ownerId, "POST", `http://localhost/api/channels/${seed.channelId}/cron/jobs`, {
      npcId: seed.npcId,
      name: "아침",
      prompt: "요약",
      schedule: "daily at 09:00",
    }),
    { params: Promise.resolve({ id: seed.channelId }) },
  );
  assert.equal(created.status, 201);
  const jobId = (await created.json()).job.id;
  const deleted = await jobRoute.DELETE(
    req(
      seed.ownerId,
      "DELETE",
      `http://localhost/api/channels/${seed.channelId}/cron/jobs/${jobId}?npcId=${seed.npcId}`,
    ),
    { params: Promise.resolve({ id: seed.channelId, jobId }) },
  );
  assert.equal(deleted.status, 200);
  assert.deepEqual(polled, [seed.channelId, seed.channelId]);
});

test("attachments — ids like '.', '..', 'a/b' are 404 attachment_not_found before the plugin is called", async () => {
  server.reset();
  const routes = await loadRoutes();
  const seed = await seedKanbanChannel();
  for (const bad of [".", "..", "a/b", "", "x".repeat(129)]) {
    const before = server.requests().length;
    const got = await routes.attachment.GET(
      req(seed.ownerId, "GET", `${base(seed.channelId)}/attachments/x`),
      ctx(seed.channelId, "", bad),
    );
    const removed = await routes.attachment.DELETE(
      req(seed.ownerId, "DELETE", `${base(seed.channelId)}/attachments/x`),
      ctx(seed.channelId, "", bad),
    );
    for (const res of [got, removed]) {
      assert.equal(res.status, 404, `id ${JSON.stringify(bad)}`);
      assert.equal((await res.json()).code, "attachment_not_found");
    }
    assert.equal(
      server
        .requests()
        .slice(before)
        .filter((r) => r.path.includes("/kanban/")).length,
      0,
      `id ${JSON.stringify(bad)} 로 칸반 경로를 부르지 않는다`,
    );
  }
});

// ---------------------------------------------------------------------------
// `?board=` — a channel has several boards (design 2026-09-21 project-registry)
//
// The board response carries no slug, so "which board did we see" is told apart **by that board's cards**.
// ---------------------------------------------------------------------------

/** Attach one more board to this channel and return its slug. The event-receiving board stays the first board. */
async function addSecondBoard(channelId: string): Promise<string> {
  const { ensureChannelBoard, newChannelBoardSlug } = await import("@/lib/kanban-boards");
  const slug = newChannelBoardSlug(channelId);
  const ensured = await ensureChannelBoard(channelId, undefined, slug);
  assert.ok(ensured.ok, `둘째 보드 확보 실패: ${ensured.ok ? "" : ensured.code}`);
  return slug;
}

/** Card titles visible on that board. Without `board`, looks at the default (event-receiving) board. */
async function boardTitles(
  routes: Routes,
  userId: string,
  channelId: string,
  board?: string,
): Promise<string[]> {
  const url = `${base(channelId)}/board${board ? `?board=${board}` : ""}`;
  const res = await routes.board.GET(req(userId, "GET", url), ctx(channelId));
  assert.equal(res.status, 200, await res.clone().text());
  const body = (await res.json()) as { columns: { tasks: { title: string }[] }[] };
  return body.columns.flatMap((c) => c.tasks.map((t) => t.title)).sort();
}

async function createOn(
  routes: Routes,
  userId: string,
  channelId: string,
  title: string,
  board?: string,
) {
  const url = `${base(channelId)}/tasks${board ? `?board=${board}` : ""}`;
  return routes.tasks.POST(req(userId, "POST", url, { title }), ctx(channelId));
}

test("calling without ?board= uses the event-receiving board — old clients keep their meaning", async () => {
  const routes = await loadRoutes();
  const seed = await seedKanbanChannel();
  const second = await addSecondBoard(seed.channelId);

  assert.equal((await createOn(routes, seed.ownerId, seed.channelId, "첫 보드 카드")).status, 201);
  assert.equal(
    (await createOn(routes, seed.ownerId, seed.channelId, "둘째 보드 카드", second)).status,
    201,
  );

  assert.deepEqual(await boardTitles(routes, seed.ownerId, seed.channelId), ["첫 보드 카드"]);
});

test("cards of two boards do not mix", async () => {
  const routes = await loadRoutes();
  const seed = await seedKanbanChannel();
  const second = await addSecondBoard(seed.channelId);

  await createOn(routes, seed.ownerId, seed.channelId, "첫 보드 카드");
  await createOn(routes, seed.ownerId, seed.channelId, "둘째 보드 카드", second);

  assert.deepEqual(await boardTitles(routes, seed.ownerId, seed.channelId), ["첫 보드 카드"]);
  assert.deepEqual(await boardTitles(routes, seed.ownerId, seed.channelId, second), [
    "둘째 보드 카드",
  ]);
});

test("another channel's board is 404 even when the slug is known", async () => {
  const routes = await loadRoutes();
  const mine = await seedKanbanChannel();
  const theirs = await seedKanbanChannel();

  const res = await routes.board.GET(
    req(mine.ownerId, "GET", `${base(mine.channelId)}/board?board=${theirs.boardSlug}`),
    ctx(mine.channelId),
  );
  assert.equal(res.status, 404, "남의 보드가 열렸습니다");
  assert.equal(((await res.json()) as { code?: string }).code, "board_not_bound");
});

test("trying to create a card on someone else's board is 404 and no card is created", async () => {
  const routes = await loadRoutes();
  const mine = await seedKanbanChannel();
  const theirs = await seedKanbanChannel();

  const res = await createOn(
    routes,
    mine.ownerId,
    mine.channelId,
    "남의 보드에 쓰기",
    theirs.boardSlug,
  );
  assert.equal(res.status, 404);
  assert.deepEqual(
    await boardTitles(routes, theirs.ownerId, theirs.channelId),
    [],
    "남의 보드에 카드가 들어갔습니다",
  );
});

test("a malformed board value is 400 and Hermes is not called", async () => {
  const routes = await loadRoutes();
  const seed = await seedKanbanChannel();
  const res = await routes.board.GET(
    req(seed.ownerId, "GET", `${base(seed.channelId)}/board?board=${encodeURIComponent("../etc")}`),
    ctx(seed.channelId),
  );
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { code?: string }).code, "invalid_board");
});

test("an empty board value is the same as not specifying one", async () => {
  const routes = await loadRoutes();
  const seed = await seedKanbanChannel();
  await createOn(routes, seed.ownerId, seed.channelId, "기본 카드");
  const res = await routes.board.GET(
    req(seed.ownerId, "GET", `${base(seed.channelId)}/board?board=`),
    ctx(seed.channelId),
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { columns: { tasks: { title: string }[] }[] };
  assert.deepEqual(
    body.columns.flatMap((c) => c.tasks.map((t) => t.title)),
    ["기본 카드"],
  );
});

test("even with several boards in a channel there is only one event-receiving board", async () => {
  const seed = await seedKanbanChannel();
  await addSecondBoard(seed.channelId);
  await addSecondBoard(seed.channelId);

  const { listChannelBoards } = await import("@/lib/kanban-boards");
  const rows = await listChannelBoards(seed.channelId);
  assert.equal(rows.length, 3);
  assert.equal(
    rows.filter((r) => r.isEventCarrier).length,
    1,
    "사건 수신 보드가 하나가 아니면 크론 사건이 중복 소비됩니다",
  );
  assert.equal(rows.find((r) => r.isEventCarrier)?.boardSlug, seed.boardSlug);
});

// ---------------------------------------------------------------------------
// Bulk reads (capability kanban_views) — used by the list tree and the activity timeline
// ---------------------------------------------------------------------------

test("GET /kanban/links returns parent/child pairs across the whole board", async () => {
  server.reset();
  const routes = await loadRoutes();
  const seed = await seedKanbanChannel();
  const parent = await createTask(routes, seed.ownerId, seed.channelId, { title: "부모" });
  const child = await createTask(routes, seed.ownerId, seed.channelId, { title: "자식" });
  const linked = await routes.links.POST(
    req(seed.ownerId, "POST", `${base(seed.channelId)}/links`, {
      parent_id: parent.body.task.id,
      child_id: child.body.task.id,
    }),
    ctx(seed.channelId),
  );
  assert.equal(linked.status, 200, JSON.stringify(await linked.clone().json()));

  const res = await routes.links.GET(
    req(seed.ownerId, "GET", `${base(seed.channelId)}/links`),
    ctx(seed.channelId),
  );
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const body = await res.json();
  assert.deepEqual(
    body.links.map((l: { parent_id: string; child_id: string }) => [l.parent_id, l.child_id]),
    [[parent.body.task.id, child.body.task.id]],
  );
});

test("GET /kanban/runs returns the window together with whether it was truncated", async () => {
  server.reset();
  const routes = await loadRoutes();
  const seed = await seedKanbanChannel();

  const res = await routes.runs.GET(
    req(seed.ownerId, "GET", `${base(seed.channelId)}/runs?from=0&to=9999`),
    ctx(seed.channelId),
  );
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const body = await res.json();
  assert.deepEqual(body.window, { from: 0, to: 9999 });
  // The screen must know whether it was truncated — drawing a truncated window as is reads as "nobody worked".
  assert.equal(body.truncated, false);
  assert.ok(Array.isArray(body.runs));
});

test("invalid GET /kanban/runs queries pass the plugin's verdict through", async () => {
  // Validating once more in the REST layer would let the rules in two places drift apart.
  server.reset();
  const routes = await loadRoutes();
  const seed = await seedKanbanChannel();

  const res = await routes.runs.GET(
    req(seed.ownerId, "GET", `${base(seed.channelId)}/runs?from=2000&to=1000`),
    ctx(seed.channelId),
  );
  assert.equal(res.status, 400);
});

test("GET /kanban/events returns status transitions in the window with where each card came from", async () => {
  server.reset();
  const routes = await loadRoutes();
  const seed = await seedKanbanChannel();
  const created = await createTask(routes, seed.ownerId, seed.channelId);
  const taskId = created.body.task.id;
  for (const status of ["review", "todo"]) {
    const patched = await routes.task.PATCH(
      req(seed.ownerId, "PATCH", `${base(seed.channelId)}/tasks/${taskId}`, { status }),
      ctx(seed.channelId, taskId),
    );
    assert.equal(patched.status, 200, JSON.stringify(await patched.clone().json()));
  }

  const res = await routes.events.GET(
    req(seed.ownerId, "GET", `${base(seed.channelId)}/events?from=0&to=9999999999`),
    ctx(seed.channelId),
  );
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const body = await res.json();
  assert.deepEqual(body.window, { from: 0, to: 9999999999 });
  assert.equal(body.truncated, false);
  const mine = body.events
    .filter((e: { task_id: string }) => e.task_id === taskId)
    .map((e: { from: string | null; to: string }) => [e.from, e.to]);
  assert.deepEqual(mine.slice(-2), [
    [created.body.task.status, "review"],
    ["review", "todo"],
  ]);
});

test("invalid GET /kanban/events queries pass the plugin's verdict through", async () => {
  server.reset();
  const routes = await loadRoutes();
  const seed = await seedKanbanChannel();

  const res = await routes.events.GET(
    req(seed.ownerId, "GET", `${base(seed.channelId)}/events?from=2000&to=1000`),
    ctx(seed.channelId),
  );
  assert.equal(res.status, 400);
});

test("bulk reads are 403 for non-members too", async () => {
  server.reset();
  const routes = await loadRoutes();
  const seed = await seedKanbanChannel();
  const stranger = await seedUser("stranger-views");

  for (const call of [
    () =>
      routes.links.GET(
        req(stranger.id, "GET", `${base(seed.channelId)}/links`),
        ctx(seed.channelId),
      ),
    () =>
      routes.runs.GET(req(stranger.id, "GET", `${base(seed.channelId)}/runs`), ctx(seed.channelId)),
    () =>
      routes.events.GET(
        req(stranger.id, "GET", `${base(seed.channelId)}/events`),
        ctx(seed.channelId),
      ),
  ]) {
    assert.equal((await call()).status, 403);
  }
});

// ---------------------------------------------------------------------------
// Resolving card proposals (T7)
// ---------------------------------------------------------------------------

/** Plant one proposal notice in the channel's office room and register the same proposal with the plugin. */
async function seedProposal(
  seed: { channelId: string; ownerId: string; npcId: string },
  proposalId = "cp_1",
  overrides: Record<string, unknown> = {},
) {
  const { ensureOfficeRoom } = await import("@/lib/chat-rooms");
  const { db, chatRoomMessages } = await import("@/db");
  const room = await ensureOfficeRoom(seed.channelId, seed.ownerId);
  const notice = {
    kind: "card_proposal",
    proposalId,
    title: "청구서 정리",
    summary: "세 단계짜리 일입니다",
    body: "본문",
    acceptance: "표로 정리",
    npcId: seed.npcId,
    npcName: "소피",
    ...overrides,
  };
  const [row] = await db
    .insert(chatRoomMessages)
    .values({
      roomId: room.id,
      senderKind: "npc",
      senderName: "소피",
      content: "청구서 정리",
      noticeJson: JSON.stringify(notice),
    })
    .returning();
  server.seedCardProposal(proposalId);
  return { messageId: row.id, roomId: room.id, proposalId };
}

async function readNotice(messageId: string) {
  const { db, chatRoomMessages } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  const [row] = await db
    .select({ noticeJson: chatRoomMessages.noticeJson })
    .from(chatRoomMessages)
    .where(eq(chatRoomMessages.id, messageId))
    .limit(1);
  const { parseRoomNotice } = await import("@/lib/chat-rooms-policy");
  return parseRoomNotice(row.noticeJson);
}

function proposalCtx(id: string, proposalId: string) {
  return { params: Promise.resolve({ id, proposalId }) };
}

function resolveReq(userId: string, channelId: string, proposalId: string, body: unknown) {
  return req(
    userId,
    "POST",
    `${base(channelId)}/proposals/${encodeURIComponent(proposalId)}/resolve`,
    body,
  );
}

test("resolving a proposal — non-member 403, no login 401, invalid choice 400", async () => {
  server.reset();
  const route = await import("./[id]/kanban/proposals/[proposalId]/resolve/route");
  const seed = await seedKanbanChannel();
  const proposal = await seedProposal(seed);
  const stranger = await seedUser("proposal-stranger");

  const forbidden = await route.POST(
    resolveReq(stranger.id, seed.channelId, proposal.proposalId, { choice: "card" }),
    proposalCtx(seed.channelId, proposal.proposalId),
  );
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).code, "not_a_member");

  const anonymous = await route.POST(
    new NextRequest(`${base(seed.channelId)}/proposals/${proposal.proposalId}/resolve`, {
      method: "POST",
      body: JSON.stringify({ choice: "card" }),
    }),
    proposalCtx(seed.channelId, proposal.proposalId),
  );
  assert.equal(anonymous.status, 401);

  const bad = await route.POST(
    resolveReq(seed.ownerId, seed.channelId, proposal.proposalId, { choice: "무엇" }),
    proposalCtx(seed.channelId, proposal.proposalId),
  );
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, "invalid_field");

  // No branch touched the plugin's proposal.
  assert.equal(server.cardProposal(proposal.proposalId)?.resolvedChoice, null);
  const untouched = await readNotice(proposal.messageId);
  assert.equal(untouched?.kind === "card_proposal" ? untouched.resolved : "gone", undefined);
});

// A proposal can outlive the plugin that raised it (a downgrade or a swapped gateway). Resolving
// it then must say "upgrade the plugin", not pass the old plugin's bare route 404 through.
test("resolving a proposal — a plugin without card_proposals answers 428 plugin_upgrade_required", async () => {
  server.reset();
  server.setInfo({ capabilities: ["kanban", "cron", "events", "kanban_review_policy_v1"] });
  const route = await import("./[id]/kanban/proposals/[proposalId]/resolve/route");
  const seed = await seedKanbanChannel();
  const proposal = await seedProposal(seed);

  for (const choice of ["card", "inline"]) {
    const res = await route.POST(
      resolveReq(seed.ownerId, seed.channelId, proposal.proposalId, { choice }),
      proposalCtx(seed.channelId, proposal.proposalId),
    );
    assert.equal(res.status, 428, choice);
    const body = await res.json();
    assert.equal(body.code, "plugin_upgrade_required");
    assert.equal(body.minVersion, "0.11.0");
    assert.deepEqual(body.missing, ["card_proposals"]);
  }
  assert.equal(server.cardProposal(proposal.proposalId)?.resolvedChoice, null);
  const untouched = await readNotice(proposal.messageId);
  assert.equal(untouched?.kind === "card_proposal" ? untouched.resolved : "gone", undefined);
});

test("resolving a proposal — the card branch creates the card and writes the decision into the notice; a second call is 409", async () => {
  server.reset();
  const route = await import("./[id]/kanban/proposals/[proposalId]/resolve/route");
  const seed = await seedKanbanChannel();
  const member = await seedUser("proposal-member");
  await addMember(seed.channelId, member.id);
  const proposal = await seedProposal(seed);

  const before = server.requests().length;
  const ok = await route.POST(
    resolveReq(member.id, seed.channelId, proposal.proposalId, { choice: "card" }),
    proposalCtx(seed.channelId, proposal.proposalId),
  );
  assert.equal(ok.status, 200, JSON.stringify(await ok.clone().json()));
  const body = await ok.json();
  assert.equal(body.choice, "card");
  assert.equal(body.assigneeDropped, false);
  assert.ok(body.taskId);

  // The card was created with its assignee (profile_name), and the completion criteria went into the body.
  const created = server
    .requests()
    .slice(before)
    .find((r) => r.method === "POST" && r.path.startsWith("/deskrpg/kanban/tasks"));
  const sent = created?.json as Record<string, unknown>;
  assert.equal(sent.title, "청구서 정리");
  assert.equal(sent.assignee, "sophie");
  assert.match(String(sent.body), /본문[\s\S]*표로 정리/);

  // The decision stays in the notice → the basis for the buttons disappearing on screen.
  const notice = await readNotice(proposal.messageId);
  assert.equal(notice?.kind, "card_proposal");
  assert.deepEqual(
    notice?.kind === "card_proposal" && notice.resolved
      ? { choice: notice.resolved.choice, by: notice.resolved.by, taskId: notice.resolved.taskId }
      : null,
    { choice: "card", by: member.id, taskId: body.taskId },
  );

  // One dispatch + immediate poll.
  assert.equal(dispatchCalls(before).length, 1);
  assert.deepEqual(polled, [seed.channelId]);

  // A second resolve is 409 — there is only one card.
  const again = await route.POST(
    resolveReq(member.id, seed.channelId, proposal.proposalId, { choice: "card" }),
    proposalCtx(seed.channelId, proposal.proposalId),
  );
  assert.equal(again.status, 409);
  assert.equal((await again.json()).code, "already_resolved");
  const tasks = server
    .requests()
    .slice(before)
    .filter((r) => r.method === "POST" && r.path.startsWith("/deskrpg/kanban/tasks"));
  assert.equal(tasks.length, 1);
});

test("resolving a proposal — the inline branch creates no card", async () => {
  server.reset();
  const route = await import("./[id]/kanban/proposals/[proposalId]/resolve/route");
  const seed = await seedKanbanChannel();
  const proposal = await seedProposal(seed, "cp_inline");

  const before = server.requests().length;
  const res = await route.POST(
    resolveReq(seed.ownerId, seed.channelId, proposal.proposalId, { choice: "inline" }),
    proposalCtx(seed.channelId, proposal.proposalId),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { choice: "inline" });
  assert.equal(
    server
      .requests()
      .slice(before)
      .filter((r) => r.method === "POST" && r.path.startsWith("/deskrpg/kanban/tasks")).length,
    0,
  );
  const notice = await readNotice(proposal.messageId);
  assert.equal(notice?.kind === "card_proposal" ? notice.resolved?.choice : null, "inline");
});

test("resolving a proposal — a missing proposal is 404 and the plugin is not called", async () => {
  server.reset();
  const route = await import("./[id]/kanban/proposals/[proposalId]/resolve/route");
  const seed = await seedKanbanChannel();
  const before = server.requests().length;
  const res = await route.POST(
    resolveReq(seed.ownerId, seed.channelId, "cp_missing", { choice: "card" }),
    proposalCtx(seed.channelId, "cp_missing"),
  );
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, "card_proposal_not_found");
  assert.equal(
    server
      .requests()
      .slice(before)
      .filter((r) => r.path.startsWith("/deskrpg/card-proposals")).length,
    0,
  );
});

test("resolving a proposal — if the proposing employee has clocked out, the card is created without an assignee and that is reported", async () => {
  server.reset();
  const route = await import("./[id]/kanban/proposals/[proposalId]/resolve/route");
  const seed = await seedKanbanChannel();
  const proposal = await seedProposal(seed, "cp_dropped");
  const { setNpcActive } = await import("@/lib/npc-roster");
  await setNpcActive(seed.npcId, false);

  const before = server.requests().length;
  const res = await route.POST(
    resolveReq(seed.ownerId, seed.channelId, proposal.proposalId, { choice: "card" }),
    proposalCtx(seed.channelId, proposal.proposalId),
  );
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.equal((await res.json()).assigneeDropped, true);
  const created = server
    .requests()
    .slice(before)
    .find((r) => r.method === "POST" && r.path.startsWith("/deskrpg/kanban/tasks"));
  assert.equal((created?.json as Record<string, unknown>).assignee, undefined);
});

// ---------------------------------------------------------------------------
// Board-wide attachments — the artifact gallery continues after artifacts with these.
//
// Files a worker made are deleted along with scratch when the card ends, leaving only attachments. If the gallery
// does not know this list, finished cards' outputs show up nowhere.
// ---------------------------------------------------------------------------

async function withBoardAttachmentList<T>(
  seed: { gatewayId: string },
  enabled: boolean,
  run: () => Promise<T>,
): Promise<T> {
  const caps = ["kanban", "cron", "events", "swarm", "kanban_views", "initial_status"];
  server.setInfo({ capabilities: enabled ? [...caps, "kanban_attachment_list"] : caps });
  const { db, gatewayResources } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  // Clear the capability cache so the route sees the new capability.
  await db
    .update(gatewayResources)
    .set({ pluginCheckedAt: null, pluginInfoJson: null })
    .where(eq(gatewayResources.id, seed.gatewayId));
  try {
    return await run();
  } finally {
    server.setInfo({ capabilities: caps });
  }
}

test("board attachment list — with which card each belongs to, newest first", async () => {
  server.reset();
  const routes = await loadRoutes();
  const seed = await seedKanbanChannel();
  const created = await createTask(routes, seed.ownerId, seed.channelId);
  const taskId = created.body.task.id as string;
  const board = seed.boardSlug;
  server.seedAttachment({ board, taskId, filename: "first.md", body: "a" });
  server.seedAttachment({ board, taskId, filename: "second.md", body: "b" });

  await withBoardAttachmentList(seed, true, async () => {
    const res = await routes.boardAttachments.GET(
      req(seed.ownerId, "GET", `${base(seed.channelId)}/attachments`),
      ctx(seed.channelId),
    );
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    const body = await res.json();
    assert.equal(body.supported, true);
    assert.deepEqual(
      body.attachments.map((a: { filename: string }) => a.filename),
      ["second.md", "first.md"],
    );
    assert.equal(body.attachments[0].task_id, taskId);
    assert.equal(typeof body.attachments[0].task_title, "string", "어느 카드인지 모른다");
    assert.equal(body.next_cursor, null);
  });
});

test("board attachment list — a board without attachments is an empty list (distinct from unsupported)", async () => {
  server.reset();
  const routes = await loadRoutes();
  const seed = await seedKanbanChannel();
  await withBoardAttachmentList(seed, true, async () => {
    const res = await routes.boardAttachments.GET(
      req(seed.ownerId, "GET", `${base(seed.channelId)}/attachments`),
      ctx(seed.channelId),
    );
    const body = await res.json();
    assert.equal(body.supported, true);
    assert.deepEqual(body.attachments, []);
  });
});

test("board attachment list — two pages chained by a cursor do not overlap", async () => {
  server.reset();
  server.setInfo({ capabilities: ["kanban", "cron", "events", "kanban_review_policy_v1"] });
  const routes = await loadRoutes();
  const seed = await seedKanbanChannel();
  const created = await createTask(routes, seed.ownerId, seed.channelId);
  const taskId = created.body.task.id as string;
  const board = seed.boardSlug;
  for (const name of ["a.md", "b.md", "c.md"])
    server.seedAttachment({ board, taskId, filename: name, body: name });

  await withBoardAttachmentList(seed, true, async () => {
    const first = await (
      await routes.boardAttachments.GET(
        req(seed.ownerId, "GET", `${base(seed.channelId)}/attachments?limit=2`),
        ctx(seed.channelId),
      )
    ).json();
    assert.equal(first.attachments.length, 2);
    assert.ok(first.next_cursor, "다음 쪽이 있는데 커서가 없다");
    const second = await (
      await routes.boardAttachments.GET(
        req(
          seed.ownerId,
          "GET",
          `${base(seed.channelId)}/attachments?limit=2&cursor=${encodeURIComponent(first.next_cursor)}`,
        ),
        ctx(seed.channelId),
      )
    ).json();
    const names = [...first.attachments, ...second.attachments].map(
      (a: { filename: string }) => a.filename,
    );
    assert.deepEqual(names, ["c.md", "b.md", "a.md"], "쪽이 겹치거나 빠졌다");
    assert.equal(second.next_cursor, null);
  });
});

test("board attachment list — old plugins that do not know the list are not called and it answers supported:false", async () => {
  server.reset();
  const routes = await loadRoutes();
  const seed = await seedKanbanChannel();
  await withBoardAttachmentList(seed, false, async () => {
    const before = server.requests().length;
    const res = await routes.boardAttachments.GET(
      req(seed.ownerId, "GET", `${base(seed.channelId)}/attachments`),
      ctx(seed.channelId),
    );
    assert.equal(res.status, 200, "옛 플러그인이 오류가 되면 갤러리 전체가 깨진다");
    const body = await res.json();
    assert.equal(body.supported, false);
    assert.deepEqual(body.attachments, []);
    assert.equal(
      server
        .requests()
        .slice(before)
        .filter((r) => r.path === "/deskrpg/kanban/attachments").length,
      0,
      "없는 라우트를 부른다",
    );
  });
});

test("mixed approval: new cards default to the human policy and a null policy cannot bypass it", async () => {
  server.reset();
  server.setInfo({ capabilities: ["kanban", "cron", "events", "kanban_review_policy_v1"] });
  const routes = await loadRoutes();
  const seed = await seedKanbanChannel();
  const created = await createTask(routes, seed.ownerId, seed.channelId);
  assert.equal(created.status, 201);
  const sent = server
    .requests()
    .filter((r) => r.method === "POST" && r.path.startsWith("/deskrpg/kanban/tasks?"))
    .at(-1)!;
  assert.deepEqual((sent.json as Record<string, unknown>).review_policy, {
    version: 1,
    mode: "human",
    reviewer_profile: null,
  });
  const invalid = await createTask(routes, seed.ownerId, seed.channelId, { reviewPolicy: null });
  assert.equal(invalid.status, 400);
});

test("mixed approval: an unsupported core blocks writing new cards", async () => {
  server.reset();
  server.setInfo({ capabilities: ["kanban", "cron", "events"] });
  const routes = await loadRoutes();
  const seed = await seedKanbanChannel();
  const before = server.requests().length;
  const created = await createTask(routes, seed.ownerId, seed.channelId);
  assert.equal(created.status, 428);
  assert.equal(
    server
      .requests()
      .slice(before)
      .filter((r) => r.method === "POST" && r.path.startsWith("/deskrpg/kanban/tasks?")).length,
    0,
  );
});

test("mixed approval: only other active employees can be set as AI reviewers", async () => {
  server.reset();
  server.setInfo({ capabilities: ["kanban", "cron", "events", "kanban_review_policy_v1"] });
  const routes = await loadRoutes();
  const seed = await seedKanbanChannel({ extraProfiles: ["noah"] });
  const same = await createTask(routes, seed.ownerId, seed.channelId, {
    assignee: seed.npcId,
    reviewPolicy: { mode: "agent", reviewerNpcId: seed.npcId },
  });
  assert.equal(same.status, 400);
  const valid = await createTask(routes, seed.ownerId, seed.channelId, {
    assignee: seed.npcId,
    reviewPolicy: { mode: "agent", reviewerNpcId: seed.extras[0].npcId },
  });
  assert.equal(valid.status, 201);
  const sent = server
    .requests()
    .filter((r) => r.method === "POST" && r.path.startsWith("/deskrpg/kanban/tasks?"))
    .at(-1)!;
  assert.deepEqual((sent.json as Record<string, unknown>).review_policy, {
    version: 1,
    mode: "agent",
    reviewer_profile: "noah",
  });
});

test("mixed approval: the approving user and the submission come only from server auth and the stated snapshot", async () => {
  server.reset();
  server.setInfo({ capabilities: ["kanban", "cron", "events", "kanban_review_policy_v1"] });
  const routes = await loadRoutes();
  const seed = await seedKanbanChannel();
  const created = await createTask(routes, seed.ownerId, seed.channelId);
  const taskId = created.body.task.id;
  await routes.approve.POST(
    req(seed.ownerId, "POST", `${base(seed.channelId)}/tasks/${taskId}/approve`, {
      submission_id: "s-current",
      request_id: "attempt-1",
      actor_id: "spoof",
      actor_name: "forged-name",
    }),
    ctx(seed.channelId, taskId),
  );
  const sent = server
    .requests()
    .filter((r) => r.path.includes(`/${taskId}/approve`))
    .at(-1)!;
  assert.equal(sent.headers["x-deskrpg-user-id"], seed.ownerId);
  const { commentAuthorFor } = await import("@/lib/kanban-access");
  assert.equal(
    decodeURIComponent(sent.headers["x-deskrpg-user-name"]!),
    (await commentAuthorFor(seed.ownerId)).slice("deskrpg:".length),
  );
  assert.deepEqual(sent.json, { submission_id: "s-current", request_id: "attempt-1" });
});
