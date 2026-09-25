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

// T7. Cron REST and the origin ledger (cron_job_origins).
//
// Hermes is the source of truth and DeskRPG records only "who created it in which channel". What we pin
// here is the permission table (view = member, create = member, modify = origin channel members only) and the
// ledger lifecycle (recorded only after success, removed on delete, ignored when the gateway changes, cleaned up
// when the profile disappears). Route handlers are called directly and a fake server plays the plugin.
//
// Kept outside the `[id]` segment — the node test runner mistakes `[id]` for a character class and misses
// the *.test.ts inside it.
setupThrowawaySqlite("cron-routes-test");

// Must match the token the npc-seed seeds use so the fake server lets authentication through.
const OWNER_TOKEN = "gateway-owner-key-1234567890";
const PROFILE_TOKEN = "profile-key-1234567890";

let server: FakePluginServer;

before(async () => {
  server = await startFakePluginServer({
    ownerToken: OWNER_TOKEN,
    profileTokens: { sophie: PROFILE_TOKEN, noah: PROFILE_TOKEN },
  });
});

after(async () => {
  await server.close();
});

type Routes = {
  jobs: typeof import("./[id]/cron/jobs/route");
  job: typeof import("./[id]/cron/jobs/[jobId]/route");
  runs: typeof import("./[id]/cron/jobs/[jobId]/runs/route");
  pause: typeof import("./[id]/cron/jobs/[jobId]/pause/route");
  resume: typeof import("./[id]/cron/jobs/[jobId]/resume/route");
  run: typeof import("./[id]/cron/jobs/[jobId]/run/route");
  targets: typeof import("./[id]/cron/delivery-targets/route");
  blueprints: typeof import("./[id]/cron/blueprints/route");
  instantiate: typeof import("./[id]/cron/blueprints/instantiate/route");
};

async function loadRoutes(): Promise<Routes> {
  return {
    jobs: await import("./[id]/cron/jobs/route"),
    job: await import("./[id]/cron/jobs/[jobId]/route"),
    runs: await import("./[id]/cron/jobs/[jobId]/runs/route"),
    pause: await import("./[id]/cron/jobs/[jobId]/pause/route"),
    resume: await import("./[id]/cron/jobs/[jobId]/resume/route"),
    run: await import("./[id]/cron/jobs/[jobId]/run/route"),
    targets: await import("./[id]/cron/delivery-targets/route"),
    blueprints: await import("./[id]/cron/blueprints/route"),
    instantiate: await import("./[id]/cron/blueprints/instantiate/route"),
  };
}

