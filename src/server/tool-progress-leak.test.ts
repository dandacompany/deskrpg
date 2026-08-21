// src/server/tool-progress-leak.test.ts
//
// TOOL PROGRESS LEAK GUARD
// ------------------------
// Hermes 의 tool.progress 는 "에이전트가 아직 살아 있다"는 진행 신호다. 실측(v0.20.2)에서
// `_thinking` 툴은 완성된 답변 **전체**를 그 delta 에 한 번 더 실어 보낸다:
//
//   assistant.delta "사"/"과"/"딸"/"기"
//   tool.progress   tool_name="_thinking"  delta="사과딸기"   ← 통째로 다시
//   assistant.completed content="사과딸기"
//
// 1:1 대화 경로가 이 preview 를 채팅 청크로 그대로 emit 하던 탓에 화면에 답이 정확히
// 두 번 보였다. 회의 경로(ConversationEngine)는 같은 콜백을 처음부터 timeout.touch()
// 로만 썼다 — 어댑터는 옳았고, 두 소비자 중 한쪽만 어긋나 있었다.
//
// 어댑터 단위 테스트로는 이 회귀를 잡을 수 없다(어댑터는 원래부터 두 통로를 나눠 준다).
// 결함은 소비 지점에 있으므로, 소비 지점을 직접 본다.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function read(relPath: string): string {
  return readFileSync(path.join(repoRoot, relPath), "utf8");
}

/** 주석을 지운 실행 코드만 남긴다 — 설명문에 적힌 예시가 오탐을 내지 않도록. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

test("1:1 대화 경로가 tool progress 를 답변 청크로 흘리지 않는다", () => {
  const src = codeOnly(read("src/server/socket-handlers.ts"));

  // onToolProgress 콜백 본문 안에서 responseEvent 를 emit 하면 본문 스트림 오염이다.
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
    "onToolProgress 가 답변 청크를 emit 하고 있습니다. tool.progress 는 진행 신호이지 "
      + "본문이 아닙니다 — Hermes 의 `_thinking` 은 완성된 답변 전체를 다시 보내므로 "
      + `사용자에게 같은 답이 두 번 보입니다:\n${offenders.join("\n---\n")}`,
  );
});

test("회의 경로는 tool progress 를 진행 신호로만 쓴다", () => {
  const src = codeOnly(read("src/lib/conversation/conversation-engine.ts"));
  const m = src.match(/onToolProgress\s*:\s*\(([^)]*)\)\s*=>\s*\{([\s\S]*?)\n\s*\},/);

  assert.ok(m, "ConversationEngine 에서 onToolProgress 핸들러를 찾지 못했습니다.");
  assert.doesNotMatch(
    m![2],
    /onTurnChunk|rawText\s*\+=/,
    "회의 경로가 tool progress 를 발언 본문에 섞고 있습니다 — 1:1 에서 고친 것과 같은 결함입니다.",
  );
});
