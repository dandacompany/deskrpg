import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decideProfileRouteAccess } from "./profile-route";

const ok = { ok: true as const, profileToken: "pt" };
describe("profile route access decision", () => {
  it("no login → 401", () => {
    assert.deepEqual(
      decideProfileRouteAccess({ userId: null, accessible: null, requireOwner: false, token: ok }),
      { status: 401, errorCode: "unauthorized" },
    );
  });
  it("no gateway access → 404", () => {
    assert.deepEqual(
      decideProfileRouteAccess({ userId: "u", accessible: null, requireOwner: false, token: ok }),
      { status: 404, errorCode: "not_found" },
    );
  });
  it("owner required but shared user → 403 (before the profile token)", () => {
    assert.deepEqual(
      decideProfileRouteAccess({
        userId: "u",
        accessible: { isOwner: false },
        requireOwner: true,
        token: { ok: false, reason: "no_profile" },
      }),
      { status: 403, errorCode: "forbidden" },
    );
  });
  it("no profile token → 404 no_profile", () => {
    assert.deepEqual(
      decideProfileRouteAccess({
        userId: "u",
        accessible: { isOwner: true },
        requireOwner: true,
        token: { ok: false, reason: "no_profile" },
      }),
      { status: 404, errorCode: "no_profile" },
    );
  });
  it("passes", () => {
    assert.equal(
      decideProfileRouteAccess({
        userId: "u",
        accessible: { isOwner: false },
        requireOwner: false,
        token: ok,
      }),
      null,
    );
  });
});