function req(userId: string, method: string, url: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: authHeaders(userId),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const base = (channelId: string) => `http://localhost/api/channels/${channelId}/cron`;
// Pass the same shape to routes without a jobId too (RouteParams makes jobId optional).
const ctx = (id: string, jobId = "") => ({ params: Promise.resolve({ id, jobId }) });

/**
 * One channel + a gateway pointing at a fake plugin server + an active NPC for profile `sophie`.
 * `extraProfiles` attaches more profiles/NPCs to the same gateway.
 */
async function seedCronChannel(opts: { extraProfiles?: string[]; displayName?: string } = {}) {
  const owner = await seedUser("cron-owner");
  const gateway = await seedGateway(owner.id, server.baseUrl);
  const channel = await seedChannel(owner.id);
  const { bindGatewayToChannel } = await import("@/lib/gateway-resources");
  await bindGatewayToChannel({
    channelId: channel.id,
    gatewayId: gateway.id,
    boundByUserId: owner.id,
  });
  const profile = await seedHermesProfile(gateway.id, {
    profileName: "sophie",
    displayName: opts.displayName ?? "소피",
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
  return {
    ownerId: owner.id,
    gatewayId: gateway.id,
    channelId: channel.id,
    profileId: profile.id,
    npcId: npc.id,
    extras,
  };
}

/** Bind the same gateway (profile sophie) to another channel and put a sophie NPC there too. */
async function seedSiblingChannel(gatewayId: string, profileId: string) {
  const member = await seedUser("sibling-owner");
  const channel = await seedChannel(member.id, "Sibling Channel");
  const { bindGatewayToChannel } = await import("@/lib/gateway-resources");
  await bindGatewayToChannel({
    channelId: channel.id,
    gatewayId,
    boundByUserId: member.id,
  });
  const npc = await seedNpc({
    channelId: channel.id,
    hermesProfileId: profileId,
    positionX: 0,
    positionY: 0,
  });
  return { userId: member.id, channelId: channel.id, npcId: npc.id };
}

async function addMember(channelId: string, userId: string) {
  const { db, channelMembers } = await import("@/db");
  await db.insert(channelMembers).values({ channelId, userId, role: "member" });
}

async function createJob(
  routes: Routes,
  userId: string,
  channelId: string,
  npcId: string,
  overrides: Record<string, unknown> = {},
) {
  const res = await routes.jobs.POST(
    req(userId, "POST", `${base(channelId)}/jobs`, {
      npcId,
      name: "아침 브리핑",
      prompt: "오늘 일정을 요약해",
      schedule: "daily at 09:00",
      ...overrides,
    }),
    ctx(channelId),
  );
  return { status: res.status, body: await res.json() };
}

async function countOrigins(gatewayId: string) {
  const { db, cronJobOrigins } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  return (await db.select().from(cronJobOrigins).where(eq(cronJobOrigins.gatewayId, gatewayId)))
    .length;
}

test("non-members get 403, no login gets 401", async () => {
  server.reset();
  const routes = await loadRoutes();
  const seed = await seedCronChannel();
  const stranger = await seedUser("stranger");

  const forbidden = await routes.jobs.GET(
    req(stranger.id, "GET", `${base(seed.channelId)}/jobs`),
    ctx(seed.channelId),
  );
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).code, "not_a_member");

  const anonymous = await routes.jobs.GET(
    new NextRequest(`${base(seed.channelId)}/jobs`),
    ctx(seed.channelId),
  );
  assert.equal(anonymous.status, 401);
});

test("create → origin recorded (only after success); origin channel members can edit, pause, resume, run and delete", async () => {
  server.reset();
  const routes = await loadRoutes();
  const seed = await seedCronChannel();
  const member = await seedUser("member");
  await addMember(seed.channelId, member.id);

  // A failed create (no schedule → plugin 400) is not left in the ledger.
  const failed = await createJob(routes, member.id, seed.channelId, seed.npcId, {
    schedule: "",
  });
  assert.equal(failed.status, 400);
  assert.equal(await countOrigins(seed.gatewayId), 0, "실패한 생성은 출처를 남기지 않는다");

  const created = await createJob(routes, member.id, seed.channelId, seed.npcId);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const job = created.body.job;
  assert.equal(job.npcId, seed.npcId);
  assert.equal(job.npcName, "소피", "npcName 은 프로필 display_name 이다");
  assert.deepEqual(job.origin, { channelId: seed.channelId, createdByUserId: member.id });
  assert.equal(job.editable, true);
  assert.equal(await countOrigins(seed.gatewayId), 1);

  // The body sent to the plugin has no npcId mixed in, and deliver defaults to local.
  const sent = server.requests().find((r) => r.method === "POST" && r.path.endsWith("/jobs"));
  assert.ok(sent);
  assert.equal(sent.auth, `Bearer ${PROFILE_TOKEN}`, "프로필 토큰으로 부른다");
  assert.equal((sent.json as Record<string, unknown>).npcId, undefined);
  assert.equal((sent.json as Record<string, unknown>).deliver, "local");

  // edit
  const updated = await routes.job.PUT(
    req(seed.ownerId, "PUT", `${base(seed.channelId)}/jobs/${job.id}`, {
      npcId: seed.npcId,
      updates: { name: "저녁 브리핑", model: null },
    }),
    ctx(seed.channelId, job.id),
  );
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).job.name, "저녁 브리핑");

  // pause / resume
  const paused = await routes.pause.POST(
    req(member.id, "POST", `${base(seed.channelId)}/jobs/${job.id}/pause`, { npcId: seed.npcId }),
    ctx(seed.channelId, job.id),
  );
  assert.equal(paused.status, 200);
  assert.equal((await paused.json()).job.state, "paused");
  const resumed = await routes.resume.POST(
    req(member.id, "POST", `${base(seed.channelId)}/jobs/${job.id}/resume`, {
      npcId: seed.npcId,
    }),
    ctx(seed.channelId, job.id),
  );
  assert.equal(resumed.status, 200);
  assert.equal((await resumed.json()).job.state, "scheduled");

  // run now → 202
  const ran = await routes.run.POST(
    req(member.id, "POST", `${base(seed.channelId)}/jobs/${job.id}/run`, { npcId: seed.npcId }),
    ctx(seed.channelId, job.id),
  );
  assert.equal(ran.status, 202);
  assert.deepEqual(await ran.json(), { accepted: true });

  // history
  const runs = await routes.runs.GET(
    req(
      member.id,
      "GET",
      `${base(seed.channelId)}/jobs/${job.id}/runs?npcId=${seed.npcId}&limit=5`,
    ),
    ctx(seed.channelId, job.id),
  );
  assert.equal(runs.status, 200);
  const runsBody = await runs.json();
  assert.equal(runsBody.limit, 5);
  assert.equal(runsBody.runs.length, 1);
  // The plugin sends epoch seconds (Hermes' session rows); the route hands the screen ISO strings.
  assert.equal(typeof runsBody.runs[0].started_at, "string");
  assert.ok(!Number.isNaN(Date.parse(runsBody.runs[0].started_at)));

  // detail
  const detail = await routes.job.GET(
    req(member.id, "GET", `${base(seed.channelId)}/jobs/${job.id}?npcId=${seed.npcId}`),
    ctx(seed.channelId, job.id),
  );
  assert.equal(detail.status, 200);
  const detailBody = await detail.json();
  assert.equal(detailBody.job.editable, true);
  assert.equal(detailBody.timezone, "Asia/Seoul");

  // delete → ledger removal
  const deleted = await routes.job.DELETE(
    req(member.id, "DELETE", `${base(seed.channelId)}/jobs/${job.id}?npcId=${seed.npcId}`),
    ctx(seed.channelId, job.id),
  );
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { ok: true });
  assert.equal(await countOrigins(seed.gatewayId), 0, "삭제하면 출처도 지운다");
});

