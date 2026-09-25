import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { startFakePluginServer, type FakePluginServer } from "./fake-plugin-server";
import { createOwnerPluginClient, createProfilePluginClient } from "./plugin-client";

// Round-trips the owner-key scope (kanban·events) and the profile-key scope (cron) from the real client → a fake plugin
// server. The fake server only reproduces spec A.1/A.2/A.3 and does not interpret it — what we
// pin here is "which key and which body go to which path, and what shape comes back".

const OWNER = "owner-key-1234567890";
const SOPHIE = "sophie-key-0987654321";

let server: FakePluginServer;

before(async () => {
  server = await startFakePluginServer({
    ownerToken: OWNER,
    profileTokens: { sophie: SOPHIE },
  });
});

after(async () => {
  await server.close();
});

beforeEach(() => {
  server.reset();
});

function owner() {
  return createOwnerPluginClient({ baseUrl: server.baseUrl, ownerToken: OWNER });
}

function sophie() {
  return createProfilePluginClient({
    baseUrl: server.baseUrl,
    profileName: "sophie",
    profileToken: SOPHIE,
  });
}

function unwrap<T>(res: { ok: true; data: T } | { ok: false; failure: { code: string } }): T {
  assert.equal(res.ok, true, res.ok ? "" : `unexpected failure: ${res.failure.code}`);
  if (!res.ok) throw new Error("unreachable");
  return res.data;
}

describe("owner client — info", () => {
  it("calls /deskrpg/info with the owner key and returns the contract block as-is", async () => {
    const info = unwrap(await owner().info());
    assert.equal(info.plugin, "deskrpg");
    assert.equal(info.version, "0.6.0");
    assert.deepEqual(info.capabilities, [
      "kanban",
      "cron",
      "events",
      "swarm",
      "kanban_views",
      "initial_status",
      "kanban_review_policy_v1",
      "event_cursor_handoff",
      "card_proposals",
    ]);
    assert.equal(info.timezone, "Asia/Seoul");
    assert.deepEqual(info.kanban, { dispatcher_present: true, attachments: true });
    assert.equal(server.lastRequest()?.auth, `Bearer ${OWNER}`);
  });

  it("the fake server's version·capabilities can be changed", async () => {
    server.setInfo({ version: "0.5.9", capabilities: ["kanban"] });
    const info = unwrap(await owner().info());
    assert.equal(info.version, "0.5.9");
    assert.deepEqual(info.capabilities, ["kanban"]);
  });
});

describe("auth — A.3", () => {
  it("sending a profile key to the owner scope folds into 401", async () => {
    const wrong = createOwnerPluginClient({ baseUrl: server.baseUrl, ownerToken: SOPHIE });
    const res = await wrong.kanban.listBoards();
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.status, 401);
    assert.equal(res.failure.code, "gateway_auth_failed");
  });

  it("sending the owner key to the profile scope folds into 401", async () => {
    const wrong = createProfilePluginClient({
      baseUrl: server.baseUrl,
      profileName: "sophie",
      profileToken: OWNER,
    });
    const res = await wrong.cron.listJobs();
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.status, 401);
    assert.equal(res.failure.code, "gateway_auth_failed");
  });

  it("an unknown profile is 404", async () => {
    const ghost = createProfilePluginClient({
      baseUrl: server.baseUrl,
      profileName: "ghost",
      profileToken: SOPHIE,
    });
    const res = await ghost.cron.listJobs();
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.status, 404);
  });
});

