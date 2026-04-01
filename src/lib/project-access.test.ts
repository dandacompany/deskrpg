import assert from "node:assert/strict";
import test from "node:test";

import { resolveOwnedProjectAccess } from "./project-access";

test("project access requires an authenticated user", () => {
  assert.deepEqual(
    resolveOwnedProjectAccess({ requestUserId: null, ownerUserId: "owner-1" }),
    { ok: false, status: 401, errorCode: "unauthorized" },
  );
});

test("project access rejects a non-owner", () => {
  assert.deepEqual(
    resolveOwnedProjectAccess({ requestUserId: "user-2", ownerUserId: "owner-1" }),
    { ok: false, status: 404, errorCode: "not_found" },
  );
});

test("project access succeeds for the owner", () => {
  assert.deepEqual(
    resolveOwnedProjectAccess({ requestUserId: "owner-1", ownerUserId: "owner-1" }),
    { ok: true },
  );
});
