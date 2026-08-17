// src/server/socket-event-parity.test.ts
//
// SOCKET EVENT PARITY GUARD
// -------------------------
// 프로덕션은 `node server.js`, 개발은 `npx tsx dev-server.ts` → socket-handlers.ts 를 쓴다.
// 2026-08 이전까지 두 파일은 각자 핸들러를 갖고 있었고, 한쪽에만 기능이 추가되는
// 드리프트가 실제로 발생했다(프로덕션에 Hermes/CLI 어댑터 디스패치가 없었다).
// P1b에서 server.js 가 setupSocketHandlers 를 호출하도록 통합했으므로,
// 이 테스트는 server.js 안에 소켓 핸들러가 다시 생겨나는 것을 막는다.
//
// 추출 정규식은 `/socket\.on\(\s*"([^"]+)"/g` — `\s*`가 개행을 포함하므로
// socket.on(\n  "player:join",\n  ...) 같은 여러 줄 등록도 잡는다. 실측 확인:
// socket-handlers.ts에서 `\s*` 없는 단순 단일행 정규식은 18개만 잡지만
// 이 정규식은 23개를 잡는다 — multi-line 등록을 놓치는 위험이 이 파일에
// 실제로 존재한다는 뜻이다. 아래 별도 테스트가 이 위험을 직접 가드한다.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function socketEventsIn(relPath: string): string[] {
  const src = readFileSync(path.join(repoRoot, relPath), "utf8");
  const events = new Set<string>();
  for (const m of src.matchAll(/socket\.on\(\s*"([^"]+)"/g)) events.add(m[1]);
  return [...events].sort();
}

test("server.js registers no socket handlers of its own", () => {
  const events = socketEventsIn("server.js");
  assert.deepEqual(
    events,
    [],
    `server.js가 소켓 핸들러를 직접 등록하고 있습니다: ${events.join(", ")}\n`
      + "핸들러는 src/server/socket-handlers.ts 한 곳에만 있어야 합니다 "
      + "(server.js는 setupSocketHandlers(io)를 호출하기만 합니다).",
  );
});

test("server.js delegates to setupSocketHandlers", () => {
  const src = readFileSync(path.join(repoRoot, "server.js"), "utf8");
  assert.match(
    src,
    /setupSocketHandlers\s*\(/,
    "server.js가 setupSocketHandlers를 호출하지 않습니다 — 소켓 핸들러가 배선되지 않았습니다.",
  );
});

test("socket-handlers still registers the events server.js used to own", () => {
  const events = socketEventsIn("src/server/socket-handlers.ts");
  for (const required of [
    "player:join", "player:move", "chat:send",
    "map:object-add", "map:object-remove", "map:tiles-update",
    "npc:chat", "npc:position-update",
  ]) {
    assert.ok(
      events.includes(required),
      `socket-handlers.ts에 "${required}" 핸들러가 없습니다 — 프로덕션에서 그 기능이 사라집니다.`,
    );
  }
});

test("server.js invalidates the socket-handlers gateway cache on config-updated", () => {
  // P1b 통합 이후, 게이트웨이 연결 캐시가 두 곳으로 갈라졌다:
  //   - server.js의 channelGateways (channelId 키, /_internal/rpc 전용)
  //   - socket-handlers.ts의 channelGateways (gatewayId 키, NPC 대화 전용)
  // /_internal/emit의 gateway:config-updated 분기는 원래 앞쪽만 지웠다 —
  // 토큰/URL을 바꿔도 NPC 대화 경로는 죽은 연결을 계속 쓰는 조용한 회귀였다.
  // socket-handlers.ts가 내보내는 invalidateGatewayConnectionForChannel을
  // server.js가 호출한다는 사실만 단언한다 — 앞으로 이 호출이 빠지면
  // 이 테스트가 실패한다.
  const src = readFileSync(path.join(repoRoot, "server.js"), "utf8");
  assert.match(
    src,
    /invalidateGatewayConnectionForChannel/,
    "server.js가 invalidateGatewayConnectionForChannel을 호출하지 않습니다 — "
      + "gateway:config-updated 시 socket-handlers.ts의 게이트웨이 캐시(gatewayId 키)가 "
      + "무효화되지 않아 NPC 대화가 오래된 연결을 계속 씁니다.",
  );
});

test("socket-handlers extraction regex captures multi-line socket.on() registrations", () => {
  // 회귀 방지: 단순 `/socket\.on\("/` 정규식은 여러 줄에 걸친
  //   socket.on(
  //     "player:join",
  //     async (data) => { ... },
  //   );
  // 형태를 놓친다. socket-handlers.ts는 실제로 "player:join"을 이 여러 줄
  // 형태로 등록한다 — 매직 카운트(예: "N개 이상")는 핸들러가 정당하게
  // 늘거나 옮겨질 때마다 깨지고, 다음 사람이 추출기 동작을 확인하지 않은
  // 채 숫자만 올려서 고치게 만든다. 그러면 가드가 있으나 마나 해진다.
  // 그래서 위험 자체를 직접 단언한다: "player:join"이 빠지면 추출기가
  // 여러 줄 등록을 못 잡는 것이고, 이 가드 전체를 신뢰할 수 없다는 뜻이다.
  const events = socketEventsIn("src/server/socket-handlers.ts");
  assert.ok(
    events.includes("player:join"),
    "socket-handlers.ts에서 \"player:join\"을 추출하지 못했습니다 — "
      + "이 이벤트는 socket.on(\\n  \"player:join\",\\n  ...) 형태의 여러 줄 등록입니다. "
      + "추출 정규식이 개행을 포함한 socket.on(...) 등록을 놓치고 있다는 뜻이며, "
      + "이 파일의 다른 어서션들도 신뢰할 수 없습니다 — 정규식부터 고치세요.",
  );
});
