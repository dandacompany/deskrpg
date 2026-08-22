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
//
// 두 번째 테스트는 특정 파일이 아니라 src/lib/conversation/ 디렉토리 전체를 훑는다 —
// 이 가드가 지키는 건 "회의 경로가 tool.progress 를 발언 본문에 섞지 않는다"는 불변식이지,
// 그 핸들러가 conversation-engine.ts 안에 있어야 한다는 파일 위치가 아니다. NpcRuntime
// 추출(2026-08)로 핸들러가 npc-runtime.ts 로 옮겨갔고, 향후 리팩터(예: 채널 런타임 분리)에서
// 또 옮겨갈 수 있다 — 그때마다 이 테스트를 고치지 않아도 되게 한다.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
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
    "onToolProgress 가 답변 청크를 emit 하고 있습니다. tool.progress 는 진행 신호이지 " +
      "본문이 아닙니다 — Hermes 의 `_thinking` 은 완성된 답변 전체를 다시 보내므로 " +
      `사용자에게 같은 답이 두 번 보입니다:\n${offenders.join("\n---\n")}`,
  );
});

test("회의 경로는 tool progress 를 진행 신호로만 쓴다", () => {
  const dir = "src/lib/conversation";
  const files = readdirSync(path.join(repoRoot, dir))
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .sort();

  // 파일 하나에 정해두지 않는다 — 회의 경로의 tool.progress 소비 지점이 지금 어느 파일에
  // 있는지는 리팩터마다 바뀔 수 있다. 디렉토리 전체에서 핸들러를 찾는다.
  const found: Array<{ file: string; body: string }> = [];
  for (const file of files) {
    const src = codeOnly(read(`${dir}/${file}`));
    for (const m of src.matchAll(/onToolProgress\s*:\s*\(([^)]*)\)\s*=>\s*\{([\s\S]*?)\n\s*\},/g)) {
      found.push({ file, body: m[2] });
    }
  }

  // 0개면 회의 경로에서 tool.progress 처리 자체가 사라진 것 — 이 가드가 지키려던 대상이
  // 증발했다는 뜻이다. 2개 이상이면 두 곳에서 서로 다르게 처리한다는 뜻으로, 애초에 이
  // 회귀(1:1 은 새고 회의는 안 새는 불일치)를 낳았던 것과 같은 구조다. 둘 다 실패시킨다.
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
