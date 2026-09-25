import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

const home = mkdtempSync(path.join(tmpdir(), "login-route-"));
process.env.DESKRPG_HOME = home;
process.env.SQLITE_PATH = path.join(home, "test.db");
process.env.DB_TYPE = "sqlite";
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const req = (body: unknown) =>
  new NextRequest("http://localhost:3102/api/auth/login", {
    method: "POST",
    headers: { host: "localhost:3102", "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function seedUser(mustChangePassword: boolean) {
  const { db, users } = await import("@/db");
  const { hashPassword } = await import("@/lib/password");
  const [row] = await db
    .insert(users)
    .values({
      loginId: randomUUID(),
      nickname: `Login-${randomUUID()}`,
      passwordHash: await hashPassword("original-password"),
      mustChangePassword,
    })
    .returning();
  return row;
}

test("logging in with a temporary password makes the login response require a change", async () => {
  const { POST } = await import("./route");
  const user = await seedUser(true);

  const response = await POST(req({ loginId: user.loginId, password: "original-password" }));

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.user.mustChangePassword, true);
});

test("a normal login does not require a change", async () => {
  const { POST } = await import("./route");
  const user = await seedUser(false);

  const response = await POST(req({ loginId: user.loginId, password: "original-password" }));

  const payload = await response.json();
  assert.equal(payload.user.mustChangePassword, false);
});

const rawReq = (body?: string) =>
  new NextRequest("http://localhost:3102/api/auth/login", {
    method: "POST",
    headers: { host: "localhost:3102", "content-type": "application/json" },
    body,
  });

for (const [name, body] of [
  ["an empty body", undefined],
  ["a non-JSON body", "loginId=a"],
  ["a JSON array", "[]"],
] as const) {
  test(`logging in with ${name} is a 400, not a server error`, async () => {
    const { POST } = await import("./route");

    const response = await POST(rawReq(body));

    assert.equal(response.status, 400);
    assert.equal((await response.json()).errorCode, "invalid_request_body");
  });
}

test("logging in with a non-string password gets the missing-field answer", async () => {
  const { POST } = await import("./route");
  const user = await seedUser(false);

  const response = await POST(req({ loginId: user.loginId, password: 12345678 }));

  assert.equal(response.status, 400);
  assert.equal((await response.json()).errorCode, "login_id_password_required");
});
