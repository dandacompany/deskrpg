import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { signJWT } from "@/lib/jwt";
import { proxy } from "./proxy";

const FORGED = { "x-user-id": "forged-user", "x-user-nickname": "forged" };

/** Header names the proxy forwards to the route, or null when it passes the request through untouched. */
function forwarded(response: Response): string[] | null {
  const list = response.headers.get("x-middleware-override-headers");
  return list === null ? null : list.split(",");
}

for (const path of [
  "/api/auth/login",
  "/api/health",
  "/auth",
  "/_next/data/x.json",
  "/assets/a.png",
]) {
  test(`a public path ${path} strips client-supplied identity headers`, async () => {
    const response = await proxy(
      new NextRequest(`https://deskrpg.com${path}`, { headers: FORGED }),
    );

    assert.equal(response.headers.get("x-middleware-next"), "1");
    const names = forwarded(response);
    assert.ok(names, "the request headers must be rewritten, not passed through");
    assert.ok(!names.includes("x-user-id"));
    assert.ok(!names.includes("x-user-nickname"));
    assert.equal(response.headers.get("x-middleware-request-x-user-id"), null);
  });
}

test("a public path keeps the other request headers", async () => {
  const response = await proxy(
    new NextRequest("https://deskrpg.com/api/auth/login", {
      headers: { ...FORGED, "content-type": "application/json" },
    }),
  );

  assert.ok(forwarded(response)?.includes("content-type"));
  assert.equal(response.headers.get("x-middleware-request-content-type"), "application/json");
});

test("an authenticated path overwrites a forged x-user-id with the token's user", async () => {
  const token = await signJWT({ userId: "real-user", nickname: "Real" });
  const response = await proxy(
    new NextRequest("https://deskrpg.com/api/channels", {
      headers: { ...FORGED, cookie: `token=${token}` },
    }),
  );

  assert.equal(response.headers.get("x-middleware-request-x-user-id"), "real-user");
  assert.equal(response.headers.get("x-middleware-request-x-user-nickname"), "Real");
});
