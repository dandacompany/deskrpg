import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SetupJobStore } from "./store";
test("jobs are owner scoped, survive recreation and preserve cancellation", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "setup-jobs-"));
  try {
    const store = new SetupJobStore(dir);
    const job = store.create("alice");
    assert.throws(() => store.get("bob", job.id), /setup_not_found/);
    assert.throws(() => store.get("alice", "../../etc/passwd"), /setup_not_found/);
    store.cancel("alice", job.id);
    store.update("alice", job.id, { steps: ["installing_plugin"] });
    const restored = new SetupJobStore(dir);
    assert.equal(restored.cancelled("alice", job.id), true);
    assert.deepEqual(restored.get("alice", job.id).steps, ["installing_plugin"]);
    assert.equal(
      JSON.parse(readFileSync(path.join(dir, readdirSync(dir)[0]), "utf8")).job.id,
      job.id,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("target lock rejects simultaneous prepare and can be released", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "setup-lock-"));
  try {
    const store = new SetupJobStore(dir);
    const release = store.lock("local");
    assert.throws(() => new SetupJobStore(dir).lock("local"), /setup_busy/);
    release();
    store.lock("local")();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume is allowed only for the same user, same target, and a failed job", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "setup-resume-"));
  try {
    const store = new SetupJobStore(dir);
    const job = store.create("alice", '{"mode":"local"}');
    // A job still running has nothing to take over.
    assert.throws(() => store.resumable("alice", job.id, '{"mode":"local"}'), /setup_not_found/);
    store.update("alice", job.id, {
      status: "failed",
      error: "plugin_install_failed",
      completed: ["inspecting", "creating_profile"],
    });
    assert.deepEqual(store.resumable("alice", job.id, '{"mode":"local"}').completed, [
      "inspecting",
      "creating_profile",
    ]);
    // Someone else's job, a different target, or a succeeded job doesn't even reveal whether it exists.
    assert.throws(() => store.resumable("bob", job.id, '{"mode":"local"}'), /setup_not_found/);
    assert.throws(
      () => store.resumable("alice", job.id, '{"mode":"ssh","hostId":"dev"}'),
      /setup_not_found/,
    );
    store.update("alice", job.id, { status: "succeeded" });
    assert.throws(() => store.resumable("alice", job.id, '{"mode":"local"}'), /setup_not_found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("a resume job starts by inheriting the steps the previous job finished", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "setup-seed-"));
  try {
    const store = new SetupJobStore(dir);
    const resumed = store.create("alice", '{"mode":"local"}', {
      completed: ["inspecting", "inspecting", "installing_hermes"],
    });
    assert.deepEqual(resumed.completed, ["inspecting", "installing_hermes"]);
    // What the screen shows as "skipped" is a step that is in completed but not in steps.
    assert.deepEqual(resumed.steps, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
