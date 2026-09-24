import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

const home = mkdtempSync(path.join(tmpdir(), "setup-route-"));
process.env.DESKRPG_HOME = home;
process.env.SQLITE_PATH = path.join(home, "test.db");
process.env.DB_TYPE = "sqlite";
process.on("exit", () => rmSync(home, { recursive: true, force: true }));
const url = "http://localhost:3102/api/gateways/setup";
function req(userId?: string, body?: unknown, origin = "http://localhost:3102") {
  return new NextRequest(url, {
    method: body ? "POST" : "GET",
    headers: {
      host: "localhost:3102",
      origin,
      "content-type": "application/json",
      ...(userId ? { "x-user-id": userId } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function user(role: string) {
  const { db, users } = await import("@/db");
  const [row] = await db
    .insert(users)
    .values({
      loginId: randomUUID(),
      nickname: `Setup-${randomUUID()}`,
      passwordHash: "test-only",
      systemRole: role,
    })
    .returning();
  return row.id;
}
test("actual setup route rejects anonymous, ordinary user and disabled operator before discovery", async () => {
  const { GET, POST } = await import("./setup/route");
  assert.equal((await GET(req())).status, 401);
  const ordinary = await user("user"),
    admin = await user("system_admin");
  process.env.DESKRPG_HOST_SETUP_ENABLED = "1";
  const denied = await POST(req(ordinary, { action: "discover", mode: "local" }));
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).errorCode, "setup_forbidden");
  // Since 2026-09-19 admins are allowed by default — refused only when the operator turned it off with 0.
  process.env.DESKRPG_HOST_SETUP_ENABLED = "0";
  assert.equal((await POST(req(admin, { action: "discover", mode: "local" }))).status, 403);
  const cap = await (await GET(req(admin))).json();
  assert.equal(cap.local, false);
  assert.equal(cap.localReason, "disabled");
  assert.equal(cap.hostLabel, "");
  assert.deepEqual(cap.sshHosts, []);
  delete process.env.DESKRPG_HOST_SETUP_ENABLED;
});
test("actual mutation route requires same origin even for administrator", async () => {
  const { POST } = await import("./setup/route");
  const admin = await user("system_admin");
  const result = await POST(
    req(admin, { action: "discover", mode: "local" }, "https://evil.example"),
  );
  assert.equal(result.status, 403);
  assert.equal((await result.json()).errorCode, "setup_bad_origin");
});
test("job progress and cancellation cannot be accessed by another user", async () => {
  const { GET, POST } = await import("./setup/route");
  const { SetupJobStore } = await import("@/lib/hermes/setup/store");
  const owner = await user("system_admin"),
    stranger = await user("system_admin");
  const jobs = new SetupJobStore(),
    job = jobs.create(owner);
  const read = await GET(
    new NextRequest(`${url}?job=${job.id}`, { headers: { "x-user-id": stranger } }),
  );
  assert.equal(read.status, 404);
  assert.equal((await POST(req(stranger, { action: "cancel", jobId: job.id }))).status, 404);
  assert.equal(jobs.cancelled(owner, job.id), false);
});
test("an invalid timezone is rejected with 400 before touching the host", async () => {
  const { POST } = await import("./setup/route");
  const admin = await user("system_admin");
  const result = await POST(
    req(admin, {
      action: "prepare",
      mode: "local",
      candidateId: "a".repeat(64),
      profiles: [],
      timezone: "Asia Seoul",
    }),
  );
  assert.equal(result.status, 400);
  assert.equal((await result.json()).errorCode, "timezone_invalid");
});
test("the prepare request proceeds as is without a timezone", async () => {
  const { POST } = await import("./setup/route");
  const admin = await user("system_admin");
  // The operator turned the switch off, so after passing timezone validation it stops at the permission gate.
  process.env.DESKRPG_HOST_SETUP_ENABLED = "0";
  const result = await POST(
    req(admin, {
      action: "prepare",
      mode: "local",
      candidateId: "a".repeat(64),
      profiles: [],
    }),
  );
  assert.equal((await result.json()).errorCode, "setup_forbidden");
  delete process.env.DESKRPG_HOST_SETUP_ENABLED;
});
test("a non-boolean worker propagation checkbox value is 400 before touching the host", async () => {
  const { POST } = await import("./setup/route");
  const admin = await user("system_admin");
  for (const workerPropagation of ["yes", 1, {}]) {
    const result = await POST(
      req(admin, {
        action: "prepare",
        mode: "local",
        candidateId: "a".repeat(64),
        profiles: [],
        workerPropagation,
      }),
    );
    assert.equal(result.status, 400, JSON.stringify(workerPropagation));
    assert.equal((await result.json()).errorCode, "setup_invalid_request");
  }
});
test("worker propagation checkbox true and false pass validation", async () => {
  const { POST } = await import("./setup/route");
  const admin = await user("system_admin");
  // The operator switch is off so it stops at the permission gate after validation — it never reaches the host.
  process.env.DESKRPG_HOST_SETUP_ENABLED = "0";
  try {
    for (const workerPropagation of [true, false]) {
      const result = await POST(
        req(admin, {
          action: "prepare",
          mode: "local",
          candidateId: "a".repeat(64),
          profiles: [],
          workerPropagation,
        }),
      );
      assert.equal((await result.json()).errorCode, "setup_forbidden");
    }
  } finally {
    delete process.env.DESKRPG_HOST_SETUP_ENABLED;
  }
});
