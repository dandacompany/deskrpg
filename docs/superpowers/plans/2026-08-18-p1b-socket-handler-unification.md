# P1b — 소켓 핸들러 단일화 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 프로덕션(`server.js`)과 개발(`dev-server.ts`)이 **같은 소켓 핸들러 구현**을 쓰게 만들어, P1이 추가한 Hermes 디스패치가 프로덕션에서도 실행되게 한다.

**Architecture:** 부팅 구조는 건드리지 않는다. `server.js`는 Next standalone + 2포트(앱 PORT, Socket.io PORT+1) 구조를 그대로 유지하고, 자기 안의 `io.on("connection")` 블록(595~1120행, 약 525줄)만 `setupSocketHandlers(io)` 호출로 대체한다. 그 블록에만 있던 핸들러 4개는 `socket-handlers.ts`로 옮긴다.

**Tech Stack:** TypeScript + JavaScript 혼재(`server.js`는 `node --import tsx`로 실행되어 `.ts`를 직접 import할 수 있다 — 이미 `meeting-socket.ts`·`meeting-discussion.ts`·`task-reporting.ts`·`rbac/channel-access.ts`를 그렇게 로드한다), Socket.io, Next.js standalone, `node:test` + `tsx --test`.

**Spec:** `docs/superpowers/specs/2026-08-17-deskrpg-hermes-migration-design.md` (P1b는 그 스펙의 §5 롤아웃을 실행 가능하게 만드는 선행 작업)

## Global Constraints

- **부팅 코드를 바꾸지 않는다.** `next/dist/server/lib/start-server`의 `startServer()` 사용, `.next/required-server-files.json` 로딩, `__NEXT_PRIVATE_STANDALONE_CONFIG`, `SOCKET_PORT = currentPort + 1`, `/_internal/rpc`·`/_internal/emit`·`/_internal/room-members` HTTP 브리지 — 전부 현행 유지. `Dockerfile`·`docker-entrypoint.sh`·`bin/deskrpg.js`·배포 스크립트도 건드리지 않는다(단 Task 4의 COPY 추가는 예외).
- **테스트 실행은 반드시** `npx tsx --test $(git ls-files 'src/**/*.test.ts' 'src/**/*.test.js' | tr '\n' ' ')`. `npm test`는 셸 글롭이 미추적 잔재 4파일(`src/lib/gateway-resources.test.ts`, `src/lib/gateway-runtime-cache.test.ts`, `src/lib/openclaw-gateway.test.js`, `src/components/openclaw/OpenClawPairingStatusCard.test.tsx`)을 쓸어담아 존재하지 않는 실패 17건을 보고한다. 현재 기준선: **435/435 통과**.
- **`.gitignore:69`가 `*.test.ts`를 무시한다.** 새 테스트 파일은 반드시 `git add -f`. `git ls-files`로 추적 확인.
- `npx tsc --noEmit`의 **프로덕션(비테스트) 코드 에러는 0건**이며 그대로 유지해야 한다.
- 런타임 의존성 추가 금지.
- **OpenClaw 경로는 계속 동작해야 한다.** P4까지 롤백 지점으로 유지된다.

---

## File Structure

**수정**

| 파일 | 변경 |
|---|---|
| `src/server/socket-handlers.ts` | `chat:send`, `map:object-add`, `map:object-remove`, `map:tiles-update` 핸들러 4개 이식 |
| `server.js` | `io.on("connection")` 블록(595~1120행) 삭제 → `setupSocketHandlers(io)` 호출로 대체. 그 블록만 쓰던 헬퍼·상태도 함께 정리 |
| `Dockerfile` | `socket-handlers.ts`와 그 TS 의존 파일들을 COPY 목록에 추가 |

**신규**

| 파일 | 책임 |
|---|---|
| `src/server/socket-event-parity.test.ts` | 두 서버가 등록하는 이벤트 집합이 일치함을 기계적으로 고정 |

---

## Task 1: 이벤트 패리티 가드 테스트

