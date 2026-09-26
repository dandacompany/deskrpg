// src/server/socket-event-parity.test.ts
//
// SOCKET EVENT PARITY GUARD
// -------------------------
// Production runs `node server.js`, dev runs `npx tsx dev-server.ts` → both use socket-handlers.ts.
// Until 2026-08 the two files each had their own handlers, and drift where a feature was added
// to only one side actually happened (production lacked Hermes/CLI adapter dispatch).
// P1b unified them so that server.js calls setupSocketHandlers,
// and this test keeps socket handlers from reappearing inside server.js.
//
// The extraction regex is `/socket\.on\(\s*"([^"]+)"/g` — `\s*` includes newlines, so it
// also catches multi-line registrations like socket.on(\n  "player:join",\n  ...). Measured:
// on socket-handlers.ts a plain single-line regex without `\s*` catches only 18,
// while this regex catches 23 — meaning the risk of missing multi-line registrations really
// exists in this file. A separate test below guards that risk directly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function socketEventsIn(...relPaths: string[]): string[] {
  const events = new Set<string>();
  for (const relPath of relPaths) {
    const src = readFileSync(path.join(repoRoot, relPath), "utf8");
    for (const m of src.matchAll(/socket\.on\(\s*"([^"]+)"/g)) events.add(m[1]);
    // The coordinator's validated wrapper registers each literal event through socket.on(name).
    if (relPath === "src/server/npc-coordination.ts")
      for (const m of src.matchAll(/handle\(\s*"([^"]+)"/g)) events.add(m[1]);
  }
  return [...events].sort();
}

/**
 * Socket handlers no longer live in one file. socket-handlers.ts delegates room and roster handlers
 * to their modules, and each module registers its own `socket.on` — so "is this event
 * wired" must be checked across the union of the three files. Re-listing only the names inside
 * socket-handlers.ts to satisfy this guard would be a trick that creates two registration points.
 */
const HANDLER_FILES = [
  "src/server/socket-handlers.ts",
  "src/server/room-socket.ts",
  "src/server/npc-roster-socket.ts",
  "src/server/npc-coordination.ts",
];

test("server.js registers no socket handlers of its own", () => {
  const events = socketEventsIn("server.js");
  assert.deepEqual(
    events,
    [],
    `server.js가 소켓 핸들러를 직접 등록하고 있습니다: ${events.join(", ")}\n` +
      "핸들러는 src/server/socket-handlers.ts 한 곳에만 있어야 합니다 " +
      "(server.js는 setupSocketHandlers(io)를 호출하기만 합니다).",
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
  const events = socketEventsIn(...HANDLER_FILES);
  for (const required of [
    "player:join",
    "player:move",
    "room:send",
    "room:open",
    "room:create",
    "map:object-add",
    "map:object-remove",
    "map:tiles-update",
    "npc:chat",
    "npc:position-update",
    "tool-approval:decide",
    "npc:cancel-response",
    "room:cancel-response",
  ]) {
    assert.ok(
      events.includes(required),
      `"${required}" 핸들러가 어디에도 없습니다(${HANDLER_FILES.join(", ")}) — ` +
        "프로덕션에서 그 기능이 사라집니다.",
    );
  }
});

// The 2026-04 task system was retired along with its data in 2026-09 (spec R33·R34, 0012). If its socket events
// were registered again in any handler file, the server would go looking for the deleted task/report tables.
test("legacy task-system socket events are not registered anywhere", () => {
  const events = socketEventsIn(...HANDLER_FILES);
  const revived = events.filter(
    (e) => e.startsWith("task:") || e.startsWith("npc:task-") || e.startsWith("npc:report-"),
  );
  assert.deepEqual(
    revived,
    [],
    `폐기된 태스크 시스템의 소켓 이벤트가 되살아났습니다: ${revived.join(", ")}`,
  );
});

test("the runtime state cache is invalidated when gateway settings change", () => {
  // This spot originally held a guard checking "does server.js call invalidateGatewayConnectionForChannel".
  // It pinned a silent regression where the gateway connection cache was split in two (server.js keyed
  // by channelId, socket-handlers keyed by gatewayId) and only one side got cleared.
  // With OpenClaw gone, both of those WS connection pools are gone too.
  //
  // What must hold still remains: when settings change, the gateway runtime state cache must be
  // invalidated. gateway-resources.ts makes that call directly at change time — here we only check
  // that this stays true.
  const src = readFileSync(path.join(repoRoot, "src/lib/gateway-resources.ts"), "utf8");
  assert.match(
    src,
    /invalidateGatewayRuntimeState\s*\(/,
    "gateway-resources.ts 가 invalidateGatewayRuntimeState 를 호출하지 않습니다 — " +
      "게이트웨이 주소나 토큰을 바꿔도 캐시된 상태가 그대로 쓰입니다.",
  );
});

test("socket-handlers enforces single-session-per-user by emitting session:kicked", () => {
  // Regression guard for the P1b unification: pre-refactor server.js kicked
  // any prior live session for the same user account on player:join. The
  // unification onto socket-handlers.ts silently dropped that rule (dev's
  // handler never had it). This pins the emit so a future refactor that
  // drops session:kicked again fails loudly instead of surviving unnoticed.
  const src = readFileSync(path.join(repoRoot, "src/server/socket-handlers.ts"), "utf8");
  assert.match(
    src,
    /session:kicked/,
    'socket-handlers.ts가 "session:kicked"를 더 이상 emit하지 않습니다 — ' +
      "단일 세션 강제(single-session-per-user)가 다시 사라졌습니다. " +
      "player:join 핸들러에서 이전 세션을 disconnect하는 로직을 복원하세요.",
  );
});

test("socket-handlers extraction regex captures multi-line socket.on() registrations", () => {
  // Regression guard: a plain `/socket\.on\("/` regex misses the multi-line
  //   socket.on(
  //     "player:join",
  //     async (data) => { ... },
  //   );
  // form. socket-handlers.ts actually registers "player:join" in this multi-line
  // form — a magic count (e.g. "at least N") breaks whenever handlers legitimately
  // grow or move, and nudges the next person to just bump the number without checking
  // the extractor's behavior. Then the guard might as well not exist.
  // So we assert the risk itself directly: if "player:join" is missing, the extractor
  // fails to catch multi-line registrations, and this whole guard cannot be trusted.
  const events = socketEventsIn("src/server/socket-handlers.ts");
  assert.ok(
    events.includes("player:join"),
    'socket-handlers.ts에서 "player:join"을 추출하지 못했습니다 — ' +
      '이 이벤트는 socket.on(\\n  "player:join",\\n  ...) 형태의 여러 줄 등록입니다. ' +
      "추출 정규식이 개행을 포함한 socket.on(...) 등록을 놓치고 있다는 뜻이며, " +
      "이 파일의 다른 어서션들도 신뢰할 수 없습니다 — 정규식부터 고치세요.",
  );
});

// This branch's signature-defect guard: do events fired by the free-chat server have a map client listener?
//
// C1 was exactly this shape — the server fired npc:come-to-player, but the client listener's
// condition (targetPlayerId === socket.id) could never be true, so nobody reacted.
// A name without a consumer is dead wiring that cannot be verified, so at least bind the name's existence.
test("map chat events emitted by the server have a listener in the map client", () => {
  const client = readFileSync(path.join(repoRoot, "src/app/game/GamePageClient.tsx"), "utf8");
  for (const event of ["npc:come-to-player", "room:mention-skipped", "room:npc-aborted"]) {
    // Whitespace-insensitive — even if the formatter breaks the line after `socketInstance.on(`
    // the listener is still there. A guard that goes red when only the formatting changed loses trust.
    assert.ok(
      new RegExp(`socketInstance\\.on\\(\\s*"${event}"`).test(client),
      `서버가 ${event} 를 쏘지만 맵 클라이언트에 리스너가 없습니다 — 죽은 배선입니다.`,
    );
  }
});

// Reusing meeting-only events on the map room would inject other people's map events into the transcript
// of someone in a meeting (meeting participants do not leave the map room).
test("socket-handlers never broadcasts meeting-only events to the map room", () => {
  const src = readFileSync(path.join(repoRoot, "src/server/socket-handlers.ts"), "utf8");
  // Meeting-only events themselves are fine — the problem is **which room** they are sent to. Only catch
  // meeting:* going out to a room other than the meeting room (`meeting-<id>`).
  const leaked = [...src.matchAll(/\.to\(([^)]*)\)\s*\.emit\(\s*"(meeting:[^"]+)"/g)]
    .filter((m) => !m[1].includes("meeting-"))
    .map((m) => `${m[2]} → ${m[1]}`);
  assert.deepEqual(
    leaked,
    [],
    `맵 룸 브로드캐스트에 회의 전용 이벤트가 섞였습니다: ${leaked.join(", ")}`,
  );
});

// The guard above only looks at **names**. C1 was a defect that was dead while its name was intact — the server
// sent targetPlayerId: null, and the client condition (=== socket.id) could never be true on any
// socket. So we pin each of those two ends. Without this test, a one-line mutation reverting C1
// passes all 684 tests green (measured in re-review).
test("npc:come-to-player always carries a real caller socket id", () => {
  const src = readFileSync(path.join(repoRoot, "src/server/npc-coordination.ts"), "utf8");
  assert.match(src, /targetPlayerId:\s*socket\.id/);
  const dead = [...src.matchAll(/emit\(\s*"npc:come-to-player"\s*,\s*\{([^}]*)\}/g)]
    .filter((m) => /targetPlayerId\s*:\s*(null|undefined)/.test(m[1]))
    .map((m) => m[1].trim());
  assert.deepEqual(
    dead,
    [],
    "npc:come-to-player 가 targetPlayerId 없이 나갑니다 — 클라이언트 조건이 " +
      "어떤 소켓에서도 참이 되지 않아 NPC 가 걸어오지 않습니다(무음 실패).",
  );
});

test("the map client still gates A* on being the caller", () => {
  const client = readFileSync(path.join(repoRoot, "src/app/game/GamePageClient.tsx"), "utf8");
  assert.ok(
    /data\.targetPlayerId\s*===\s*socketInstance\.id/.test(client),
    "npc:come-to-player 리스너가 호출자 판정을 잃었습니다 — 조건이 늘 거짓이면 아무도 " +
      "경로탐색을 돌리지 않고, 늘 참이면 모든 클라이언트가 같은 NPC 를 각자 움직입니다.",
  );
});

// The free-chat runtime keeps the participant list from the first summon for the channel's whole lifetime
// (unlike the meeting broker, it has no end point). If the cache is not dropped when an NPC is added, edited
// or fired, the fired NPC keeps answering and a new NPC does not come when called — it shows up not as an
// error but only as "why is it still answering", so we hold onto the wiring itself.
test("every npc:broadcast-* handler drops the room runtime cache", () => {
  const src = readFileSync(path.join(repoRoot, "src/server/socket-handlers.ts"), "utf8");
  for (const event of ["npc:broadcast-add", "npc:broadcast-update", "npc:broadcast-remove"]) {
    const start = src.indexOf(`socket.on("${event}"`);
    assert.notEqual(start, -1, `socket-handlers.ts 에 ${event} 핸들러가 없습니다.`);
    // The window must be cut **to that handler's body**. Cutting at a fixed length lets the window run
    // past the next socket.on and pass by seeing the neighboring branch's delete — the first draft
    // actually did that, and removing the update branch's invalidation did not turn it red.
    const next = src.indexOf("socket.on(", start + 1);
    const body = src.slice(start, next === -1 ? undefined : next);
    assert.ok(
      /invalidateRoomRuntimesForChannel\(/.test(body),
      `${event} 가 방 런타임 캐시를 버리지 않습니다 — 해고된 NPC 가 계속 대답합니다.`,
    );
  }
});

// Answering a probe failure with 5xx keeps the diagnosis from reaching the user — Cloudflare replaces
// the origin's 5xx with its own error page (measured: inside the container and up to Caddy the body is
// intact, but over the internet it becomes `server: cloudflare` · `body="error code: 502"`).
// So the browser got only `502 {}` and the screen showed only the generic fallback.
//
// 4xx passes through, so auth/permission responses are out of scope. This guard only stops the gateway
// test route from reverting to 5xx.
test("the gateway test route never answers with 5xx", () => {
  const src = readFileSync(path.join(repoRoot, "src/app/api/gateways/[id]/test/route.ts"), "utf8");
  const serverErrors = [...src.matchAll(/status:\s*(5\d\d)/g)].map((m) => m[1]);
  assert.deepEqual(
    serverErrors,
    [],
    "게이트웨이 테스트가 5xx 를 돌려줍니다 — Cloudflare 가 본문을 갈아치워 사용자는 " +
      `이유를 볼 수 없습니다: ${serverErrors.join(", ")}`,
  );
});

// Profiles could only be created, not edited or deleted — if you entered a wrong token there was
// no way to fix it from the UI, a dead end. The gateway side had PATCH·DELETE but the profile
// side did not, an asymmetry between resources.
test("hermes profiles support edit and delete, not just create", () => {
  const src = readFileSync(
    path.join(repoRoot, "src/app/api/gateways/[id]/profiles/[profileId]/route.ts"),
    "utf8",
  );
  for (const method of ["PATCH", "DELETE"]) {
    assert.ok(
      new RegExp(`export async function ${method}\\b`).test(src),
      `프로필 라우트에 ${method} 가 없습니다 — 잘못 만든 프로필을 되돌릴 수 없습니다.`,
    );
  }
});

// A convention that prevents wiping credentials with an empty string. The UI not sending blank fields and
// the server ignoring blank values — both must exist so that the token survives if one side changes.
test("a blank token never overwrites a stored profile credential", () => {
  const src = readFileSync(path.join(repoRoot, "src/lib/hermes-profiles.ts"), "utf8");
  const fn = src.slice(src.indexOf("export async function updateHermesProfile"));
  const body = fn.slice(0, fn.indexOf("\nexport "));
  assert.ok(
    /typeof input\.token === "string" && input\.token\.trim\(\)/.test(body),
    "updateHermesProfile 이 빈 토큰을 걸러내지 않습니다 — 저장을 누르면 토큰이 지워집니다.",
  );
});

// T5 hard gate 10: the socket events automation adds are only `kanban:event`·`cron:event`·`npc:working`·
// `artifact:event`, and on the room side it only adds a `notice` field to `room:message`. The names are
// bundled in a constant (`AUTOMATION_SOCKET_EVENTS`), so a fifth name turns this red.
test("automation adds exactly four channel-scoped socket events and reuses room:message", () => {
  const sink = readFileSync(path.join(repoRoot, "src/server/automation-events.ts"), "utf8");
  const poller = readFileSync(path.join(repoRoot, "src/server/automation-poller.ts"), "utf8");
  const literal = (src: string, re: RegExp) => [...new Set([...src.matchAll(re)].map((m) => m[1]))];

  assert.deepEqual(
    literal(sink, /"((?:artifact|kanban|cron|npc):[a-z-]+)"/g).sort(),
    ["artifact:event", "cron:event", "kanban:event", "npc:working"],
    "사건 싱크가 쓰는 채널 이벤트는 정확히 네 개여야 합니다.",
  );
  // Not mixed with `npc:response-state` (R27) — that name appears nowhere in the sink or poller.
  for (const src of [sink, poller]) assert.doesNotMatch(src, /npc:response-state/);
  // Room broadcasts go only through room-socket's helper — the poller/sink do not write room:* literals directly.
  assert.deepEqual(literal(sink + poller, /"(room:[a-z-]+)"/g), []);
  assert.match(poller, /broadcastRoomMessage\(/, "방 메시지는 room-socket 의 helper 로 나갑니다.");
});

// R27: on channel join, send the current working snapshot to that socket and tell the poller about presence (R24).
test("player:join sends the npc:working snapshot and reports channel activity to the poller", () => {
  const src = readFileSync(path.join(repoRoot, "src/server/socket-handlers.ts"), "utf8");
  const start = src.indexOf('"player:join"');
  const end = src.indexOf('"player:move"');
  assert.ok(start !== -1 && end > start);
  const body = src.slice(start, end);
  assert.match(
    body,
    /getWorkingSnapshot\(/,
    "player:join 이 npc:working 스냅샷을 보내지 않습니다.",
  );
  assert.match(body, /AUTOMATION_SOCKET_EVENTS\.working/);
  assert.match(
    body,
    /notifyChannelActivity\(/,
    "접속을 폴러에 알리지 않으면 주기가 길게 고정됩니다.",
  );
  const disconnect = src.slice(src.indexOf('socket.on("disconnect"'));
  assert.match(disconnect, /notifyChannelActivity\(/, "disconnect 가 폴러에 알리지 않습니다.");
  assert.match(src, /startAutomationPollers\(/, "setupSocketHandlers 가 폴러를 켜지 않습니다.");
});

// Wiring that put DMs into the conversation list (card: "DMs with employees are missing from the conversation list").
//
// Even if the server returns the list, without a client listener the list stays empty forever, and the defect
// comes back while tests stay green — the same shape this file already went through with C1.
test("npc:dm-threads has both a server handler and a map client listener", () => {
  const events = socketEventsIn(...HANDLER_FILES);
  assert.ok(
    events.includes("npc:dm-threads"),
    '"npc:dm-threads" 핸들러가 없습니다 — 대화 목록에 DM 줄을 채울 데이터가 오지 않습니다.',
  );
  const client = readFileSync(path.join(repoRoot, "src/app/game/GamePageClient.tsx"), "utf8");
  assert.ok(
    /socketInstance\.on\(\s*"npc:dm-threads"/.test(client),
    "서버가 npc:dm-threads 를 돌려주지만 맵 클라이언트에 리스너가 없습니다 — 죽은 배선입니다.",
  );
  assert.ok(
    /emit\(\s*"npc:dm-threads"/.test(client),
    "클라이언트가 npc:dm-threads 를 요청하지 않습니다 — 목록이 비어 있게 됩니다.",
  );
});

// Dante's instruction: just opening from the list does not summon; summon **at send time**.
// If these two lines diverge, either (a) the employee walks over as soon as it opens or (b) nobody comes on send.
test("a DM summons the employee on send, not on open", () => {
  const client = readFileSync(path.join(repoRoot, "src/app/game/GamePageClient.tsx"), "utf8");
  const openHandler = client.slice(
    client.indexOf("const handleSelectNpc = useCallback"),
    client.indexOf("const handleDialogSend = useCallback"),
  );
  assert.ok(openHandler.length > 0, "handleSelectNpc / handleDialogSend 를 찾지 못했습니다");
  assert.equal(
    /npc:call|approach-and-interact/.test(openHandler),
    false,
    "DM 을 여는 것만으로 직원을 호출하고 있습니다 — 여는 것은 읽기뿐이어야 합니다.",
  );
  const sendHandler = client.slice(
    client.indexOf("const handleDialogSend = useCallback"),
    client.indexOf("const handleRoomSend = useCallback"),
  );
  assert.match(
    sendHandler,
    /needsCallBeforeDmSend[\s\S]*"npc:call"/,
    "DM 을 보낼 때 직원을 호출하지 않습니다 — 목록에서 연 대화는 아무도 대답하지 않습니다.",
  );
});

// D08: the poller's reachability verdict is one more channel event, kept out of the automation sink on purpose —
// it is not a Hermes event but the poller's own observation. One name, sent on change and once on join.
test("gateway:health is the only event the health module sends, and player:join sends its snapshot", () => {
  const health = readFileSync(path.join(repoRoot, "src/server/gateway-health.ts"), "utf8");
  assert.deepEqual(
    [...new Set([...health.matchAll(/"([a-z]+:[a-z-]+)"/g)].map((m) => m[1]))],
    ["gateway:health"],
  );
  const src = readFileSync(path.join(repoRoot, "src/server/socket-handlers.ts"), "utf8");
  const start = src.indexOf('"player:join"');
  const end = src.indexOf('"player:move"');
  assert.match(src.slice(start, end), /getGatewayHealth\(data\.mapId\)/);
  const poller = readFileSync(path.join(repoRoot, "src/server/automation-poller.ts"), "utf8");
  assert.match(poller, /recordGatewayHealth\(channelId, healthFromPollOutcome\(outcome\)/);
});