describe("kanban — boards", () => {
  it("create → re-creating the same slug is 200 + existing board → list·update", async () => {
    const api = owner().kanban;
    const created = unwrap(await api.createBoard({ slug: "dev", name: "Dev" }));
    assert.equal(created.board.slug, "dev");
    assert.equal(created.board.name, "Dev");
    assert.equal(server.lastRequest()?.status, 201);

    const again = unwrap(await api.createBoard({ slug: "dev", name: "다른 이름" }));
    assert.equal(again.board.name, "Dev", "기존 slug 는 덮어쓰지 않고 그대로 돌려준다");
    assert.equal(server.lastRequest()?.status, 200);

    const listed = unwrap(await api.listBoards());
    assert.deepEqual(
      listed.boards.map((b) => b.slug),
      ["dev"],
    );
    assert.equal(listed.current, "dev");

    const patched = unwrap(await api.updateBoard("dev", { description: "설명" }));
    assert.equal(patched.board.description, "설명");
    assert.equal(server.lastRequest()?.method, "PATCH");
    assert.equal(server.lastRequest()?.path, "/deskrpg/kanban/boards/dev");
  });

  it("400 when the slug format is wrong", async () => {
    const res = await owner().kanban.createBoard({ slug: "Bad Slug", name: "x" });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.status, 400);
    assert.equal(res.failure.code, "invalid_slug");
  });
});

