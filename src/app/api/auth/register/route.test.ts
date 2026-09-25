import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

const home = mkdtempSync(path.join(tmpdir(), "register-route-"));
process.env.DESKRPG_HOME = home;
process.env.SQLITE_PATH = path.join(home, "test.db");
process.env.DB_TYPE = "sqlite";
delete process.env.REGISTRATION_DISABLED;
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const rawReq = (body?: string) =>
  new NextRequest("http://localhost:3102/api/auth/register", {
    method: "POST",
    headers: { host: "localhost:3102", "content-type": "application/json" },
    body,
  });

for (const [name, body] of [
  ["an empty body", undefined],
  ["a non-JSON body", "loginId=a"],
  ["a JSON array", "[]"],
] as const) {
  test(`registering with ${name} is a 400, not a server error`, async () => {
    const { POST } = await import("./route");

    const response = await POST(rawReq(body));

    assert.equal(response.status, 400);
    assert.equal((await response.json()).errorCode, "invalid_request_body");
  });
}

test("registering with a non-string field gets the missing-field answer", async () => {
  const { POST } = await import("./route");

  const response = await POST(
    rawReq(JSON.stringify({ loginId: 12345, nickname: "Someone", password: "long-password" })),
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).errorCode, "login_id_nickname_password_required");
});

test("a valid registration still succeeds", async () => {
  const { POST } = await import("./route");
  const id = randomUUID().slice(0, 12);

  const response = await POST(
    rawReq(JSON.stringify({ loginId: `u-${id}`, nickname: `N-${id}`, password: "long-password" })),
  );

  assert.equal(response.status, 200);
});