먼저 만든다. 이 테스트가 있어야 이후 작업이 "무엇을 옮겨야 하는지"를 스스로 알려주고, 나중에 누가 한쪽에만 핸들러를 추가하는 드리프트를 막는다.

**Files:**
- Create: `src/server/socket-event-parity.test.ts`

**Interfaces:**
- Consumes: 없음 (소스 텍스트를 읽는다)
- Produces: 없음 (가드 전용)

- [ ] **Step 1: Write the failing test**

```typescript
// src/server/socket-event-parity.test.ts
//
// SOCKET EVENT PARITY GUARD
// -------------------------
// 프로덕션은 `node server.js`, 개발은 `npx tsx dev-server.ts` → socket-handlers.ts 를 쓴다.
// 2026-08 이전까지 두 파일은 각자 핸들러를 갖고 있었고, 한쪽에만 기능이 추가되는
// 드리프트가 실제로 발생했다(프로덕션에 Hermes/CLI 어댑터 디스패치가 없었다).
// P1b에서 server.js 가 setupSocketHandlers 를 호출하도록 통합했으므로,
// 이 테스트는 server.js 안에 소켓 핸들러가 다시 생겨나는 것을 막는다.

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/server/socket-event-parity.test.ts`
Expected: 3개 중 최소 2개 FAIL — `server.js`가 아직 자기 핸들러를 갖고 있고 `setupSocketHandlers`를 부르지 않으며, `socket-handlers.ts`에 `chat:send`와 `map:*`가 없다.

- [ ] **Step 3: Commit the failing guard**

이 태스크는 가드만 만든다. 구현은 Task 2·3이다. 실패하는 테스트를 커밋하지 않기 위해, **Task 3까지 끝낸 뒤 한 번에 커밋한다.** 지금은 파일만 만들어 두고 다음 태스크로 넘어간다.

```bash
# 아직 커밋하지 않는다 — Task 3에서 함께
git add -f src/server/socket-event-parity.test.ts
```

---

## Task 2: 핸들러 4개를 socket-handlers.ts로 이식

**Files:**
- Modify: `src/server/socket-handlers.ts`
- Read: `server.js:1014-1080` (원본)

**Interfaces:**
- Consumes: `setupSocketHandlers(io: Server)`의 `io.on("connection")` 콜백 스코프
- Produces: `chat:send`, `map:object-add`, `map:object-remove`, `map:tiles-update` 핸들러

**이식 대상 원본** (`server.js`):

| 이벤트 | 위치 |
|---|---|
| `chat:send` | 1014행 |
| `map:object-add` | 1060행 |
| `map:object-remove` | 1067행 |
| `map:tiles-update` | 1074행 |

- [ ] **Step 1: 원본을 읽고 의존 관계를 확인한다**

`server.js`의 해당 핸들러들이 참조하는 것을 모두 적는다 — `players` 맵, `socket.data`, 브로드캐스트 대상(`socket.to(mapId)` vs `io.to(channelId)`), RBAC 검사 여부. `socket-handlers.ts`에 같은 이름의 상태가 이미 있는지 확인한다(`PlayerState` 인터페이스가 `:102`에 있다).

**주의:** `server.js`와 `socket-handlers.ts`는 플레이어 상태를 각자 관리한다. 이식할 때 `socket-handlers.ts` 쪽 상태 구조에 맞춰야 하며, `server.js`의 변수명을 그대로 옮기면 안 된다.

- [ ] **Step 2: 핸들러를 이식한다**

`setupSocketHandlers`의 `io.on("connection")` 콜백 안, 기존 `player:move` 핸들러 뒤에 배치한다. 동작은 원본과 동일해야 한다 — 브로드캐스트 범위(룸), 권한 검사, 페이로드 형태를 바꾸지 않는다.

- [ ] **Step 3: 패리티 테스트의 세 번째 케이스가 통과하는지 확인**

Run: `npx tsx --test src/server/socket-event-parity.test.ts`
Expected: `"socket-handlers still registers the events server.js used to own"` PASS. 나머지 둘은 아직 FAIL(Task 3에서 해결).