describe("kanban — cards", () => {
  it("create·get·update·comment·action·delete round-trip with ?board=", async () => {
    const api = owner().kanban;
    unwrap(await api.createBoard({ slug: "dev", name: "Dev" }));

    const created = unwrap(
      await api.createTask("dev", { title: "첫 카드", body: "본문", assignee: "sophie" }),
    );
    assert.equal(created.task.title, "첫 카드");
    assert.equal(created.task.status, "todo");
    assert.equal(server.lastRequest()?.path, "/deskrpg/kanban/tasks?board=dev");
    const id = created.task.id;

    const board = unwrap(await api.getBoard("dev"));
    const todo = board.columns.find((c) => c.name === "todo");
    assert.ok(todo);
    assert.deepEqual(
      todo.tasks.map((t) => t.id),
      [id],
    );
    assert.deepEqual(board.assignees, ["sophie"]);
    assert.equal(server.lastRequest()?.path, "/deskrpg/kanban/board?board=dev");

    const patched = unwrap(await api.updateTask("dev", id, { status: "ready", priority: "high" }));
    assert.equal(patched.task.status, "ready");
    assert.equal(patched.task.priority, "high");

    const comment = unwrap(await api.addComment("dev", id, { author: "dante", body: "메모" }));
    assert.equal(comment.comment.author, "dante");

    const detail = unwrap(await api.getTask("dev", id));
    assert.equal(detail.task.status, "ready");
    assert.equal(detail.comments.length, 1);
    assert.ok(detail.events.length >= 2, "생성·상태 변경 이벤트가 카드 이력에 남는다");
    assert.deepEqual(detail.links, { parents: [], children: [] });
    assert.deepEqual(detail.runs, []);
    assert.deepEqual(detail.attachments, []);

    const approved = unwrap(await api.runTaskAction("dev", id, "approve", {}));
    assert.equal(approved.task.status, "done");
    assert.equal(server.lastRequest()?.path, "/deskrpg/kanban/tasks/" + id + "/approve?board=dev");

    const reassigned = unwrap(
      await api.runTaskAction("dev", id, "reassign", { profile: "noah", reclaim_first: true }),
    );
    assert.equal(reassigned.task.assignee, "noah");
    assert.deepEqual(server.lastRequest()?.json, { profile: "noah", reclaim_first: true });

    const changes = unwrap(
      await api.runTaskAction("dev", id, "request-changes", { comment: "다시" }),
    );
    assert.equal(changes.task.status, "todo");

    const deleted = unwrap(await api.deleteTask("dev", id));
    assert.deepEqual(deleted, { ok: true });
    const gone = await api.getTask("dev", id);
    assert.equal(gone.ok, false);
    if (gone.ok) return;
    assert.equal(gone.status, 404);
    assert.equal(gone.failure.code, "not_found");
  });

  it("fails when the board param is missing or the board is unknown", async () => {
    const res = await owner().kanban.getBoard("nope");
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.status, 404);
  });

  it("archived cards are not on the board unless include_archived", async () => {
    const api = owner().kanban;
    unwrap(await api.createBoard({ slug: "dev", name: "Dev" }));
    const { task } = unwrap(await api.createTask("dev", { title: "보관" }));
    unwrap(await api.runTaskAction("dev", task.id, "archive", {}));

    const hidden = unwrap(await api.getBoard("dev"));
    assert.equal(hidden.columns.flatMap((c) => c.tasks).length, 0);
    const shown = unwrap(await api.getBoard("dev", { includeArchived: true }));
    assert.equal(shown.columns.flatMap((c) => c.tasks).length, 1);
    assert.equal(
      server.lastRequest()?.path,
      "/deskrpg/kanban/board?board=dev&include_archived=true",
    );
  });

  it("links·dispatch·logs·orchestration·profiles", async () => {
    const api = owner().kanban;
    unwrap(await api.createBoard({ slug: "dev", name: "Dev" }));
    const parent = unwrap(await api.createTask("dev", { title: "부모" })).task;
    const child = unwrap(await api.createTask("dev", { title: "자식", parents: [parent.id] })).task;

    const detail = unwrap(await api.getTask("dev", child.id));
    assert.deepEqual(detail.links.parents, [parent.id]);

    unwrap(await api.removeLink("dev", { parent_id: parent.id, child_id: child.id }));
    assert.equal(server.lastRequest()?.method, "DELETE");
    assert.equal(server.lastRequest()?.path, "/deskrpg/kanban/links?board=dev");
    assert.deepEqual(unwrap(await api.getTask("dev", child.id)).links.parents, []);

    unwrap(await api.addLink("dev", { parent_id: parent.id, child_id: child.id }));
    assert.deepEqual(unwrap(await api.getTask("dev", parent.id)).links.children, [child.id]);

    unwrap(await api.updateTask("dev", parent.id, { status: "ready" }));
    const dispatched = unwrap(await api.dispatch("dev", { max: 2 }));
    assert.equal(server.lastRequest()?.path, "/deskrpg/kanban/dispatch?board=dev&max=2");
    assert.deepEqual(
      dispatched.spawned.map((s) => s.task_id),
      [parent.id],
    );
    const running = unwrap(await api.getTask("dev", parent.id));
    assert.equal(running.task.status, "running");
    assert.equal(running.runs.length, 1);

    server.setTaskLog("dev", parent.id, "line1\nline2\n");
    const log = unwrap(await api.getTaskLog("dev", parent.id, { tail: 1 }));
    assert.equal(log.exists, true);
    assert.equal(log.content, "line2\n");
    assert.equal(log.truncated, true);
    assert.equal(
      server.lastRequest()?.path,
      `/deskrpg/kanban/tasks/${parent.id}/log?board=dev&tail=1`,
    );

    const orch = unwrap(await api.getOrchestration());
    assert.equal(orch.auto_decompose, false);
    const updated = unwrap(
      await api.updateOrchestration({ orchestrator_profile: "sophie", max_in_progress: 3 }),
    );
    assert.equal(updated.orchestrator_profile, "sophie");
    assert.equal(updated.resolved_orchestrator_profile, "sophie");
    assert.equal(updated.max_in_progress, 3);
    assert.equal(server.lastRequest()?.method, "PUT");

    const profiles = unwrap(await api.listProfiles());
    assert.deepEqual(
      profiles.profiles.map((p) => p.name),
      ["sophie"],
    );
  });

  it("uploads attachments as multipart and lists·gets·deletes them", async () => {
    const api = owner().kanban;
    unwrap(await api.createBoard({ slug: "dev", name: "Dev" }));
    const { task } = unwrap(await api.createTask("dev", { title: "첨부" }));

    const uploaded = unwrap(
      await api.uploadAttachment("dev", task.id, { filename: "spec.md", content: "# 스펙" }),
    );
    assert.equal(uploaded.attachment.filename, "spec.md");
    assert.equal(uploaded.attachment.size, Buffer.byteLength("# 스펙"));
    assert.match(server.lastRequest()?.contentType ?? "", /^multipart\/form-data/);

    const listed = unwrap(await api.listAttachments("dev", task.id));
    assert.equal(listed.attachments.length, 1);

    const contentRes = await api.attachmentContent("dev", uploaded.attachment.id, {});
    assert.equal(contentRes.ok, true);
    if (contentRes.ok) assert.equal(await contentRes.response.text(), "# 스펙");
    assert.equal(
      server.lastRequest()?.path,
      `/deskrpg/kanban/attachments/${uploaded.attachment.id}?board=dev`,
    );

    unwrap(await api.deleteAttachment("dev", uploaded.attachment.id));
    assert.equal(unwrap(await api.listAttachments("dev", task.id)).attachments.length, 0);
  });
});

