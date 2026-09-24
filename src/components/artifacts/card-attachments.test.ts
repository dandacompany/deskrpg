import assert from "node:assert/strict";
import test from "node:test";

import type { ArtifactSummary } from "@/lib/hermes/deskrpg-plugin-types";

import { visibleCardAttachments, type GalleryAttachment } from "./card-attachments";

const file = (
  id: string,
  taskId: string,
  filename: string,
  title: string | null = "주간 보고",
): GalleryAttachment => ({
  id,
  filename,
  size: 1,
  task_id: taskId,
  task_title: title,
  boardSlug: "b1",
});

const artifact = (taskId: string | null, filename: string): ArtifactSummary => ({
  id: `art-${filename}`,
  kind: "document",
  title: filename,
  profile: "sophie",
  source_kind: "kanban",
  session_id: "s",
  task_id: taskId,
  current_version: 1,
  filename,
  mime: "text/markdown",
  size: 1,
  sha256: "x",
  created_at: 1,
  updated_at: 1,
});

test("if the same card's same file is also caught as an artifact, drop the attachment and keep only the artifact", () => {
  const out = visibleCardAttachments(
    [file("a1", "t1", "report.md"), file("a2", "t1", "raw.csv")],
    [artifact("t1", "report.md")],
    {},
    null,
  );
  assert.deepEqual(
    out.map((a) => a.id),
    ["a2"],
    "같은 문서가 갤러리에 두 번 나온다",
  );
});

test("even with the same filename, if it's from a different card, both are shown", () => {
  const out = visibleCardAttachments(
    [file("a1", "t2", "report.md")],
    [artifact("t1", "report.md")],
    {},
    null,
  );
  assert.equal(out.length, 1);
});

test("with a kind/source/employee filter set, attachments with no basis to filter on are hidden — the file tab is the exception", () => {
  const all = [file("a1", "t1", "x.md")];
  assert.equal(visibleCardAttachments(all, [], { category: "media" }, null).length, 0);
  assert.equal(visibleCardAttachments(all, [], { source: "chat" }, null).length, 0);
  assert.equal(visibleCardAttachments(all, [], { profile: "sophie" }, null).length, 0);
  assert.equal(visibleCardAttachments(all, [], { category: "file" }, null).length, 1);
});

test("opening from a card shows only that card's attachments, and the search term matches filename and card title", () => {
  const all = [
    file("a1", "t1", "report.md", "주간 보고"),
    file("a2", "t2", "data.csv", "매출 정리"),
  ];
  assert.deepEqual(
    visibleCardAttachments(all, [], {}, "t2").map((a) => a.id),
    ["a2"],
  );
  assert.deepEqual(
    visibleCardAttachments(all, [], { q: "매출" }, null).map((a) => a.id),
    ["a2"],
  );
  assert.deepEqual(
    visibleCardAttachments(all, [], { q: "REPORT" }, null).map((a) => a.id),
    ["a1"],
  );
});

test("tolerates a null title when the card has been deleted", () => {
  const out = visibleCardAttachments([file("a1", "t9", "orphan.md", null)], [], { q: "zzz" }, null);
  assert.deepEqual(out, []);
});
