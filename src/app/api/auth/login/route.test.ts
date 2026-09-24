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
