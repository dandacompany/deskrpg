import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { hasRunProvenance, runProvenance, workspaceRelative } from "./kanban-run-provenance";

const WS = "/home/u/.hermes/kanban/boards/b/workspaces/t_1";

describe("runProvenance", () => {
  it("reads the well-known keys and counts the rest", () => {
    const p = runProvenance(
      {
        changed_files: [`${WS}/draft.md`, `${WS}/notes/a.md`, `${WS}/draft.md`],
        artifacts: [`${WS}/out/newsletter.md`],
        verification: { file_read_back: true, total_lines: 146, note: "ok", nested: { x: 1 } },
        limitations: ["No live data", 7, ""],
        worker_session_id: "sess_1",
        included_sections: ["a"],
        terminal_provider: false,
      },
      WS,
    );
    assert.deepEqual(p.changedFiles, ["draft.md", "notes/a.md"]);
    assert.deepEqual(p.artifacts, ["out/newsletter.md"]);
    assert.deepEqual(p.checks, [
      { key: "file_read_back", value: "✓" },
      { key: "total_lines", value: "146" },
      { key: "note", value: "ok" },
    ]);
    assert.deepEqual(p.limitations, ["No live data"]);
    assert.equal(p.workerSessionId, "sess_1");
    assert.equal(p.otherKeys, 1);
    assert.equal(hasRunProvenance(p), true);
  });

  it("shows only the file name for paths outside the working folder", () => {
    const p = runProvenance(
      { changed_files: ["/etc/secret/app.conf", "../t_2/x.md", "rel/y.md"] },
      WS,
    );
    assert.deepEqual(p.changedFiles, ["app.conf", "x.md", "rel/y.md"]);
  });

  it("accepts objects with a path and a single limitation string", () => {
    const p = runProvenance(
      { artifacts: [{ path: `${WS}/a.md` }, { nope: 1 }], limitations: "Draft only" },
      WS,
    );
    assert.deepEqual(p.artifacts, ["a.md"]);
    assert.deepEqual(p.limitations, ["Draft only"]);
  });

  it("is empty for missing or malformed metadata", () => {
    for (const meta of [undefined, null, {}, { verification: [1, 2], changed_files: "x" }]) {
      const p = runProvenance(meta as Record<string, unknown> | undefined, WS);
      assert.equal(hasRunProvenance(p), false);
      assert.equal(p.workerSessionId, null);
    }
  });

  it("caps long text", () => {
    const p = runProvenance({ limitations: ["x".repeat(500)] }, WS);
    assert.equal(p.limitations[0].length, 300);
    assert.equal(p.limitations[0].endsWith("…"), true);
  });
});

describe("workspaceRelative", () => {
  it("strips the workspace prefix, even with a trailing slash", () => {
    assert.equal(workspaceRelative(`${WS}/a/b.md`, `${WS}/`), "a/b.md");
    assert.equal(workspaceRelative(`${WS}-other/b.md`, WS), "b.md");
    assert.equal(workspaceRelative("~/x/y.md", WS), "y.md");
    assert.equal(workspaceRelative(`${WS}/a.md`, null), "a.md");
  });
});
