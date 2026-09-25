import assert from "node:assert/strict";
import test from "node:test";

import { isAutoRunTitle, runStatusKey } from "./cron-run-view";

// Hermes titles each cron session "<job name> · <%b %d %H:%M>" (cron/scheduler.py), or
// "cron <job id>" as a fallback. That repeats the job and the time the row already shows.
test("Hermes' automatic session titles are recognised; anything else is kept", () => {
  assert.equal(isAutoRunTitle("Custom reminder · Sep 26 01:24"), true);
  assert.equal(isAutoRunTitle("아침 브리핑 · Oct 03 08:00"), true);
  assert.equal(isAutoRunTitle("cron 3f9a2c1b"), true);
  assert.equal(isAutoRunTitle("오늘 할 일 세 가지 정리"), false);
  assert.equal(isAutoRunTitle("Sep 26 01:24"), false);
  assert.equal(isAutoRunTitle(""), false);
});

test("run and last-run statuses share one set of labels", () => {
  assert.equal(runStatusKey("ok"), "cron.runs.status.ok");
  assert.equal(runStatusKey("error"), "cron.runs.status.error");
  assert.equal(runStatusKey("running"), "cron.runs.status.running");
  assert.equal(runStatusKey("weird"), "cron.runs.status.unknown");
  assert.equal(runStatusKey(null), "cron.runs.status.unknown");
});
