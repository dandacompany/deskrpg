import assert from "node:assert/strict";
import test from "node:test";

import { formatRequester, parseRequester } from "./approval-requester";

test("when an employee requests, it's the profile name as-is", () => {
  assert.equal(formatRequester({ kind: "profile", profileName: "sophie" }), "sophie");
});

test("when a human requests, a user: prefix is attached", () => {
  assert.equal(
    formatRequester({ kind: "user", userId: "7e0a0f1c-1111-4222-8333-444455556666" }),
    "user:7e0a0f1c-1111-4222-8333-444455556666",
  );
});

test("the prefix never collides with a profile name — a profile name can't contain a colon", () => {
  // `^[a-z0-9][a-z0-9_-]{0,63}$` (host.ts:132). So `user:` is unambiguous.
  assert.deepEqual(parseRequester("sophie"), { kind: "profile", profileName: "sophie" });
  assert.deepEqual(parseRequester("user:abc"), { kind: "user", userId: "abc" });
});

test("round-trips through the reverse read", () => {
  for (const r of [
    { kind: "profile", profileName: "noah" } as const,
    { kind: "user", userId: "u-1" } as const,
  ])
    assert.deepEqual(parseRequester(formatRequester(r)), r);
});

test("doesn't read it as a profile when nothing follows user: — treats the broken value as a human", () => {
  assert.deepEqual(parseRequester("user:"), { kind: "user", userId: "" });
});

test("fits within varchar(64)", () => {
  const longest = formatRequester({ kind: "user", userId: "7e0a0f1c-1111-4222-8333-444455556666" });
  assert.ok(longest.length <= 64, `${longest.length}자`);
});