describe("kanban — swarm", () => {
  function swarmBody() {
    return {
      goal: "목표",
      workers: [{ profile: "nova", title: "조사" }],
      verifier: "sophie",
      synthesizer: "dante",
    };
  }

  it("sends the body as-is to the swarm endpoint and creates root·worker·verify·synthesis cards", async () => {
    const api = owner().kanban;
    unwrap(await api.createBoard({ slug: "dev", name: "Dev" }));

    const created = unwrap(await api.createSwarm("dev", swarmBody()));
    assert.equal(server.lastRequest()?.method, "POST");
    assert.equal(server.lastRequest()?.path, "/deskrpg/kanban/swarm?board=dev");
    assert.ok(created.root_id);
    assert.equal(created.worker_ids.length, 1);
    assert.ok(created.verifier_id);
    assert.ok(created.synthesizer_id);

    const board = unwrap(await api.getBoard("dev"));
    assert.equal(
      board.columns.reduce((n, c) => n + c.tasks.length, 0),
      4,
    );
  });

  it("an empty goal is 400 invalid_field", async () => {
    const api = owner().kanban;
    unwrap(await api.createBoard({ slug: "dev", name: "Dev" }));
    const res = await api.createSwarm("dev", { ...swarmBody(), goal: "" });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.status, 400);
  });

  it("zero workers is 400", async () => {
    const api = owner().kanban;
    unwrap(await api.createBoard({ slug: "dev", name: "Dev" }));
    const res = await api.createSwarm("dev", { ...swarmBody(), workers: [] });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.status, 400);
  });

  it("an empty worker title is 400 invalid_field — the plugin rejects it even if kanban-routes.ts validation is bypassed", async () => {
    const api = owner().kanban;
    unwrap(await api.createBoard({ slug: "dev", name: "Dev" }));
    const res = await api.createSwarm("dev", {
      ...swarmBody(),
      workers: [{ profile: "nova", title: "" }],
    });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.status, 400);
    assert.equal(res.failure.code, "invalid_field");
  });

  it("getBlackboard returns the topology left by the swarm", async () => {
    const api = owner().kanban;
    unwrap(await api.createBoard({ slug: "dev", name: "Dev" }));
    const created = unwrap(await api.createSwarm("dev", swarmBody()));

    const bb = unwrap(await api.getBlackboard("dev", created.root_id));
    assert.equal(
      server.lastRequest()?.path,
      `/deskrpg/kanban/tasks/${created.root_id}/blackboard?board=dev`,
    );
    const topology = bb.blackboard.topology as { goal: string; root_id: string };
    assert.equal(topology.goal, "목표");
    assert.equal(topology.root_id, created.root_id);
  });

  it("the blackboard of an unknown card is 404 task_not_found", async () => {
    const api = owner().kanban;
    unwrap(await api.createBoard({ slug: "dev", name: "Dev" }));
    const res = await api.getBlackboard("dev", "no-such-task");
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.status, 404);
    assert.equal(res.failure.code, "task_not_found");
  });
});