- [ ] **Step 4: 기존 테스트가 깨지지 않았는지 확인**

Run: `npx tsx --test $(git ls-files 'src/**/*.test.ts' 'src/**/*.test.js' | tr '\n' ' ')`
Expected: 435개 이상 통과, 실패 0

---

## Task 3: server.js를 setupSocketHandlers로 전환

**Files:**
- Modify: `server.js` (595~1120행 블록 제거, 호출로 대체)

**Interfaces:**
- Consumes: `setupSocketHandlers` from `./src/server/socket-handlers.ts`
- Produces: 없음

- [ ] **Step 1: import를 추가한다**

`server.js`가 이미 쓰는 패턴을 그대로 따른다(`:74`, `:78` 참고):

```javascript
const socketHandlers = unwrapTsModule(await import("./src/server/socket-handlers.ts"));
const { setupSocketHandlers } = socketHandlers;
```

- [ ] **Step 2: `io.on("connection")` 블록을 대체한다**

595~1120행의 블록 전체를 삭제하고 `setupSocketHandlers(io);` 한 줄로 바꾼다.

**삭제 전 반드시 확인할 것:** 그 블록 밖에서 쓰이는 헬퍼·상태가 블록 안에 정의돼 있지 않은지. 특히 `/_internal/emit`과 `/_internal/room-members` 핸들러(1159~1230행)가 `players` 맵이나 `io` 참조를 쓴다면 그 의존을 유지해야 한다. `socket-handlers.ts`가 같은 정보를 export하지 않는다면, 이 태스크의 범위에서 최소한의 접근자를 추가한다.

- [ ] **Step 3: 남은 데드 코드를 정리한다**

블록 삭제 후 아무도 참조하지 않게 된 함수·상수를 제거한다(`server.js`의 `streamNpcResponse`, `generateMeetingSummary` 등 — 단 `/_internal` 브리지가 쓰는 것은 남긴다). `npx eslint server.js`로 미사용 변수를 확인한다.

- [ ] **Step 4: 패리티 테스트 전체 통과 확인**

Run: `npx tsx --test src/server/socket-event-parity.test.ts`
Expected: 3/3 PASS

- [ ] **Step 5: 전체 테스트와 타입 검사**

Run: `npx tsx --test $(git ls-files 'src/**/*.test.ts' 'src/**/*.test.js' | tr '\n' ' ') && npx tsc --noEmit 2>&1 | rg "error TS" | rg -v '\.test\.' | wc -l`
Expected: 테스트 실패 0, 비테스트 타입 에러 0

- [ ] **Step 6: Commit**

```bash
git add -f src/server/socket-event-parity.test.ts
git add src/server/socket-handlers.ts server.js
git commit -m "refactor(server): unify socket handlers — server.js delegates to setupSocketHandlers"
```

---

## Task 4: Docker 런타임에 socket-handlers와 의존 파일 추가

`Dockerfile`은 Next standalone이 추적하지 못하는 런타임 파일을 **파일 단위로 명시 복사**한다(`:41-63`). `socket-handlers.ts`와 그것이 import하는 TS 파일들이 목록에 없으면 **이미지가 부팅에 실패한다.**

**Files:**
- Modify: `Dockerfile`

- [ ] **Step 1: socket-handlers.ts의 전이 의존을 나열한다**

```bash
rg -n "^import .* from \"\./|^import .* from \"@/" src/server/socket-handlers.ts
```

그 결과의 각 파일에 대해 재귀적으로 반복해, `.next/standalone`에 포함되지 않는 파일 목록을 만든다. 이미 COPY 목록에 있는 것(`meeting-socket.ts`, `meeting-discussion.ts`, `task-reporting.ts`, `rbac/channel-access.ts` 등)은 제외한다.

- [ ] **Step 2: Dockerfile에 COPY를 추가한다**

기존 형식(`:59-60`)을 그대로 따른다:

