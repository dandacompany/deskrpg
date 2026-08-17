// src/server/single-session.test.ts
//
// Unit coverage for the pure decision function behind single-session-per-user
// enforcement (getSocketIdsToKick). See socket-event-parity.test.ts for the
// companion structural guard that pins the session:kicked emit itself.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { getSocketIdsToKick } from "./socket-handlers";

describe("getSocketIdsToKick", () => {
  test("kicks a single prior session", () => {
    assert.deepEqual(getSocketIdsToKick(["old-1"], "new-1"), ["old-1"]);
  });

  test("kicks every prior session, not just the latest", () => {
    // The original server.js implementation only ever tracked the most
    // recent socket id per user (a single-value map), so a user with two
    // stale sessions would leak one. getSocketIdsForUser scans all players,
    // so this must kick all of them.
    assert.deepEqual(
      getSocketIdsToKick(["old-1", "old-2", "old-3"], "new-1"),
      ["old-1", "old-2", "old-3"],
    );
  });

  test("never includes the joining socket itself", () => {
    assert.deepEqual(getSocketIdsToKick(["new-1"], "new-1"), []);
    assert.deepEqual(getSocketIdsToKick(["old-1", "new-1"], "new-1"), ["old-1"]);
  });

  test("returns an empty list when there is no prior session", () => {
    assert.deepEqual(getSocketIdsToKick([], "new-1"), []);
  });
});
