import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

const home = mkdtempSync(path.join(tmpdir(), "reset-password-route-"));
process.env.DESKRPG_HOME = home;
process.env.SQLITE_PATH = path.join(home, "test.db");
process.env.DB_TYPE = "sqlite";
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const req = (targetId: string, actorId?: string) =>
  new NextRequest(`http://localhost:3102/api/admin/users/${targetId}/reset-password`, {
    method: "POST",
    headers: { host: "localhost:3102", ...(actorId ? { "x-user-id": actorId } : {}) },
  });

const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function seedUser(role = "user") {
  const { db, users } = await import("@/db");
  const { hashPassword } = await import("@/lib/password");
  const [row] = await db
    .insert(users)
    .values({
      loginId: randomUUID(),
      nickname: `Reset-${randomUUID()}`,
      passwordHash: await hashPassword("original-password"),
      systemRole: role,
    })
    .returning();
  return row;
}

async function readUser(id: string) {
  const { db, users } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row;
}

test("anonymous and regular users cannot reset, and the target hash is unchanged", async () => {
  const { POST } = await import("./route");
  const target = await seedUser();

  const anonymous = await POST(req(target.id), params(target.id));
  assert.equal(anonymous.status, 401);

  const ordinary = await seedUser();
  const denied = await POST(req(target.id, ordinary.id), params(target.id));
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).errorCode, "system_admin_required");

  assert.equal((await readUser(target.id)).passwordHash, target.passwordHash);
});

test("an admin gets the temporary password once and the target is put into forced-change state", async () => {
  const { POST } = await import("./route");
  const admin = await seedUser("system_admin");
  const target = await seedUser();

  const response = await POST(req(target.id, admin.id), params(target.id));
  assert.equal(response.status, 200);

  const payload = (await response.json()) as {
    temporaryPassword: string;
    user: { id: string; loginId: string; nickname: string };
  };
  assert.equal(payload.user.id, target.id);
  assert.equal(payload.user.loginId, target.loginId);
  assert.ok(payload.temporaryPassword.length >= 12);

  const stored = await readUser(target.id);
  assert.notEqual(stored.passwordHash, target.passwordHash);
  assert.equal(stored.mustChangePassword, true);

  // The temporary password is not stored in plaintext — only the hash remains.
  assert.notEqual(stored.passwordHash, payload.temporaryPassword);
  const { verifyPassword } = await import("@/lib/password");
  assert.ok(await verifyPassword(payload.temporaryPassword, stored.passwordHash));
});

test("the temporary password differs every time and satisfies the account password policy", async () => {
  const { POST } = await import("./route");
  const { isAccountPasswordValid } = await import("@/lib/security-policy");
  const admin = await seedUser("system_admin");
  const target = await seedUser();

  const first = await (await POST(req(target.id, admin.id), params(target.id))).json();
  const second = await (await POST(req(target.id, admin.id), params(target.id))).json();

  assert.notEqual(first.temporaryPassword, second.temporaryPassword);
  assert.ok(isAccountPasswordValid(first.temporaryPassword));
});

test("resetting a nonexistent user is 404", async () => {
  const { POST } = await import("./route");
  const admin = await seedUser("system_admin");
  const missing = randomUUID();

  const response = await POST(req(missing, admin.id), params(missing));

  assert.equal(response.status, 404);
  assert.equal((await response.json()).errorCode, "user_not_found");
});