test("members of another channel with the same NPC can see it but not modify it (403 cron_read_only)", async () => {
  server.reset();
  const routes = await loadRoutes();
  const seed = await seedCronChannel();
  const sibling = await seedSiblingChannel(seed.gatewayId, seed.profileId);

  const created = await createJob(routes, seed.ownerId, seed.channelId, seed.npcId);
  assert.equal(created.status, 201);
  const jobId = created.body.job.id;

  const listed = await routes.jobs.GET(
    req(sibling.userId, "GET", `${base(sibling.channelId)}/jobs`),
    ctx(sibling.channelId),
  );
  assert.equal(listed.status, 200);
  const body = await listed.json();
  assert.equal(body.jobs.length, 1);
  assert.equal(body.jobs[0].id, jobId);
  assert.equal(body.jobs[0].npcId, sibling.npcId, "npcId 는 요청 채널의 NPC 행이다");
  assert.equal(body.jobs[0].editable, false);
  assert.deepEqual(body.jobs[0].origin, {
    channelId: seed.channelId,
    createdByUserId: seed.ownerId,
  });

  const before = server.requests().length;
  const mutations = [
    routes.job.PUT(
      req(sibling.userId, "PUT", `${base(sibling.channelId)}/jobs/${jobId}`, {
        npcId: sibling.npcId,
        updates: { name: "x" },
      }),
      ctx(sibling.channelId, jobId),
    ),
    routes.pause.POST(
      req(sibling.userId, "POST", `${base(sibling.channelId)}/jobs/${jobId}/pause`, {
        npcId: sibling.npcId,
      }),
      ctx(sibling.channelId, jobId),
    ),
    routes.run.POST(
      req(sibling.userId, "POST", `${base(sibling.channelId)}/jobs/${jobId}/run`, {
        npcId: sibling.npcId,
      }),
      ctx(sibling.channelId, jobId),
    ),
    routes.job.DELETE(
      req(
        sibling.userId,
        "DELETE",
        `${base(sibling.channelId)}/jobs/${jobId}?npcId=${sibling.npcId}`,
      ),
      ctx(sibling.channelId, jobId),
    ),
  ];
  for (const res of await Promise.all(mutations)) {
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, "cron_read_only");
  }
  assert.equal(server.requests().length, before, "읽기 전용 거절은 Hermes 를 부르기 전에 끝난다");
  assert.equal(await countOrigins(seed.gatewayId), 1, "장부는 그대로");
});

