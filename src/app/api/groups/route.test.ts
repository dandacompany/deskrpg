import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

const home = mkdtempSync(path.join(tmpdir(), "groups-route-"));
process.env.DESKRPG_HOME = home;
process.env.SQLITE_PATH = path.join(home, "test.db");
process.env.DB_TYPE = "sqlite";
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const req = (userId: string) =>
  new NextRequest("http://localhost:3102/api/groups", {
    headers: { host: "localhost:3102", "x-user-id": userId },
  });

async function seedUser(role: string) {
  const { db, users } = await import("@/db");
  const [row] = await db
    .insert(users)
    .values({
      loginId: randomUUID(),
      nickname: `Groups-${randomUUID()}`,
      passwordHash: "test-only",
      systemRole: role,
    })
    .returning();
  return row.id;
}

test("the list response tells whether the caller is a system admin", async () => {
  const { GET } = await import("./route");

  const admin = await seedUser("system_admin");
  assert.equal((await (await GET(req(admin))).json()).isSystemAdmin, true);

  const ordinary = await seedUser("user");
  assert.equal((await (await GET(req(ordinary))).json()).isSystemAdmin, false);
});

test("creating a group with a non-JSON body is a 400, not a server error", async () => {
  const { POST } = await import("./route");
  const admin = await seedUser("system_admin");

  const response = await POST(
    new NextRequest("http://localhost:3102/api/groups", {
      method: "POST",
      headers: { host: "localhost:3102", "x-user-id": admin, "content-type": "application/json" },
      body: "not json",
    }),
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).errorCode, "missing_required_fields");
});