describe("events — cursor", () => {
  it("new board k/d positions ignore older events from other boards", async () => {
    const api = owner();
    unwrap(await api.kanban.createBoard({ slug: "old", name: "Old" }));
    unwrap(await api.kanban.createBoard({ slug: "new", name: "New" }));
    server.pushEvent({ kind: "task.created", board: "old", task_id: "old-task", payload: {} });
    server.pushEvent({ kind: "task.deleted", board: "old", task_id: "old-delete", payload: {} });
    const start = unwrap(await api.events.poll({ board: "new" }));
    const created = server.pushEvent({
      kind: "task.created",
      board: "new",
      task_id: "new-task",
      payload: {},
    });
    const deleted = server.pushEvent({
      kind: "task.deleted",
      board: "new",
      task_id: "new-delete",
      payload: {},
    });
    const page = unwrap(await api.events.poll({ board: "new", cursor: start.cursor }));
    assert.deepEqual(
      page.events.map((event) => event.id),
      [created.id, deleted.id],
    );
  });

  it("handoff keeps target kanban position and carrier global positions", async () => {
    const api = owner();
    unwrap(await api.kanban.createBoard({ slug: "old", name: "Old" }));
    unwrap(await api.kanban.createBoard({ slug: "new", name: "New" }));
    const source = unwrap(
      await api.events.poll({ board: "old", include: "artifacts,card_proposals" }),
    );
    const target = unwrap(await api.events.poll({ board: "new" }));
    const kanban = server.pushEvent({
      kind: "task.created",
      board: "new",
      task_id: "new-task",
      payload: {},
    });
    const proposal = server.pushEvent({
      kind: "card_proposal.created",
      board: "old",
      payload: { proposal_id: "p1" },
    });
    const artifact = server.pushEvent({ kind: "artifact.created", board: "old", payload: {} });
    const cron = server.pushEvent({ kind: "cron.run.finished", profile: "sophie", payload: {} });
    const merged = unwrap(
      await api.events.handoff({
        board: "new",
        board_cursor: target.cursor,
        carrier_cursor: source.cursor,
      }),
    );
    assert.deepEqual(server.lastRequest()?.json, {
      board: "new",
      board_cursor: target.cursor,
      carrier_cursor: source.cursor,
    });
    assert.equal(server.lastRequest()?.path, "/deskrpg/events/handoff");
    assert.equal(server.lastRequest()?.method, "POST");
    assert.equal(server.lastRequest()?.auth, `Bearer ${OWNER}`);
    const received = unwrap(
      await api.events.poll({
        board: "new",
        cursor: merged.cursor,
        include: "artifacts,card_proposals",
      }),
    );
    assert.deepEqual(
      received.events.map((e) => e.id),
      [kanban, proposal, artifact, cron].map((e) => e.id),
    );
  });

  it("handoff validates donor, target, board, auth, and old route", async () => {
    const api = owner();
    unwrap(await api.kanban.createBoard({ slug: "new", name: "New" }));
    const legacy = unwrap(await api.events.poll({ board: "new" })).cursor;
    const valid = unwrap(
      await api.events.poll({ board: "new", include: "artifacts,card_proposals" }),
    ).cursor;
    const request = { board: "new", board_cursor: null, carrier_cursor: valid };
    assert.ok(unwrap(await api.events.handoff(request)).cursor);
    for (const [body, status, code] of [
      [{ ...request, carrier_cursor: legacy }, 409, "carrier_cursor_incomplete"],
      [{ ...request, carrier_cursor: "bad" }, 400, "invalid_handoff_cursor"],
      [{ ...request, board_cursor: "bad" }, 400, "invalid_handoff_cursor"],
      [{ ...request, board: "missing" }, 404, "board_not_found"],
    ] as const) {
      const result = await api.events.handoff(body);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.status, status);
        assert.equal(result.failure.code, code);
      }
    }
    const wrong = createOwnerPluginClient({ baseUrl: server.baseUrl, ownerToken: SOPHIE });
    const unauthorized = await wrong.events.handoff(request);
    assert.equal(unauthorized.ok, false);
    if (!unauthorized.ok) assert.equal(unauthorized.status, 401);
    server.setInfo({ capabilities: ["kanban", "cron", "events"] });
    const absent = await api.events.handoff(request);
    assert.equal(absent.ok, false);
    if (!absent.ok) assert.equal(absent.status, 404);
  });
  it("without a cursor returns an empty list + the current token, then new events after that", async () => {
    const client = owner();
    unwrap(await client.kanban.createBoard({ slug: "dev", name: "Dev" }));
    unwrap(await client.kanban.createTask("dev", { title: "이전" }));

    const first = unwrap(await client.events.poll({ board: "dev" }));
    assert.deepEqual(first.events, []);
    assert.ok(first.cursor);
    assert.equal(server.lastRequest()?.path, "/deskrpg/events?board=dev");

    const { task } = unwrap(await client.kanban.createTask("dev", { title: "이후" }));
    unwrap(await client.kanban.updateTask("dev", task.id, { status: "ready" }));

    const page = unwrap(await client.events.poll({ board: "dev", cursor: first.cursor }));
    assert.deepEqual(
      page.events.map((e) => e.kind),
      ["task.created", "task.status"],
    );
    assert.equal(page.events[1].task_id, task.id);
    assert.deepEqual(page.events[1].payload, {
      from: "todo",
      to: "ready",
      parent_count: 0,
      title: "이후",
      assignee: null,
    });
    assert.equal(page.has_more, false);
    assert.notEqual(page.cursor, first.cursor);

    const empty = unwrap(await client.events.poll({ board: "dev", cursor: page.cursor }));
    assert.deepEqual(empty.events, []);
  });

  it("past limit, has_more is true and the rest can be fetched", async () => {
    const client = owner();
    const start = unwrap(await client.events.poll({}));
    server.pushEvent({ kind: "cron.run.started", profile: "sophie", payload: { job_id: "j1" } });
    server.pushEvent({ kind: "cron.run.finished", profile: "sophie", payload: { job_id: "j1" } });
    server.pushEvent({ kind: "cron.run.started", profile: "sophie", payload: { job_id: "j2" } });

    const p1 = unwrap(await client.events.poll({ cursor: start.cursor, limit: 2 }));
    assert.equal(p1.events.length, 2);
    assert.equal(p1.has_more, true);
    assert.equal(server.lastRequest()?.path, `/deskrpg/events?cursor=${start.cursor}&limit=2`);
    const p2 = unwrap(await client.events.poll({ cursor: p1.cursor, limit: 2 }));
    assert.equal(p2.events.length, 1);
    assert.equal(p2.has_more, false);
  });

  it("the board filter drops events from other boards", async () => {
    const client = owner();
    const start = unwrap(await client.events.poll({ board: "a" }));
    server.pushEvent({ kind: "task.created", board: "a", task_id: "t1", payload: {} });
    server.pushEvent({ kind: "task.created", board: "b", task_id: "t2", payload: {} });
    const page = unwrap(await client.events.poll({ board: "a", cursor: start.cursor }));
    assert.deepEqual(
      page.events.map((e) => e.task_id),
      ["t1"],
    );
  });

  it("an unknown cursor folds into 400 unknown_cursor", async () => {
    const res = await owner().events.poll({ cursor: "nope" });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.status, 400);
    assert.equal(res.failure.code, "unknown_cursor");
  });
});

