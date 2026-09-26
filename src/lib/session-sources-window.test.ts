import assert from "node:assert/strict";
import test from "node:test";

import type { SessionSource } from "@/lib/hermes/deskrpg-plugin-types";

import { artifactSourcesUntilMs, sourcesWithin } from "./session-sources-window";

const src = (ref: string, at: string | null): SessionSource => ({
  kind: "web",
  ref,
  title: null,
  via: "web_extract",
  at,
});

const T = Date.parse("2026-09-26T10:00:00Z");
const list = [
  src("before", "2026-09-26T09:59:59Z"),
  src("same-second", "2026-09-26T10:00:00Z"),
  src("after", "2026-09-26T10:00:01Z"),
  src("undated", null),
  src("garbled", "not a time"),
];

test("only sources first read up to the window end are kept, same second included", () => {
  assert.deepEqual(
    sourcesWithin(list, { toMs: T + 500 }).map((s) => s.ref),
    ["before", "same-second", "undated", "garbled"],
  );
});

test("a run window drops what was read before it started and after it ended", () => {
  assert.deepEqual(
    sourcesWithin(list, { fromMs: T, toMs: T }).map((s) => s.ref),
    ["same-second", "undated", "garbled"],
  );
  assert.deepEqual(
    sourcesWithin(list, { fromMs: T, toMs: null }).map((s) => s.ref),
    ["same-second", "after", "undated", "garbled"],
  );
});

test("no window keeps everything", () => {
  assert.equal(sourcesWithin(list, undefined).length, list.length);
  assert.equal(sourcesWithin(list, { fromMs: null, toMs: null }).length, list.length);
});

test("an artifact's window ends at the agent's last save, not a person's edit", () => {
  const detail = {
    artifact: { created_at: 100 },
    versions: [
      { created_at: 100, captured_via: "tool" },
      { created_at: 300, captured_via: "hook" },
      { created_at: 900, captured_via: "edit" },
    ],
  };
  assert.equal(artifactSourcesUntilMs(detail), 300_000);
  assert.equal(
    artifactSourcesUntilMs({ ...detail, versions: [{ created_at: 900, captured_via: "edit" }] }),
    100_000,
  );
});
