import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

/**
 * If the password change API were under `/api/auth/`, the proxy would treat it as a public path and not set
 * `x-user-id` — the route would return 401 even to logged-in users (2026-09-20 measurement).
 * So it lives under `/api/account/`, and this test pins that location.
 */
test("the password change API goes through the login check rather than being a public path", async () => {
  const response = await proxy(
    new NextRequest("https://deskrpg.com/api/account/password", { method: "POST" }),
  );

  // There is no token, so it is not let through — had it been a public path, x-middleware-next would be attached.
  assert.equal(response.headers.get("x-middleware-next"), null);
});
