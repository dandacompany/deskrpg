import assert from "node:assert/strict";
import test from "node:test";

import { normalizeCronRun } from "./cron-runs";

// Measured on staging: every history row showed "—" for its time. The plugin passes Hermes' session
// row through, and `sessions.started_at`/`ended_at` are REAL epoch seconds — while the contract (and
// the screen) expect ISO strings, so `Date.parse(1758815340.12)` was NaN.
test("epoch seconds from the session row become ISO strings", () => {
  const run = normalizeCronRun({
    id: "cron_j1_20260926_004900",
    started_at: 1790524140.25,
    ended_at: 1790524183,
    status: "ok",
    summary: "Custom reminder · Sep 26 00:49",
    result_text: "첫째 …",
  });
  assert.equal(run.started_at, new Date(1790524140250).toISOString());
  assert.equal(run.ended_at, new Date(1790524183000).toISOString());
  assert.equal(run.result_text, "첫째 …");
});

test("ISO strings and numeric strings are accepted; anything else is empty, not a crash", () => {
  assert.equal(
    normalizeCronRun({ id: "a", started_at: "2026-09-26T00:49:00+09:00" }).started_at,
    "2026-09-26T00:49:00+09:00",
  );
  assert.equal(
    normalizeCronRun({ id: "a", started_at: "1790524140" }).started_at,
    new Date(1790524140000).toISOString(),
  );
  // Milliseconds would put the run tens of thousands of years out — taken as milliseconds.
  assert.equal(
    normalizeCronRun({ id: "a", started_at: 1790524140250 }).started_at,
    new Date(1790524140250).toISOString(),
  );
  const broken = normalizeCronRun({ id: 7, started_at: "soon", ended_at: {}, status: 1 });
  assert.deepEqual(broken, {
    id: "7",
    started_at: "",
    ended_at: null,
    status: "unknown",
    summary: "",
    result_text: "",
  });
});
