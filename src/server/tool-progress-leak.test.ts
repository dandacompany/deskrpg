// src/server/tool-progress-leak.test.ts
//
// TOOL PROGRESS LEAK GUARD
// ------------------------
// Hermes's tool.progress is a progress signal meaning "the agent is still alive". Measured (v0.20.2):
// the `_thinking` tool sends the **entire** finished answer once more in its delta:
//
//   assistant.delta "app"/"le"/"pi"/"e"
//   tool.progress   tool_name="_thinking"  delta="applepie"   ← resent whole
//   assistant.completed content="applepie"
//
// Because the 1:1 conversation path emitted this preview verbatim as a chat chunk, the answer appeared exactly
// twice on screen. The meeting path (ConversationEngine) used the same callback only for timeout.touch()
// from the start — the adapter was right; only one of its two consumers was off.
//
// An adapter unit test cannot catch this regression (the adapter always split the two channels).
// The defect is at the consumption point, so we look at the consumption point directly.
//
// The second test scans the whole src/lib/conversation/ directory rather than a specific file —
// what this guard protects is the invariant "the meeting path does not mix tool.progress into utterance bodies",
// not the file location requiring the handler to be in conversation-engine.ts. The NpcRuntime
// extraction (2026-08) moved the handler to npc-runtime.ts, and future refactors (e.g. splitting a channel runtime)
// may move it again — this keeps the test from needing edits each time.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function read(relPath: string): string {
  return readFileSync(path.join(repoRoot, relPath), "utf8");
}

/** Keeps only executable code with comments stripped — so examples in prose do not cause false positives. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

test("the 1:1 conversation path does not leak tool progress into answer chunks", () => {
  const src = codeOnly(read("src/server/socket-handlers.ts"));

  // Emitting responseEvent inside the onToolProgress callback body pollutes the body stream.
  const offenders: string[] = [];
  for (const m of src.matchAll(/onToolProgress\s*:\s*\(([^)]*)\)\s*=>\s*\{([\s\S]*?)\n\s*\},/g)) {
    const body = m[2];
    if (/socket\.emit\s*\(\s*responseEvent/.test(body) || /chunk\s*:\s*preview/.test(body)) {
      offenders.push(body.trim().slice(0, 120));
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "onToolProgress 가 답변 청크를 emit 하고 있습니다. tool.progress 는 진행 신호이지 " +
      "본문이 아닙니다 — Hermes 의 `_thinking` 은 완성된 답변 전체를 다시 보내므로 " +
      `사용자에게 같은 답이 두 번 보입니다:\n${offenders.join("\n---\n")}`,
  );
});

test("the meeting path uses tool progress only as a progress signal", () => {
  const dir = "src/lib/conversation";
  const files = readdirSync(path.join(repoRoot, dir))
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .sort();

  // Not pinned to one file — which file holds the meeting path's tool.progress consumption point
  // can change with each refactor. Search the whole directory for the handler.
  const found: Array<{ file: string; body: string }> = [];
  for (const file of files) {
    const src = codeOnly(read(`${dir}/${file}`));
    for (const m of src.matchAll(/onToolProgress\s*:\s*\(([^)]*)\)\s*=>\s*\{([\s\S]*?)\n\s*\},/g)) {
      found.push({ file, body: m[2] });
    }
  }

  // Zero means tool.progress handling vanished from the meeting path — the thing this guard was protecting
  // has evaporated. Two or more means two places handle it differently, which is the same structure
  // that produced this regression in the first place (1:1 leaks, meeting does not). Both fail.
  assert.equal(
    found.length,
    1,
    found.length === 0
      ? `${dir}/ 안 어디에서도 onToolProgress 핸들러를 찾지 못했습니다 — 회의 경로가 ` +
          "tool.progress 를 더 이상 처리하지 않게 됐거나, 핸들러 모양이 이 정규식과 달라졌습니다."
      : `${dir}/ 안에서 onToolProgress 핸들러를 ${found.length}개 찾았습니다 ` +
          `(${found.map((f) => f.file).join(", ")}) — 회의 경로가 tool.progress 를 두 곳에서 ` +
          "서로 다르게 처리하고 있을 수 있습니다. 정확히 한 곳에서만 처리해야 합니다.",
  );

  const [{ file, body }] = found;
  assert.doesNotMatch(
    body,
    /onTurnChunk|rawText\s*\+=|onChunk/,
    `회의 경로(${dir}/${file})가 tool progress 를 발언 본문에 섞고 있습니다 — 1:1 에서 고친 ` +
      "것과 같은 결함입니다.",
  );
});
