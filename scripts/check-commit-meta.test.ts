import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const SCRIPT = path.join(process.cwd(), "scripts/check-commit-meta.sh");

function check(message: string) {
  const r = spawnSync("bash", [SCRIPT], { input: message, encoding: "utf8" });
  return { status: r.status, stderr: r.stderr };
}

test("blocks messages with session trailers, board identifiers or private doc paths", () => {
  for (const bad of [
    "fix: x\n\nClaude-Session: https://claude.ai/code/session_01AbC",
    "fix: x\n\n카드: PVTI_lAHOB6eLEc4BjrHnzg70RxQ",
    "fix: x\n\nStage 필드 PVTSSF_lAHOB6eLEc4BjrHnzhiiz9U",
    "fix: x\n\n드래프트 DI_lAHOB6eLEc4BjrHnzgLJ8c8",
    "feat: y\n\n스펙: docs/superpowers/specs/2026-09-21-x-design.md",
    "feat: y\n\ndocs/standards.md 의 규칙을 따른다",
    "feat: y\n\n(docs/engineering-notes.md 참고)",
    "chore: z\n\n.superpowers/sdd/progress.md",
  ]) {
    const r = check(bad);
    assert.equal(r.status, 1, `막지 않았다: ${bad}`);
    assert.match(r.stderr, /개발 메타/);
  }
});

test("ordinary messages and similar-but-different wording pass", () => {
  for (const ok of [
    "docs: README 의 Docker 안내를 고친다",
    "fix(ui): 크림 배경 위 옅은 팔레트 글자색 31곳\n\nCo-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>",
    "feat(app): src/app/docs/page.tsx 를 더한다",
    "fix: PVT 약어 설명",
  ]) {
    const r = check(ok);
    assert.equal(r.status, 0, `잘못 막았다: ${ok}\n${r.stderr}`);
  }
});

test("does not check the comment lines (#) that git adds", () => {
  // When committing through an editor git appends the changed file list as # comments — docs/ may show up there.
  assert.equal(check("fix: x\n\n# Changes to be committed:\n#\tmodified: docs/a.md\n").status, 0);
});