```dockerfile
COPY --from=builder /app/src/server/socket-handlers.ts ./src/server/socket-handlers.ts
COPY --from=builder /app/src/server/hermes-dispatch.ts ./src/server/hermes-dispatch.ts
# … Step 1에서 찾은 나머지
```

- [ ] **Step 3: 이미지를 빌드해 실제로 부팅하는지 확인한다**

```bash
docker build -t deskrpg-p1b-test .
docker run --rm -e DATABASE_URL=... -p 3100:3000 deskrpg-p1b-test
```

Expected: 컨테이너가 기동하고 `[socket.io] Listening on ...` 로그가 뜬다. `Cannot find module` 오류가 나면 Step 1의 목록이 불완전한 것이다.

**Docker를 쓸 수 없는 환경이라면 이 단계를 실행했다고 주장하지 말 것.** 대신 Step 1의 의존 목록과 COPY 항목이 1:1로 대응하는지 파일로 대조하고, 실행 검증이 남았음을 보고서에 명시한다.

- [ ] **Step 4: Commit**

```bash
git add Dockerfile
git commit -m "build(docker): copy socket-handlers and its runtime deps into the image"
```

---

## Task 5: 최종 검증

- [ ] **Step 1: 추적 테스트 전체**

Run: `npx tsx --test $(git ls-files 'src/**/*.test.ts' 'src/**/*.test.js' | tr '\n' ' ')`
Expected: 실패 0. 테스트 수는 435 + 패리티 3 = 438 이상.

- [ ] **Step 2: 타입 검사와 린트**

Run: `npx tsc --noEmit`(비테스트 에러 0 확인) 및 `npx eslint server.js src/server/socket-handlers.ts`
Expected: 에러 0

- [ ] **Step 3: 프로덕션 빌드**

Run: `npm run build`
Expected: 성공

- [ ] **Step 4: 빈 SQLite 런타임 부팅**

```bash
rm -rf /tmp/deskrpg-p1b && DESKRPG_HOME=/tmp/deskrpg-p1b node bin/deskrpg.js init && DESKRPG_HOME=/tmp/deskrpg-p1b node bin/deskrpg.js doctor
```
Expected: 오류 없음

- [ ] **Step 5: 수동 검증 목록 갱신**

`.superpowers/sdd/2026-08-17-p1-hermes-transport/manual-verification.md`에서 "dev에서만 동작" 서술을 정정하고, **프로덕션(`deskrpg start` 또는 Docker)에서 Hermes NPC와 대화가 되는지**를 확인 항목으로 추가한다. 이것이 P1b의 진짜 성공 기준이다.

- [ ] **Step 6: Commit**

```bash
git add .superpowers/sdd/2026-08-17-p1-hermes-transport/manual-verification.md
git commit -m "docs: update manual verification for unified socket handlers"
```

---

## Self-Review 결과

**스펙 커버리지** — P1b는 스펙에 없는 선행 작업이다. 스펙 §5의 P1이 "1:1 DM이 Hermes 프로필로 동작"을 완료 기준으로 두는데, 최종 리뷰 F1이 그 기준이 개발 환경에서만 참임을 밝혔다. 이 계획은 그 간극을 메운다.

**의도적으로 범위 밖에 둔 것** — `next({ dev: false })` 커스텀 서버 전환, standalone 산출물 포기, 2포트 구조 제거, `/_internal/rpc` HTTP 브리지 제거. 전부 배포 파이프라인을 건드리므로 별도 안건이다.

**가장 위험한 지점** — Task 3 Step 2. `server.js`의 525줄 블록을 지울 때 `/_internal` 브리지가 그 블록 안의 상태에 의존하고 있으면 조용히 깨진다. 그래서 Step 2에 그 확인을 명시했고, Task 5 Step 4의 런타임 부팅이 이를 잡는다.

**타입 일관성** — `setupSocketHandlers(io: Server)`는 인자가 `io` 하나뿐이므로(`socket-handlers.ts:1078`) `server.js`가 자기 `io` 인스턴스를 그대로 넘길 수 있다. 추가 배선이 필요 없다.
