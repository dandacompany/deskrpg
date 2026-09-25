import test from "node:test";
import assert from "node:assert/strict";

import type { McpServerView, McpTool } from "@/lib/hermes/plugin-client-types";

import { cardState, quickAction, staleServers } from "./connector-view-model";

const base: McpServerView = {
  name: "gh",
  kind: "custom",
  transport: "http",
  endpointSummary: "gh.example/mcp",
  enabled: true,
  trust: "full",
  auth: "none",
  secrets: [],
  oauthTokenPresent: false,
  tools: null,
  lastCheck: null,
  revision: "r",
};

test("card state follows the spec table", () => {
  assert.equal(cardState({ ...base, enabled: false }, false), "off");
  assert.equal(cardState(base, true), "checking");
  assert.equal(cardState(base, false), "unchecked");
  assert.equal(cardState({ ...base, lastCheck: { at: "x", ok: true } }, false), "connected");
  assert.equal(
    cardState({ ...base, lastCheck: { at: "x", ok: false, error: "boom" } }, false),
    "error",
  );
  assert.equal(
    cardState(
      { ...base, lastCheck: { at: "x", ok: false, error: "HTTP 401 Unauthorized" } },
      false,
    ),
    "needsAuth",
  );
  assert.equal(
    cardState({ ...base, auth: "oauth", lastCheck: { at: "x", ok: true } }, false),
    "needsAuth",
  );
  assert.equal(
    cardState(
      { ...base, secrets: [{ key: "K", hasValue: false }], lastCheck: { at: "x", ok: true } },
      false,
    ),
    "needsAuth",
  );
});

const tools: McpTool[] = [
  { name: "read_a", description: "", readOnlyHint: true, destructiveHint: null, on: true },
  { name: "drop_b", description: "", readOnlyHint: null, destructiveHint: true, on: true },
  { name: "write_c", description: "", readOnlyHint: null, destructiveHint: null, on: false },
];

test("quick actions compute an include list", () => {
  assert.deepEqual(quickAction(tools, "all").include, ["read_a", "drop_b", "write_c"]);
  assert.deepEqual(quickAction(tools, "noDestructive").include, ["read_a", "write_c"]);
  assert.deepEqual(quickAction(tools, "readOnly").include, ["read_a"]);
});

test("stale servers are enabled ones older than five minutes or never checked", () => {
  const now = Date.parse("2026-09-25T00:10:00Z");
  const s = (name: string, at: string | null, enabled = true): McpServerView => ({
    ...base,
    name,
    enabled,
    lastCheck: at ? { at, ok: true } : null,
  });
  assert.deepEqual(
    staleServers(
      [
        s("fresh", "2026-09-25T00:08:00Z"),
        s("old", "2026-09-25T00:01:00Z"),
        s("never", null),
        s("off", null, false),
      ],
      now,
    ),
    ["old", "never"],
  );
});