test("cron jobs created outside DeskRPG (no origin) are read-only even for the origin channel owner", async () => {
  server.reset();
  const routes = await loadRoutes();
  const seed = await seedCronChannel();
  const { createProfilePluginClient } = await import("@/lib/hermes/plugin-client");
  const external = createProfilePluginClient({
    baseUrl: server.baseUrl,
    profileName: "sophie",
    profileToken: PROFILE_TOKEN,
  });
  const made = await external.cron.createJob({
    schedule: "hourly",
    prompt: "외부에서",
    name: "external",
  });
  assert.equal(made.ok, true);
  if (!made.ok) return;
  const jobId = made.data.job.id;

  const detail = await routes.job.GET(
    req(seed.ownerId, "GET", `${base(seed.channelId)}/jobs/${jobId}?npcId=${seed.npcId}`),
    ctx(seed.channelId, jobId),
  );
  assert.equal(detail.status, 200);
  const body = await detail.json();
  assert.equal(body.job.origin, null);
  assert.equal(body.job.editable, false);

  const res = await routes.job.PUT(
    req(seed.ownerId, "PUT", `${base(seed.channelId)}/jobs/${jobId}`, {
      npcId: seed.npcId,
      updates: { name: "x" },
    }),
    ctx(seed.channelId, jobId),
  );
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "cron_read_only");
});

test("the list is the union over the channel's active NPCs, filtered by npcId; sleeping NPCs are excluded", async () => {
  server.reset();
  const routes = await loadRoutes();
  const seed = await seedCronChannel({ extraProfiles: ["noah"] });
  const noah = seed.extras[0];

  assert.equal((await createJob(routes, seed.ownerId, seed.channelId, seed.npcId)).status, 201);
  assert.equal(
    (
      await createJob(routes, seed.ownerId, seed.channelId, noah.npcId, {
        name: "노아의 일",
        paused: true,
      })
    ).status,
    201,
  );

  const all = await routes.jobs.GET(
    req(seed.ownerId, "GET", `${base(seed.channelId)}/jobs`),
    ctx(seed.channelId),
  );
  assert.equal(all.status, 200);
  const allBody = await all.json();
  assert.equal(allBody.jobs.length, 2, "멈춰 있는 크론도 목록에 보인다");
  assert.deepEqual(
    allBody.jobs.map((j: { npcId: string }) => j.npcId).sort(),
    [seed.npcId, noah.npcId].sort(),
  );
  assert.equal(allBody.timezone, "Asia/Seoul");
  assert.equal(allBody.errors, undefined);

  const filtered = await routes.jobs.GET(
    req(seed.ownerId, "GET", `${base(seed.channelId)}/jobs?npcId=${noah.npcId}`),
    ctx(seed.channelId),
  );
  const filteredBody = await filtered.json();
  assert.equal(filteredBody.jobs.length, 1);
  assert.equal(filteredBody.jobs[0].name, "노아의 일");
  assert.equal(filteredBody.jobs[0].npcName, "noah", "display_name 이 없으면 profile_name");

  // Putting noah to sleep drops them from the union.
  const { setNpcActive } = await import("@/lib/npc-roster");
  await setNpcActive(noah.npcId, false);
  const afterSleep = await routes.jobs.GET(
    req(seed.ownerId, "GET", `${base(seed.channelId)}/jobs`),
    ctx(seed.channelId),
  );
  assert.equal((await afterSleep.json()).jobs.length, 1);

  const unknown = await routes.jobs.GET(
    req(seed.ownerId, "GET", `${base(seed.channelId)}/jobs?npcId=${noah.npcId}`),
    ctx(seed.channelId),
  );
  assert.equal(unknown.status, 404, "휴면 NPC 는 이 채널의 active NPC 가 아니다");
});