describe("profile client — cron", () => {
  it("every cron path uses the /p/sophie/ prefix and the profile key", async () => {
    const api = sophie().cron;

    const created = unwrap(
      await api.createJob({ schedule: "every 30m", prompt: "정리해", name: "정리" }),
    );
    assert.equal(created.job.name, "정리");
    assert.equal(created.job.state, "scheduled");
    assert.equal(created.job.enabled, true);
    assert.equal(server.lastRequest()?.path, "/p/sophie/deskrpg/cron/jobs");
    assert.equal(server.lastRequest()?.auth, `Bearer ${SOPHIE}`);
    const id = created.job.id;

    const got = unwrap(await api.getJob(id));
    assert.equal(got.job.id, id);

    const updated = unwrap(await api.updateJob(id, { updates: { name: "새 이름", model: null } }));
    assert.equal(updated.job.name, "새 이름");
    assert.equal(updated.job.model, null);
    assert.equal(server.lastRequest()?.method, "PUT");

    const paused = unwrap(await api.pauseJob(id));
    assert.equal(paused.job.state, "paused");
    assert.equal(paused.job.enabled, false);
    const listedDefault = unwrap(await api.listJobs());
    assert.equal(listedDefault.jobs.length, 0, "비활성 잡은 include_disabled 없이는 안 보인다");
    const listedAll = unwrap(await api.listJobs({ includeDisabled: true }));
    assert.equal(listedAll.jobs.length, 1);
    assert.equal(server.lastRequest()?.path, "/p/sophie/deskrpg/cron/jobs?include_disabled=true");

    const resumed = unwrap(await api.resumeJob(id));
    assert.equal(resumed.job.state, "scheduled");

    const run = unwrap(await api.runJob(id));
    assert.deepEqual(run, { accepted: true });
    assert.equal(server.lastRequest()?.status, 202);

    const runs = unwrap(await api.listRuns(id, { limit: 5 }));
    assert.equal(runs.runs.length, 1);
    assert.equal(server.lastRequest()?.path, `/p/sophie/deskrpg/cron/jobs/${id}/runs?limit=5`);

    const deleted = unwrap(await api.deleteJob(id));
    assert.deepEqual(deleted, { ok: true });
    const gone = await api.getJob(id);
    assert.equal(gone.ok, false);
    if (gone.ok) return;
    assert.equal(gone.status, 404);
  });

  it("delivery targets·blueprints·instantiation", async () => {
    const api = sophie().cron;
    server.setDeliveryTargets("sophie", [
      { id: "slack", name: "Slack", home_target_set: true, home_env_var: "SLACK_HOME" },
    ]);
    const targets = unwrap(await api.listDeliveryTargets());
    assert.equal(targets.targets[0].id, "slack");

    server.setBlueprints("sophie", [
      {
        key: "daily-digest",
        title: "일일 요약",
        description: "",
        category: "digest",
        tags: [],
        fields: [{ name: "time", type: "time", label: "시각", default: "09:00" }],
        command: "digest",
        appUrl: "/automations/daily-digest",
      },
    ]);
    const blueprints = unwrap(await api.listBlueprints());
    assert.equal(blueprints.blueprints[0].key, "daily-digest");

    const job = unwrap(
      await api.instantiateBlueprint({ blueprint: "daily-digest", values: { time: "10:00" } }),
    );
    assert.equal(job.job.name, "일일 요약");
    assert.equal(server.lastRequest()?.path, "/p/sophie/deskrpg/cron/blueprints/instantiate");

    const unknown = await api.instantiateBlueprint({ blueprint: "nope", values: {} });
    assert.equal(unknown.ok, false);
    if (unknown.ok) return;
    assert.equal(unknown.status, 404);
  });

  it("cron run events appear in the unified event stream", async () => {
    const start = unwrap(await owner().events.poll({}));
    const { job } = unwrap(
      await sophie().cron.createJob({ schedule: "every 1h", prompt: "p", name: "n" }),
    );
    unwrap(await sophie().cron.runJob(job.id));
    const page = unwrap(await owner().events.poll({ cursor: start.cursor }));
    assert.deepEqual(
      page.events.map((e) => e.kind),
      ["cron.run.started", "cron.run.finished"],
    );
    assert.equal(page.events[0].profile, "sophie");
    assert.equal(page.events[0].job_id, job.id);
    assert.equal(page.events[1].payload.status, "ok");
  });
});

describe("path encoding", () => {
  it("URL-encodes profile name·board·id", async () => {
    const client = createProfilePluginClient({
      baseUrl: server.baseUrl,
      profileName: "a b",
      profileToken: "x",
    });
    await client.cron.getJob("j/1");
    assert.equal(server.lastRequest()?.path, "/p/a%20b/deskrpg/cron/jobs/j%2F1");

    await owner().kanban.getTask("b?x", "t&1");
    assert.equal(server.lastRequest()?.path, "/deskrpg/kanban/tasks/t%261?board=b%3Fx");
  });
});