test("if one profile's call fails the list survives and errors carries only that NPC", async () => {
  server.reset();
  const routes = await loadRoutes();
  const seed = await seedCronChannel();
  // A profile the gateway has but the fake server does not know → 404 Unknown profile.
  const ghost = await seedHermesProfile(seed.gatewayId, { profileName: "ghost" });
  const ghostNpc = await seedNpc({
    channelId: seed.channelId,
    hermesProfileId: ghost.id,
    positionX: 5,
    positionY: 5,
  });
  assert.equal((await createJob(routes, seed.ownerId, seed.channelId, seed.npcId)).status, 201);

  const res = await routes.jobs.GET(
    req(seed.ownerId, "GET", `${base(seed.channelId)}/jobs`),
    ctx(seed.channelId),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.jobs.length, 1);
  assert.equal(body.errors.length, 1);
  assert.equal(body.errors[0].npcId, ghostNpc.id);
  assert.equal(typeof body.errors[0].code, "string");
});

test("after switching gateways, origins from the old gateway are ignored", async () => {
  server.reset();
  const routes = await loadRoutes();
  const seed = await seedCronChannel();
  const created = await createJob(routes, seed.ownerId, seed.channelId, seed.npcId);
  assert.equal(created.status, 201);
  const jobId = created.body.job.id;

  // Switch to a second gateway pointing at the same fake server + a profile of the same name.
  const gatewayB = await seedGateway(seed.ownerId, server.baseUrl);
  const profileB = await seedHermesProfile(gatewayB.id, { profileName: "sophie" });
  const { bindGatewayToChannel } = await import("@/lib/gateway-resources");
  await bindGatewayToChannel({
    channelId: seed.channelId,
    gatewayId: gatewayB.id,
    boundByUserId: seed.ownerId,
  });
  const { setNpcActive } = await import("@/lib/npc-roster");
  await setNpcActive(seed.npcId, false);
  const npcB = await seedNpc({
    channelId: seed.channelId,
    hermesProfileId: profileB.id,
    positionX: 1,
    positionY: 1,
  });

  const listed = await routes.jobs.GET(
    req(seed.ownerId, "GET", `${base(seed.channelId)}/jobs`),
    ctx(seed.channelId),
  );
  const body = await listed.json();
  assert.equal(body.jobs.length, 1);
  assert.equal(body.jobs[0].id, jobId);
  assert.equal(body.jobs[0].npcId, npcB.id);
  assert.equal(body.jobs[0].origin, null, "옛 게이트웨이의 출처 행은 무시한다");
  assert.equal(body.jobs[0].editable, false);
  assert.equal(await countOrigins(seed.gatewayId), 1, "행 자체는 지우지 않는다");
});

test("origin rows whose profile is gone are cleaned up when the list is read", async () => {
  server.reset();
  const routes = await loadRoutes();
  const seed = await seedCronChannel();
  const { db, cronJobOrigins, hermesProfiles } = await import("@/db");
  const { eq } = await import("drizzle-orm");

  // An origin row for a profile name that no longer exists (an orphan left after the profile was deleted).
  await db.insert(cronJobOrigins).values({
    gatewayId: seed.gatewayId,
    profileName: "departed",
    jobId: "job-old",
    channelId: seed.channelId,
    createdByUserId: seed.ownerId,
  });
  // Origin rows of live profiles must remain.
  await db.insert(cronJobOrigins).values({
    gatewayId: seed.gatewayId,
    profileName: "sophie",
    jobId: "job-live",
    channelId: seed.channelId,
    createdByUserId: seed.ownerId,
  });
  assert.equal(await countOrigins(seed.gatewayId), 2);

  const res = await routes.jobs.GET(
    req(seed.ownerId, "GET", `${base(seed.channelId)}/jobs`),
    ctx(seed.channelId),
  );
  assert.equal(res.status, 200);
  const rows = await db
    .select({ profileName: cronJobOrigins.profileName })
    .from(cronJobOrigins)
    .where(eq(cronJobOrigins.gatewayId, seed.gatewayId));
  assert.deepEqual(
    rows.map((r) => r.profileName),
    ["sophie"],
  );
  // The number of live profiles is unchanged (cleanup touches only the ledger).
  const live = await db
    .select({ id: hermesProfiles.id })
    .from(hermesProfiles)
    .where(eq(hermesProfiles.gatewayId, seed.gatewayId));
  assert.equal(live.length, 1);
});

test("if the cache says 0.5.0, Hermes is not called and it is 428 plugin_upgrade_required", async () => {
  server.reset();
  const routes = await loadRoutes();
  const seed = await seedCronChannel();
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
  const res = await routes.jobs.GET(
    req(seed.ownerId, "GET", `${base(seed.channelId)}/jobs`),
    ctx(seed.channelId),
  );
  assert.equal(res.status, 428);
  const body = await res.json();
  assert.equal(body.code, "plugin_upgrade_required");
  assert.equal(body.minVersion, "0.6.0");
  assert.equal(server.requests().length, before, "신선한 캐시면 재확인하지 않는다");

  // If the cache is stale, recheck via /deskrpg/info and refresh the cache.
  await db
    .update(gatewayResources)
    .set({ pluginCheckedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() as never })
    .where(eq(gatewayResources.id, seed.gatewayId));
  const fresh = await routes.jobs.GET(
    req(seed.ownerId, "GET", `${base(seed.channelId)}/jobs`),
    ctx(seed.channelId),
  );
  assert.equal(fresh.status, 200);
  assert.ok(server.requests().some((r) => r.path === "/deskrpg/info"));
  const [row] = await db
    .select({ pluginVersion: gatewayResources.pluginVersion })
    .from(gatewayResources)
    .where(eq(gatewayResources.id, seed.gatewayId));
  assert.equal(row.pluginVersion, "0.6.0");
});

test("timezone is null when the plugin does not give one", async () => {
  server.reset();
  server.setInfo({ timezone: null });
  try {
    const routes = await loadRoutes();
    const seed = await seedCronChannel();
    const res = await routes.jobs.GET(
      req(seed.ownerId, "GET", `${base(seed.channelId)}/jobs`),
      ctx(seed.channelId),
    );
    assert.equal(res.status, 200);
    assert.equal((await res.json()).timezone, null);
  } finally {
    server.setInfo({ timezone: "Asia/Seoul" });
  }
});

test("Hermes errors are passed through with their status code and {code, message}", async () => {
  server.reset();
  const routes = await loadRoutes();
  const seed = await seedCronChannel();
  const res = await routes.job.GET(
    req(seed.ownerId, "GET", `${base(seed.channelId)}/jobs/no-such-job?npcId=${seed.npcId}`),
    ctx(seed.channelId, "no-such-job"),
  );
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(typeof body.code, "string");
  assert.equal(typeof body.message, "string");
});

test("reading delivery targets and templates, and instantiating a template (origin recorded)", async () => {
  server.reset();
  const routes = await loadRoutes();
  const seed = await seedCronChannel();
  server.setDeliveryTargets("sophie", [
    { id: "local", name: "Local", home_target_set: true, home_env_var: "" },
  ]);
  server.setBlueprints("sophie", [
    {
      key: "daily-summary",
      title: "일일 요약",
      description: "",
      category: "reports",
      tags: [],
      fields: [{ name: "time", type: "time", label: "시각" }],
      command: "요약해",
      appUrl: "",
    },
  ]);

  const targets = await routes.targets.GET(
    req(seed.ownerId, "GET", `${base(seed.channelId)}/delivery-targets?npcId=${seed.npcId}`),
    ctx(seed.channelId),
  );
  assert.equal(targets.status, 200);
  assert.equal((await targets.json()).targets[0].id, "local");

  const blueprints = await routes.blueprints.GET(
    req(seed.ownerId, "GET", `${base(seed.channelId)}/blueprints?npcId=${seed.npcId}`),
    ctx(seed.channelId),
  );
  assert.equal(blueprints.status, 200);
  assert.equal((await blueprints.json()).blueprints[0].key, "daily-summary");

  const made = await routes.instantiate.POST(
    req(seed.ownerId, "POST", `${base(seed.channelId)}/blueprints/instantiate`, {
      npcId: seed.npcId,
      blueprint: "daily-summary",
      values: { time: "08:30" },
    }),
    ctx(seed.channelId),
  );
  assert.equal(made.status, 201);
  const body = await made.json();
  assert.equal(body.job.editable, true);
  assert.deepEqual(body.job.origin, { channelId: seed.channelId, createdByUserId: seed.ownerId });
  assert.equal(await countOrigins(seed.gatewayId), 1);
});

test("script-only jobs can be created without a prompt; with neither prompt nor script it is 400", async () => {
  server.reset();
  const routes = await loadRoutes();
  const seed = await seedCronChannel();

  const neither = await createJob(routes, seed.ownerId, seed.channelId, seed.npcId, {
    prompt: undefined,
  });
  assert.equal(neither.status, 400);
  assert.equal(neither.body.code, "invalid_body");

  const before = server.requests().length;
  const scripted = await createJob(routes, seed.ownerId, seed.channelId, seed.npcId, {
    prompt: undefined,
    script: "echo hello",
  });
  assert.equal(scripted.status, 201, JSON.stringify(scripted.body));
  const sent = server
    .requests()
    .slice(before)
    .find((r) => r.method === "POST" && r.path.endsWith("/cron/jobs"));
  assert.ok(sent);
  const json = sent.json as Record<string, unknown>;
  assert.equal(json.script, "echo hello", "script 는 그대로 전달된다");
  assert.equal("prompt" in json, false, "빈 prompt 를 지어내지 않는다");
  assert.equal("npcId" in json, false);
});

test("gate diagnoses are not lumped together — plugin_absent is 404, unreachable is 503 unreachable", async () => {
  server.reset();
  const routes = await loadRoutes();
  const seed = await seedCronChannel();
  const { db, gatewayResources, nowForDb } = await import("@/db");
  const { eq } = await import("drizzle-orm");

  // A fresh plugin_absent cache → 404 without calling Hermes. This used to be misdiagnosed as 428.
  await db
    .update(gatewayResources)
    .set({ pluginStatus: "plugin_absent", pluginCheckedAt: nowForDb(), pluginInfoJson: null })
    .where(eq(gatewayResources.id, seed.gatewayId));
  const before = server.requests().length;
  const absent = await routes.jobs.GET(
    req(seed.ownerId, "GET", `${base(seed.channelId)}/jobs`),
    ctx(seed.channelId),
  );
  assert.equal(absent.status, 404);
  assert.equal((await absent.json()).code, "plugin_absent");
  assert.equal(server.requests().length, before, "신선한 캐시면 재확인하지 않는다");

  // An unknown cache is probed again even when fresh. If the gateway is dead, 503 unreachable.
  await db
    .update(gatewayResources)
    .set({ baseUrl: "http://127.0.0.1:1", pluginStatus: "unknown", pluginCheckedAt: nowForDb() })
    .where(eq(gatewayResources.id, seed.gatewayId));
  const dead = await routes.jobs.GET(
    req(seed.ownerId, "GET", `${base(seed.channelId)}/jobs`),
    ctx(seed.channelId),
  );
  assert.equal(dead.status, 503);
  assert.equal((await dead.json()).code, "unreachable");
});

test("body validation — missing npcId or another channel's NPC is 400/404 and Hermes is not called", async () => {
  server.reset();
  const routes = await loadRoutes();
  const seed = await seedCronChannel();
  const other = await seedCronChannel();
  // reset() does not clear the request log — count only what was added from here.
  const before = server.requests().length;

  const missing = await routes.jobs.POST(
    req(seed.ownerId, "POST", `${base(seed.channelId)}/jobs`, { name: "x", prompt: "y" }),
    ctx(seed.channelId),
  );
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).code, "invalid_body");

  const foreign = await createJob(routes, seed.ownerId, seed.channelId, other.npcId);
  assert.equal(foreign.status, 404);
  assert.equal(foreign.body.code, "npc_not_found");
  assert.equal(
    server
      .requests()
      .slice(before)
      .filter((r) => r.method === "POST").length,
    0,
    "검증 실패는 플러그인에 닿기 전에 끝난다",
  );
});
