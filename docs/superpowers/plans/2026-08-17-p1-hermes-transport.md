# P1 — Hermes 전송 교체 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** DeskRPG의 NPC 1:1 대화를 OpenClaw WebSocket RPC 대신 Hermes API Server(HTTP + SSE)로 보내고, 프로필별 게이트웨이 자원을 등록·바인딩할 수 있게 한다.

**Architecture:** 순수 SSE 파서 위에 프로필 스코프 HTTP 클라이언트(`HermesClient`)를 올리고, 그것을 `NpcAdapter` 인터페이스로 감싼다(`HermesAdapter`). 프로필은 `(gateway, profileName, token)` 삼중항으로 DB에 저장되며 NPC가 FK로 참조한다. 이 단계에서 OpenClaw 코드는 삭제하지 않고 경로에서만 뺀다.

**Tech Stack:** TypeScript, Next.js 16 App Router, Drizzle ORM (PostgreSQL + SQLite 이중), Socket.io, `node:test` + `tsx --test`, 내장 `fetch`(Node 20+). 새 런타임 의존성 추가 없음.

**Spec:** `docs/superpowers/specs/2026-08-17-deskrpg-hermes-migration-design.md`

## Global Constraints

- **테스트 러너**: `npm test` = `tsx --test src/**/*.test.ts src/**/*.test.js`. 테스트는 소스 옆에 `*.test.ts`로 둔다. `node:test`의 `describe`/`test`/`mock`과 `node:assert/strict`를 쓴다.
- **스키마는 4파일 + 2런타임 파일이 항상 함께 바뀐다**: `src/db/schema.ts`, `src/db/schema.pg.cjs`, `src/db/schema-sqlite.ts`, `src/db/schema.sqlite.cjs`, `src/db/sqlite-base-schema.js`(빈 DB 부트스트랩), `src/db/server-db.js`의 `ensureSqliteCompatibility()`(기존 DB 승격). `schema-drift.test.ts`가 이를 강제한다.
- **`EXPECTED_TABLE_COUNT`**: 현재 29. `hermes_profiles` 추가 후 **30**.
- **PostgreSQL 마이그레이션 SQL 금지 구문**: `ADD CONSTRAINT IF NOT EXISTS` 미지원. `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$;` 사용. `ADD COLUMN IF NOT EXISTS`는 사용 가능.
- **Hermes API 계약 (실측, v0.20.2)**:
  - 프로필 프리픽스: 모든 라우트가 맨 경로와 `/p/{profile}` 두 벌로 등록됨. `gateway.multiplex_profiles: true` 필요.
  - 인증: `Authorization: Bearer <API_SERVER_KEY>`. **named 프로필은 자기 스코프 키를 가져야 하며 default 키를 상속하지 않는다**(없으면 401).
  - SSE 프레임: `event: <name>\ndata: <json>\n\n` (JSON은 `ensure_ascii=True`).
  - SSE 이벤트: `run.started` → `message.started` → `assistant.delta` / `tool.progress` / `tool.started|completed|failed` → `assistant.completed` → `run.completed | run.cancelled | run.failed | error` → `done`.
  - 모든 이벤트 payload에 `run_id`, `session_id`, `seq`, `ts`가 자동 포함됨.
  - 알 수 없는 프로필 → `404 {"error": "Unknown or unconfigured profile"}`. 키 불일치 → `401`.
- **토큰 암호화**: 기존 `encryptGatewayToken`/`decryptGatewayToken`(AES-256-GCM, `v1:iv:tag:ct` base64url)을 그대로 재사용한다. 새 암호화 코드를 만들지 않는다.
- **OpenClaw 코드는 이 단계에서 삭제하지 않는다.** P4에서 일괄 제거한다.

---

## File Structure

**신규**

| 파일 | 책임 |
|---|---|
| `src/lib/hermes/sse.ts` | SSE 바이트 스트림 → 이벤트 객체. 순수 함수, I/O 없음 |
| `src/lib/hermes/types.ts` | Hermes API 응답 타입 (capabilities, run event, session) |
| `src/lib/hermes/hermes-client.ts` | 프로필 스코프 HTTP 클라이언트. URL 조립, 인증, 에러 매핑 |
| `src/lib/hermes-profiles.ts` | `hermes_profiles` 자원 계층 (CRUD, 접근 제어, 검증 상태) |
| `src/lib/adapters/hermes-adapter.ts` | `NpcAdapter` 구현. 두 호출 경로 선택 |
| `src/app/api/gateways/[id]/profiles/route.ts` | 프로필 목록 조회 / 등록 |
| `src/app/api/gateways/[id]/profiles/[profileId]/test/route.ts` | 프로필 단위 연결 검증 |
| `src/app/api/npcs/[id]/rebind/route.ts` | NPC를 프로필에 재바인딩 |

**수정**

| 파일 | 변경 |
|---|---|
| `src/lib/adapters/types.ts` | `AdapterExecuteOptions`에서 `agentId`/`channelId` 제거, 3개 필드 추가 |
| `src/db/schema.ts` + 3형제 | `hermes_profiles` 테이블, `npcs.hermes_profile_id`, `npcs.agent_config` |
| `src/db/sqlite-base-schema.js` | 빈 DB용 `CREATE TABLE hermes_profiles` |
| `src/db/server-db.js` | `ensureSqliteCompatibility()`에 승격 SQL |
| `src/db/schema-drift.test.ts` | `EXPECTED_TABLE_COUNT` 29 → 30 |
| `src/server/socket-handlers.ts` | `hermes` 어댑터 등록 + DM 경로 분기 |

파일 분할 기준은 **책임**이다. SSE 파싱은 네트워크를 모르고, 클라이언트는 DB를 모르고, 어댑터는 HTTP를 모른다. 이 경계 덕분에 T1~T2는 실제 게이트웨이 없이 전부 테스트된다.

---

## Task 1: SSE 파서

**Files:**
- Create: `src/lib/hermes/sse.ts`
- Test: `src/lib/hermes/sse.test.ts`

**Interfaces:**
- Consumes: 없음 (가장 안쪽)
- Produces:
  - `type SseEvent = { event: string; data: Record<string, unknown> }`
  - `function createSseParser(): { push(chunk: string): SseEvent[]; flush(): SseEvent[] }`

`push()`는 임의 경계로 잘린 청크를 받아 **완성된 프레임만** 반환하고 나머지는 내부 버퍼에 남긴다. 네트워크 청크가 프레임 경계와 일치한다는 보장이 없기 때문이며, 이걸 테스트로 못박지 않으면 긴 한국어 응답에서 간헐적으로 글자가 깨진다.

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/hermes/sse.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createSseParser } from "./sse";

describe("createSseParser", () => {
  test("parses a single complete frame", () => {
    const parser = createSseParser();
    const events = parser.push('event: assistant.delta\ndata: {"delta":"안녕","seq":1}\n\n');
    assert.equal(events.length, 1);
    assert.equal(events[0].event, "assistant.delta");
    assert.deepEqual(events[0].data, { delta: "안녕", seq: 1 });
  });

  test("parses two frames in one chunk", () => {
    const parser = createSseParser();
    const events = parser.push(
      'event: run.started\ndata: {"seq":1}\n\n' +
      'event: message.started\ndata: {"seq":2}\n\n',
    );
    assert.deepEqual(events.map((e) => e.event), ["run.started", "message.started"]);
  });

  test("buffers a frame split across chunks", () => {
    const parser = createSseParser();
    assert.deepEqual(parser.push('event: assistant.delta\ndata: {"del'), []);
    assert.deepEqual(parser.push('ta":"세계"}\n'), []);
    const events = parser.push("\n");
    assert.equal(events.length, 1);
    assert.equal(events[0].data.delta, "세계");
  });

  test("defaults the event name to 'message' when no event line is present", () => {
    const parser = createSseParser();
    const events = parser.push('data: {"ok":true}\n\n');
    assert.equal(events[0].event, "message");
  });

  test("skips a frame whose data is not valid JSON instead of throwing", () => {
    const parser = createSseParser();
    const events = parser.push('event: x\ndata: not-json\n\n' + 'event: y\ndata: {"a":1}\n\n');
    assert.deepEqual(events.map((e) => e.event), ["y"]);
  });

  test("flush drops an incomplete trailing frame", () => {
    const parser = createSseParser();
    parser.push('event: assistant.delta\ndata: {"delta":"잘림"');
    assert.deepEqual(parser.flush(), []);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/lib/hermes/sse.test.ts`
Expected: FAIL — `Cannot find module './sse'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/lib/hermes/sse.ts
// Hermes API Server SSE frame parser.
// Wire format (api_server.py:_sse_frame): "event: <name>\ndata: <json>\n\n"

export type SseEvent = { event: string; data: Record<string, unknown> };

function parseFrame(raw: string): SseEvent | null {
  let eventName = "message";
  const dataLines: string[] = [];

  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }

  if (dataLines.length === 0) return null;

  try {
    const parsed = JSON.parse(dataLines.join("\n")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return { event: eventName, data: parsed as Record<string, unknown> };
  } catch {
    // A malformed frame must not kill the stream — the rest is still useful.
    return null;
  }
}

export function createSseParser() {
  let buffer = "";

  return {
    push(chunk: string): SseEvent[] {
      buffer += chunk;
      const events: SseEvent[] = [];
      let boundary = buffer.indexOf("\n\n");

      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseFrame(frame);
        if (parsed) events.push(parsed);
        boundary = buffer.indexOf("\n\n");
      }

      return events;
    },

    flush(): SseEvent[] {
      buffer = "";
      return [];
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/lib/hermes/sse.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/hermes/sse.ts src/lib/hermes/sse.test.ts
git commit -m "feat(hermes): add SSE frame parser for Hermes API Server streams"
```

---

## Task 2: Hermes API 타입

**Files:**
- Create: `src/lib/hermes/types.ts`
- Test: `src/lib/hermes/types.test.ts`

**Interfaces:**
- Consumes: `SseEvent` (Task 1)
- Produces:
  - `type HermesCapabilities = { features: Record<string, unknown>; endpoints: Record<string, { method: string; path: string }> }`
  - `type HermesRunEvent` — `run.started` | `message.started` | `assistant.delta` | `tool.progress` | `tool.started` | `tool.completed` | `tool.failed` | `assistant.completed` | `run.completed` | `run.cancelled` | `run.failed` | `error` | `done`
  - `function isTerminalEvent(name: string): boolean`
  - `function readCapability(caps: HermesCapabilities | null, key: string): boolean`
  - `function readMaxConcurrentRuns(caps: HermesCapabilities | null): number`

`readCapability`는 **capabilities를 못 읽었을 때(null) `false`를 반환**한다 — fail-closed. 구버전 게이트웨이에서 없는 기능을 호출해 500을 받는 대신 기능을 끄는 쪽을 택한다.

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/hermes/types.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isTerminalEvent, readCapability, readMaxConcurrentRuns } from "./types";

describe("isTerminalEvent", () => {
  test("terminal events end the stream", () => {
    for (const name of ["run.completed", "run.cancelled", "run.failed", "error", "done"]) {
      assert.equal(isTerminalEvent(name), true, name);
    }
  });

  test("streaming events do not end the stream", () => {
    for (const name of ["run.started", "assistant.delta", "tool.progress", "assistant.completed"]) {
      assert.equal(isTerminalEvent(name), false, name);
    }
  });
});

describe("readCapability", () => {
  test("reads a true feature flag", () => {
    assert.equal(readCapability({ features: { run_steer: true }, endpoints: {} }, "run_steer"), true);
  });

  test("returns false for a missing flag", () => {
    assert.equal(readCapability({ features: {}, endpoints: {} }, "run_steer"), false);
  });

  test("fails closed when capabilities are unavailable", () => {
    assert.equal(readCapability(null, "run_steer"), false);
  });
});

describe("readMaxConcurrentRuns", () => {
  test("reads the configured limit", () => {
    const caps = { features: { max_concurrent_runs: 8 }, endpoints: {} };
    assert.equal(readMaxConcurrentRuns(caps), 8);
  });

  test("falls back to a conservative default when unknown", () => {
    assert.equal(readMaxConcurrentRuns(null), 4);
    assert.equal(readMaxConcurrentRuns({ features: {}, endpoints: {} }), 4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/lib/hermes/types.test.ts`
Expected: FAIL — `Cannot find module './types'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/lib/hermes/types.ts
// Shapes returned by the Hermes API Server (gateway/platforms/api_server.py).

export type HermesCapabilities = {
  features: Record<string, unknown>;
  endpoints: Record<string, { method: string; path: string }>;
};

export type HermesRunEventName =
  | "run.started" | "message.started"
  | "assistant.delta" | "tool.progress"
  | "tool.started" | "tool.completed" | "tool.failed"
  | "assistant.completed"
  | "run.completed" | "run.cancelled" | "run.failed" | "error" | "done";

/** Every event payload carries these (api_server.py:_event_payload setdefault). */
export type HermesEventEnvelope = {
  run_id?: string;
  session_id?: string;
  seq?: number;
  ts?: number;
};

const TERMINAL = new Set(["run.completed", "run.cancelled", "run.failed", "error", "done"]);

export function isTerminalEvent(name: string): boolean {
  return TERMINAL.has(name);
}

/** Fail-closed: an unreachable /v1/capabilities disables the feature. */
export function readCapability(caps: HermesCapabilities | null, key: string): boolean {
  return caps?.features?.[key] === true;
}

const DEFAULT_MAX_CONCURRENT_RUNS = 4;

export function readMaxConcurrentRuns(caps: HermesCapabilities | null): number {
  const raw = caps?.features?.max_concurrent_runs;
  return typeof raw === "number" && raw > 0 ? raw : DEFAULT_MAX_CONCURRENT_RUNS;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/lib/hermes/types.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/hermes/types.ts src/lib/hermes/types.test.ts
git commit -m "feat(hermes): add API capability and run-event type helpers"
```

---

## Task 3: HermesClient

**Files:**
- Create: `src/lib/hermes/hermes-client.ts`
- Test: `src/lib/hermes/hermes-client.test.ts`

**Interfaces:**
- Consumes: `createSseParser` (Task 1), `isTerminalEvent`/`HermesCapabilities` (Task 2)
- Produces:
  - `class HermesError extends Error { code: "unauthorized" | "unknown_profile" | "unreachable" | "http_error"; status: number }`
  - `type HermesClientConfig = { baseUrl: string; profileName: string | null; token: string; fetchImpl?: typeof fetch }`
  - `class HermesClient`:
    - `constructor(config: HermesClientConfig)`
    - `url(path: string): string`
    - `getCapabilities(): Promise<HermesCapabilities>`
    - `createSession(title: string): Promise<{ sessionId: string }>`
    - `streamSessionChat(args: { sessionId: string; message: string; sessionKey?: string; onEvent: (e: SseEvent) => void }): Promise<{ text: string; runId: string | null; sessionId: string }>`
    - `startRun(args: { input: string; conversationHistory?: Array<{ role: string; content: string }>; instructions?: string; sessionKey?: string }): Promise<{ runId: string }>`
    - `streamRunEvents(runId: string, onEvent: (e: SseEvent) => void): Promise<{ text: string }>`
    - `stopRun(runId: string): Promise<void>`
    - `steerRun(runId: string, text: string): Promise<void>`

`fetchImpl` 주입이 핵심이다. 이 클래스의 테스트는 실제 게이트웨이 없이 전부 돈다.

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/hermes/hermes-client.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { HermesClient, HermesError } from "./hermes-client";

function sseResponse(frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("HermesClient.url", () => {
  test("prefixes named profiles", () => {
    const c = new HermesClient({ baseUrl: "http://gw:8642", profileName: "sophie", token: "t" });
    assert.equal(c.url("/v1/runs"), "http://gw:8642/p/sophie/v1/runs");
  });

  test("omits the prefix for the default profile", () => {
    const c = new HermesClient({ baseUrl: "http://gw:8642", profileName: null, token: "t" });
    assert.equal(c.url("/v1/runs"), "http://gw:8642/v1/runs");
  });

  test("strips a trailing slash from baseUrl", () => {
    const c = new HermesClient({ baseUrl: "http://gw:8642/", profileName: "danvi", token: "t" });
    assert.equal(c.url("/health"), "http://gw:8642/p/danvi/health");
  });
});

describe("HermesClient auth and errors", () => {
  test("sends the profile token as a bearer header", async () => {
    let seen: Headers | undefined;
    const fetchImpl = async (_u: string | URL | Request, init?: RequestInit) => {
      seen = new Headers(init?.headers);
      return new Response(JSON.stringify({ features: {}, endpoints: {} }), { status: 200 });
    };
    const c = new HermesClient({ baseUrl: "http://gw:8642", profileName: "sophie", token: "secret-key", fetchImpl: fetchImpl as typeof fetch });
    await c.getCapabilities();
    assert.equal(seen?.get("Authorization"), "Bearer secret-key");
  });

  test("maps 401 to unauthorized", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 });
    const c = new HermesClient({ baseUrl: "http://gw:8642", profileName: "sophie", token: "t", fetchImpl: fetchImpl as typeof fetch });
    await assert.rejects(() => c.getCapabilities(), (err: HermesError) => {
      assert.equal(err.code, "unauthorized");
      assert.equal(err.status, 401);
      return true;
    });
  });

  test("maps 404 to unknown_profile", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ error: "Unknown or unconfigured profile" }), { status: 404 });
    const c = new HermesClient({ baseUrl: "http://gw:8642", profileName: "ghost", token: "t", fetchImpl: fetchImpl as typeof fetch });
    await assert.rejects(() => c.getCapabilities(), (err: HermesError) => {
      assert.equal(err.code, "unknown_profile");
      return true;
    });
  });

  test("maps a network throw to unreachable", async () => {
    const fetchImpl = async () => { throw new Error("ECONNREFUSED"); };
    const c = new HermesClient({ baseUrl: "http://gw:8642", profileName: null, token: "t", fetchImpl: fetchImpl as typeof fetch });
    await assert.rejects(() => c.getCapabilities(), (err: HermesError) => {
      assert.equal(err.code, "unreachable");
      return true;
    });
  });
});

describe("HermesClient.streamSessionChat", () => {
  test("accumulates deltas and returns the final text with run_id", async () => {
    const fetchImpl = async () => sseResponse([
      'event: run.started\ndata: {"run_id":"run-1","seq":1}\n\n',
      'event: assistant.delta\ndata: {"delta":"안녕","run_id":"run-1","seq":2}\n\n',
      'event: assistant.delta\ndata: {"delta":"하세요","run_id":"run-1","seq":3}\n\n',
      'event: assistant.completed\ndata: {"content":"안녕하세요","session_id":"sess-9","run_id":"run-1","seq":4}\n\n',
      'event: run.completed\ndata: {"run_id":"run-1","seq":5}\n\n',
    ]);
    const c = new HermesClient({ baseUrl: "http://gw:8642", profileName: "sophie", token: "t", fetchImpl: fetchImpl as typeof fetch });

    const names: string[] = [];
    const result = await c.streamSessionChat({
      sessionId: "sess-9",
      message: "안녕",
      onEvent: (e) => names.push(e.event),
    });

    assert.equal(result.text, "안녕하세요");
    assert.equal(result.runId, "run-1");
    assert.equal(result.sessionId, "sess-9");
    assert.deepEqual(names, ["run.started", "assistant.delta", "assistant.delta", "assistant.completed", "run.completed"]);
  });

  test("prefers assistant.completed content over accumulated deltas", async () => {
    const fetchImpl = async () => sseResponse([
      'event: assistant.delta\ndata: {"delta":"부분"}\n\n',
      'event: assistant.completed\ndata: {"content":"완성본"}\n\n',
      'event: done\ndata: {}\n\n',
    ]);
    const c = new HermesClient({ baseUrl: "http://gw:8642", profileName: null, token: "t", fetchImpl: fetchImpl as typeof fetch });
    const result = await c.streamSessionChat({ sessionId: "s", message: "m", onEvent: () => {} });
    assert.equal(result.text, "완성본");
  });

  test("returns accumulated deltas when the stream ends without a completed event", async () => {
    const fetchImpl = async () => sseResponse([
      'event: assistant.delta\ndata: {"delta":"끊긴 "}\n\n',
      'event: assistant.delta\ndata: {"delta":"응답"}\n\n',
    ]);
    const c = new HermesClient({ baseUrl: "http://gw:8642", profileName: null, token: "t", fetchImpl: fetchImpl as typeof fetch });
    const result = await c.streamSessionChat({ sessionId: "s", message: "m", onEvent: () => {} });
    assert.equal(result.text, "끊긴 응답");
  });

  test("rejects on run.failed", async () => {
    const fetchImpl = async () => sseResponse([
      'event: run.failed\ndata: {"message":"provider exploded"}\n\n',
    ]);
    const c = new HermesClient({ baseUrl: "http://gw:8642", profileName: null, token: "t", fetchImpl: fetchImpl as typeof fetch });
    await assert.rejects(() => c.streamSessionChat({ sessionId: "s", message: "m", onEvent: () => {} }), /provider exploded/);
  });

  test("sends the long-term memory scope header when a session key is given", async () => {
    let seen: Headers | undefined;
    const fetchImpl = async (_u: string | URL | Request, init?: RequestInit) => {
      seen = new Headers(init?.headers);
      return sseResponse(['event: done\ndata: {}\n\n']);
    };
    const c = new HermesClient({ baseUrl: "http://gw:8642", profileName: "sophie", token: "t", fetchImpl: fetchImpl as typeof fetch });
    await c.streamSessionChat({ sessionId: "s", message: "m", sessionKey: "npc-42", onEvent: () => {} });
    assert.equal(seen?.get("X-Hermes-Session-Key"), "npc-42");
  });
});

describe("HermesClient.startRun", () => {
  test("posts input plus conversation history and returns run_id", async () => {
    let body: Record<string, unknown> = {};
    let calledUrl = "";
    const fetchImpl = async (u: string | URL | Request, init?: RequestInit) => {
      calledUrl = String(u);
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ run_id: "run-7" }), { status: 202 });
    };
    const c = new HermesClient({ baseUrl: "http://gw:8642", profileName: "danvi", token: "t", fetchImpl: fetchImpl as typeof fetch });

    const result = await c.startRun({
      input: "의견 주세요",
      conversationHistory: [{ role: "user", content: "주제: 배포" }],
    });

    assert.equal(result.runId, "run-7");
    assert.equal(calledUrl, "http://gw:8642/p/danvi/v1/runs");
    assert.equal(body.input, "의견 주세요");
    assert.deepEqual(body.conversation_history, [{ role: "user", content: "주제: 배포" }]);
  });
});

describe("HermesClient.stopRun / steerRun", () => {
  test("stopRun posts to the run stop endpoint", async () => {
    let calledUrl = "";
    const fetchImpl = async (u: string | URL | Request) => {
      calledUrl = String(u);
      return new Response("{}", { status: 200 });
    };
    const c = new HermesClient({ baseUrl: "http://gw:8642", profileName: "sophie", token: "t", fetchImpl: fetchImpl as typeof fetch });
    await c.stopRun("run-3");
    assert.equal(calledUrl, "http://gw:8642/p/sophie/v1/runs/run-3/stop");
  });

  test("steerRun sends the guidance text", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = async (_u: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response("{}", { status: 200 });
    };
    const c = new HermesClient({ baseUrl: "http://gw:8642", profileName: "sophie", token: "t", fetchImpl: fetchImpl as typeof fetch });
    await c.steerRun("run-3", "짧게 답하세요");
    assert.equal(body.text, "짧게 답하세요");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/lib/hermes/hermes-client.test.ts`
Expected: FAIL — `Cannot find module './hermes-client'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/lib/hermes/hermes-client.ts
// Profile-scoped HTTP client for the Hermes API Server.
// Knows URLs, auth and error shapes. Knows nothing about DeskRPG's DB.

import { createSseParser, type SseEvent } from "./sse";
import { isTerminalEvent, type HermesCapabilities } from "./types";

export type HermesErrorCode = "unauthorized" | "unknown_profile" | "unreachable" | "http_error";

export class HermesError extends Error {
  readonly code: HermesErrorCode;
  readonly status: number;

  constructor(code: HermesErrorCode, message: string, status: number) {
    super(message);
    this.name = "HermesError";
    this.code = code;
    this.status = status;
  }
}

export type HermesClientConfig = {
  baseUrl: string;
  /** null = the gateway's default profile (no /p/ prefix). */
  profileName: string | null;
  token: string;
  fetchImpl?: typeof fetch;
};

function errorCodeForStatus(status: number): HermesErrorCode {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "unknown_profile";
  return "http_error";
}

export class HermesClient {
  private readonly baseUrl: string;
  private readonly profileName: string | null;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: HermesClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.profileName = config.profileName;
    this.token = config.token;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  url(path: string): string {
    const prefix = this.profileName ? `/p/${encodeURIComponent(this.profileName)}` : "";
    return `${this.baseUrl}${prefix}${path}`;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  private async request(path: string, init: RequestInit & { sessionKey?: string } = {}): Promise<Response> {
    const { sessionKey, ...rest } = init;
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path), {
        ...rest,
        headers: this.headers(sessionKey ? { "X-Hermes-Session-Key": sessionKey } : undefined),
      });
    } catch (err) {
      throw new HermesError("unreachable", err instanceof Error ? err.message : "Gateway unreachable", 0);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new HermesError(errorCodeForStatus(res.status), text || `HTTP ${res.status}`, res.status);
    }
    return res;
  }

  async getCapabilities(): Promise<HermesCapabilities> {
    const res = await this.request("/v1/capabilities", { method: "GET" });
    return (await res.json()) as HermesCapabilities;
  }

  async createSession(title: string): Promise<{ sessionId: string }> {
    const res = await this.request("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ title }),
    });
    const json = (await res.json()) as { session_id?: string; id?: string };
    const sessionId = json.session_id ?? json.id;
    if (!sessionId) throw new HermesError("http_error", "Session create returned no id", 200);
    return { sessionId };
  }

  /** Drain an SSE body, feeding every event to onEvent and folding the text. */
  private async drain(
    res: Response,
    onEvent: (event: SseEvent) => void,
  ): Promise<{ text: string; runId: string | null; sessionId: string | null }> {
    const parser = createSseParser();
    const decoder = new TextDecoder();
    const reader = res.body?.getReader();

    let accumulated = "";
    let completed: string | null = null;
    let runId: string | null = null;
    let sessionId: string | null = null;
    let failure: string | null = null;

    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        for (const event of parser.push(decoder.decode(value, { stream: true }))) {
          onEvent(event);

          if (typeof event.data.run_id === "string") runId = event.data.run_id;
          if (typeof event.data.session_id === "string") sessionId = event.data.session_id;

          if (event.event === "assistant.delta" && typeof event.data.delta === "string") {
            accumulated += event.data.delta;
          } else if (event.event === "assistant.completed" && typeof event.data.content === "string") {
            completed = event.data.content;
          } else if (event.event === "run.failed" || event.event === "error") {
            failure = typeof event.data.message === "string" ? event.data.message : "Hermes run failed";
          }

          if (isTerminalEvent(event.event)) break;
        }
      }
    }
    parser.flush();

    if (failure) throw new HermesError("http_error", failure, 200);
    return { text: completed ?? accumulated, runId, sessionId };
  }

  async streamSessionChat(args: {
    sessionId: string;
    message: string;
    sessionKey?: string;
    onEvent: (event: SseEvent) => void;
  }): Promise<{ text: string; runId: string | null; sessionId: string }> {
    const res = await this.request(`/api/sessions/${encodeURIComponent(args.sessionId)}/chat/stream`, {
      method: "POST",
      body: JSON.stringify({ message: args.message }),
      sessionKey: args.sessionKey,
    });
    const drained = await this.drain(res, args.onEvent);
    return { text: drained.text, runId: drained.runId, sessionId: drained.sessionId ?? args.sessionId };
  }

  async startRun(args: {
    input: string;
    conversationHistory?: Array<{ role: string; content: string }>;
    instructions?: string;
    sessionKey?: string;
  }): Promise<{ runId: string }> {
    const body: Record<string, unknown> = { input: args.input };
    if (args.conversationHistory?.length) body.conversation_history = args.conversationHistory;
    if (args.instructions) body.instructions = args.instructions;

    const res = await this.request("/v1/runs", {
      method: "POST",
      body: JSON.stringify(body),
      sessionKey: args.sessionKey,
    });
    const json = (await res.json()) as { run_id?: string };
    if (!json.run_id) throw new HermesError("http_error", "Run submission returned no run_id", 202);
    return { runId: json.run_id };
  }

  async streamRunEvents(runId: string, onEvent: (event: SseEvent) => void): Promise<{ text: string }> {
    const res = await this.request(`/v1/runs/${encodeURIComponent(runId)}/events`, { method: "GET" });
    const drained = await this.drain(res, onEvent);
    return { text: drained.text };
  }

  async stopRun(runId: string): Promise<void> {
    await this.request(`/v1/runs/${encodeURIComponent(runId)}/stop`, { method: "POST", body: "{}" });
  }

  async steerRun(runId: string, text: string): Promise<void> {
    await this.request(`/v1/runs/${encodeURIComponent(runId)}/steer`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/lib/hermes/hermes-client.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/hermes/hermes-client.ts src/lib/hermes/hermes-client.test.ts
git commit -m "feat(hermes): add profile-scoped HTTP/SSE client"
```

---

## Task 4: 스키마 — `hermes_profiles` + `npcs` 컬럼

**Files:**
- Modify: `src/db/schema.ts`, `src/db/schema.pg.cjs`, `src/db/schema-sqlite.ts`, `src/db/schema.sqlite.cjs`
- Modify: `src/db/sqlite-base-schema.js` (빈 DB 부트스트랩)
- Modify: `src/db/server-db.js` — `ensureSqliteCompatibility()` (기존 DB 승격)
- Modify: `src/db/index.ts` (export 추가)
- Modify: `src/db/schema-drift.test.ts:34` — `EXPECTED_TABLE_COUNT` 29 → 30
- Test: `src/db/hermes-profiles-schema.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces: `hermesProfiles` 테이블 export. 컬럼 — `id`, `gatewayId`, `profileName`, `tokenEncrypted`, `displayName`, `description`, `provisionedByDeskrpg`, `lastValidatedAt`, `lastValidationStatus`, `lastValidationError`, `createdAt`, `updatedAt`. `npcs.hermesProfileId`, `npcs.agentConfig`.

`npcs.openclaw_config`는 **이 단계에서 삭제하지 않는다.** `agent_config`를 추가하고 신규 코드만 그것을 읽는다. 두 컬럼 병존은 P4에서 정리한다 — 지금 지우면 롤백 경로가 사라진다.

- [ ] **Step 1: Write the failing test**

```typescript
// src/db/hermes-profiles-schema.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { getTableConfig } from "drizzle-orm/pg-core";
import { getTableColumns } from "drizzle-orm";

import { hermesProfiles, npcs } from "./schema";

test("hermes_profiles has the profile triple and validation columns", () => {
  const cols = getTableColumns(hermesProfiles);
  for (const name of [
    "id", "gatewayId", "profileName", "tokenEncrypted", "displayName",
    "description", "provisionedByDeskrpg",
    "lastValidatedAt", "lastValidationStatus", "lastValidationError",
    "createdAt", "updatedAt",
  ]) {
    assert.ok(name in cols, `missing column: ${name}`);
  }
});

test("hermes_profiles enforces one profile name per gateway", () => {
  const config = getTableConfig(hermesProfiles);
  const unique = config.uniqueConstraints.concat(
    config.indexes.filter((i) => i.config.unique) as never[],
  );
  assert.ok(unique.length > 0, "expected a unique constraint on (gateway_id, profile_name)");
});

test("npcs gains hermes_profile_id and agent_config while keeping openclaw_config", () => {
  const cols = getTableColumns(npcs);
  assert.ok("hermesProfileId" in cols);
  assert.ok("agentConfig" in cols);
  assert.ok("openclawConfig" in cols, "openclaw_config must survive P1 for rollback");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/db/hermes-profiles-schema.test.ts`
Expected: FAIL — `hermesProfiles` is not exported from `./schema`

- [ ] **Step 3: Write minimal implementation**

`src/db/schema.ts` — `gatewayShares` 정의 뒤에 추가:

```typescript
export const hermesProfiles = pgTable("hermes_profiles", {
  id: uuid("id").defaultRandom().primaryKey(),
  gatewayId: uuid("gateway_id").notNull().references(() => gatewayResources.id, { onDelete: "cascade" }),
  profileName: varchar("profile_name", { length: 120 }).notNull(),
  tokenEncrypted: text("token_encrypted").notNull(),
  displayName: varchar("display_name", { length: 120 }),
  description: text("description"),
  provisionedByDeskrpg: boolean("provisioned_by_deskrpg").notNull().default(false),
  lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
  lastValidationStatus: varchar("last_validation_status", { length: 40 }),
  lastValidationError: text("last_validation_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_hermes_profiles_gateway_id").on(table.gatewayId),
  uniqueIndex("hermes_profiles_gateway_name_idx").on(table.gatewayId, table.profileName),
]);
```

같은 파일의 `npcs` 정의(현재 252행 부근)에 두 컬럼 추가:

```typescript
  hermesProfileId: uuid("hermes_profile_id").references(() => hermesProfiles.id, { onDelete: "set null" }),
  agentConfig: jsonb("agent_config"),
```

`src/db/schema.pg.cjs`, `src/db/schema-sqlite.ts`, `src/db/schema.sqlite.cjs`에 동일 정의를 각 방언 문법으로 반영한다. SQLite는 `text("...")` + `integer(..., { mode: "boolean" })` + ISO 문자열 타임스탬프를 쓴다 — 같은 파일 내 `gatewayResources` 정의를 그대로 본떠라.

`src/db/sqlite-base-schema.js` — `gateway_shares` 블록 뒤에 추가:

```javascript
    CREATE TABLE IF NOT EXISTS hermes_profiles (
      id TEXT PRIMARY KEY NOT NULL,
      gateway_id TEXT NOT NULL REFERENCES gateway_resources(id) ON DELETE CASCADE,
      profile_name TEXT NOT NULL,
      token_encrypted TEXT NOT NULL,
      display_name TEXT,
      description TEXT,
      provisioned_by_deskrpg INTEGER NOT NULL DEFAULT 0,
      last_validated_at TEXT,
      last_validation_status TEXT,
      last_validation_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hermes_profiles_gateway_id ON hermes_profiles(gateway_id);
    CREATE UNIQUE INDEX IF NOT EXISTS hermes_profiles_gateway_name_idx ON hermes_profiles(gateway_id, profile_name);
```

`src/db/server-db.js`의 `ensureSqliteCompatibility()` — 같은 `CREATE TABLE IF NOT EXISTS` 블록을 추가하고, 이어서 기존 DB 승격용 컬럼 추가를 넣는다. SQLite는 `ADD COLUMN IF NOT EXISTS`가 없으므로 `PRAGMA table_info`로 확인한다:

```javascript
  const npcCols = sqlite.prepare("PRAGMA table_info(npcs)").all().map((c) => c.name);
  if (!npcCols.includes("hermes_profile_id")) {
    sqlite.exec("ALTER TABLE npcs ADD COLUMN hermes_profile_id TEXT REFERENCES hermes_profiles(id) ON DELETE SET NULL");
  }
  if (!npcCols.includes("agent_config")) {
    sqlite.exec("ALTER TABLE npcs ADD COLUMN agent_config TEXT");
  }
```

`src/db/index.ts`에 `hermesProfiles`를 re-export한다.

`src/db/schema-drift.test.ts:34` — `const EXPECTED_TABLE_COUNT = 30;`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test src/db/hermes-profiles-schema.test.ts src/db/schema-drift.test.ts src/db/index.test.ts`
Expected: PASS — 특히 `schema-drift.test.ts`가 4개 스키마 파일의 구조적 동일성을 통과해야 한다

- [ ] **Step 5: Generate the PostgreSQL migration**

Run: `npm run db:generate`
Expected: `drizzle/0003_*.sql` 생성. 열어서 `CREATE TABLE "hermes_profiles"` + `ALTER TABLE "npcs" ADD COLUMN "hermes_profile_id"` + `ADD COLUMN "agent_config"`가 있는지 확인한다. `ADD CONSTRAINT IF NOT EXISTS`가 있으면 `DO $$ ... EXCEPTION WHEN duplicate_object THEN NULL; END $$;`로 바꾼다.

- [ ] **Step 6: Verify a blank SQLite database boots**

```bash
rm -rf /tmp/deskrpg-p1 && DESKRPG_HOME=/tmp/deskrpg-p1 node bin/deskrpg.js init
DESKRPG_HOME=/tmp/deskrpg-p1 node bin/deskrpg.js doctor
```
Expected: 오류 없이 완료. `sqlite3 /tmp/deskrpg-p1/data/deskrpg.db ".schema hermes_profiles"`가 테이블을 출력한다.

- [ ] **Step 7: Commit**

```bash
git add src/db drizzle
git commit -m "feat(db): add hermes_profiles table and npc profile binding columns"
```

---

## Task 5: 프로필 자원 계층

**Files:**
- Create: `src/lib/hermes-profiles.ts`
- Test: `src/lib/hermes-profiles.test.ts`

**Interfaces:**
- Consumes: `hermesProfiles` (Task 4), `encryptGatewayToken`/`decryptGatewayToken`/`getAccessibleGatewayResource` (기존 `src/lib/gateway-resources.ts`), `HermesClient`/`HermesError` (Task 3)
- Produces:
  - `function buildProfileClient(input: { baseUrl: string; profileName: string; tokenEncrypted: string; fetchImpl?: typeof fetch }): HermesClient`
  - `async function registerHermesProfile(input: { userId: string; gatewayId: string; profileName: string; token: string; displayName?: string }): Promise<{ profile: typeof hermesProfiles.$inferSelect } | { error: "forbidden" | "duplicate" }>`
  - `async function listHermesProfiles(userId: string, gatewayId: string): Promise<Array<{ id: string; profileName: string; displayName: string | null; lastValidationStatus: string | null }>>`
  - `async function getProfileClientForNpc(npcId: string): Promise<HermesClient | null>`
  - `async function validateHermesProfile(userId: string, profileId: string): Promise<{ status: "valid" | "unauthorized" | "unknown_profile" | "unreachable" | "error"; error?: string; capabilities?: HermesCapabilities }>`

토큰은 **평문으로 반환하지 않는다.** 클라이언트 조립 시점에만 복호화한다.

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/hermes-profiles.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildProfileClient, mapValidationError } from "./hermes-profiles";
import { encryptGatewayToken } from "./gateway-resources";
import { HermesError } from "./hermes/hermes-client";

describe("buildProfileClient", () => {
  test("decrypts the stored token and scopes the URL to the profile", async () => {
    const tokenEncrypted = encryptGatewayToken("plain-key-1234567890");
    let seen: { url: string; auth: string | null } = { url: "", auth: null };

    const fetchImpl = async (u: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(u), auth: new Headers(init?.headers).get("Authorization") };
      return new Response(JSON.stringify({ features: {}, endpoints: {} }), { status: 200 });
    };

    const client = buildProfileClient({
      baseUrl: "http://gw:8642",
      profileName: "sophie",
      tokenEncrypted,
      fetchImpl: fetchImpl as typeof fetch,
    });
    await client.getCapabilities();

    assert.equal(seen.url, "http://gw:8642/p/sophie/v1/capabilities");
    assert.equal(seen.auth, "Bearer plain-key-1234567890");
  });
});

describe("mapValidationError", () => {
  test("maps HermesError codes to persisted validation statuses", () => {
    assert.equal(mapValidationError(new HermesError("unauthorized", "x", 401)), "unauthorized");
    assert.equal(mapValidationError(new HermesError("unknown_profile", "x", 404)), "unknown_profile");
    assert.equal(mapValidationError(new HermesError("unreachable", "x", 0)), "unreachable");
    assert.equal(mapValidationError(new HermesError("http_error", "x", 500)), "error");
  });

  test("maps a non-Hermes throw to a generic error", () => {
    assert.equal(mapValidationError(new Error("boom")), "error");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/lib/hermes-profiles.test.ts`
Expected: FAIL — `Cannot find module './hermes-profiles'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/lib/hermes-profiles.ts
import { and, eq } from "drizzle-orm";

import { db, hermesProfiles, isPostgres, npcs, gatewayResources } from "@/db";
import { decryptGatewayToken, encryptGatewayToken, getAccessibleGatewayResource } from "@/lib/gateway-resources";
import { HermesClient, HermesError } from "@/lib/hermes/hermes-client";
import type { HermesCapabilities } from "@/lib/hermes/types";

function nowForDb() {
  return (isPostgres ? new Date() : new Date().toISOString()) as unknown as Date;
}

export type ProfileValidationStatus =
  | "valid" | "unauthorized" | "unknown_profile" | "unreachable" | "error";

export function mapValidationError(err: unknown): Exclude<ProfileValidationStatus, "valid"> {
  if (err instanceof HermesError) {
    if (err.code === "unauthorized") return "unauthorized";
    if (err.code === "unknown_profile") return "unknown_profile";
    if (err.code === "unreachable") return "unreachable";
  }
  return "error";
}

export function buildProfileClient(input: {
  baseUrl: string;
  profileName: string;
  tokenEncrypted: string;
  fetchImpl?: typeof fetch;
}): HermesClient {
  return new HermesClient({
    baseUrl: input.baseUrl,
    profileName: input.profileName === "default" ? null : input.profileName,
    token: decryptGatewayToken(input.tokenEncrypted),
    fetchImpl: input.fetchImpl,
  });
}

export async function registerHermesProfile(input: {
  userId: string;
  gatewayId: string;
  profileName: string;
  token: string;
  displayName?: string;
}) {
  const access = await getAccessibleGatewayResource(input.userId, input.gatewayId);
  if (!access) return { error: "forbidden" as const };

  const profileName = input.profileName.trim();
  const existing = await db.select().from(hermesProfiles).where(and(
    eq(hermesProfiles.gatewayId, input.gatewayId),
    eq(hermesProfiles.profileName, profileName),
  )).limit(1);

  if (existing[0]) {
    const [updated] = await db.update(hermesProfiles).set({
      tokenEncrypted: encryptGatewayToken(input.token.trim()),
      displayName: input.displayName?.trim() || existing[0].displayName,
      updatedAt: nowForDb(),
    }).where(eq(hermesProfiles.id, existing[0].id)).returning();
    return { profile: updated };
  }

  const [created] = await db.insert(hermesProfiles).values({
    gatewayId: input.gatewayId,
    profileName,
    tokenEncrypted: encryptGatewayToken(input.token.trim()),
    displayName: input.displayName?.trim() || profileName,
  }).returning();

  return { profile: created };
}

export async function listHermesProfiles(userId: string, gatewayId: string) {
  const access = await getAccessibleGatewayResource(userId, gatewayId);
  if (!access) return [];

  const rows = await db.select().from(hermesProfiles).where(eq(hermesProfiles.gatewayId, gatewayId));
  return rows.map((row) => ({
    id: row.id,
    profileName: row.profileName,
    displayName: row.displayName,
    lastValidationStatus: row.lastValidationStatus,
  }));
}

export async function validateHermesProfile(userId: string, profileId: string): Promise<{
  status: ProfileValidationStatus;
  error?: string;
  capabilities?: HermesCapabilities;
}> {
  const [row] = await db.select().from(hermesProfiles).where(eq(hermesProfiles.id, profileId)).limit(1);
  if (!row) return { status: "error", error: "profile_not_found" };

  const access = await getAccessibleGatewayResource(userId, row.gatewayId);
  if (!access) return { status: "error", error: "forbidden" };

  try {
    const client = buildProfileClient({
      baseUrl: access.resource.baseUrl,
      profileName: row.profileName,
      tokenEncrypted: row.tokenEncrypted,
    });
    const capabilities = await client.getCapabilities();
    await db.update(hermesProfiles).set({
      lastValidatedAt: nowForDb(),
      lastValidationStatus: "valid",
      lastValidationError: null,
      updatedAt: nowForDb(),
    }).where(eq(hermesProfiles.id, profileId));
    return { status: "valid", capabilities };
  } catch (err) {
    const status = mapValidationError(err);
    const message = err instanceof Error ? err.message : "unknown";
    await db.update(hermesProfiles).set({
      lastValidatedAt: nowForDb(),
      lastValidationStatus: status,
      lastValidationError: message,
      updatedAt: nowForDb(),
    }).where(eq(hermesProfiles.id, profileId));
    return { status, error: message };
  }
}

export async function getProfileClientForNpc(npcId: string): Promise<HermesClient | null> {
  const rows = await db
    .select({
      profileName: hermesProfiles.profileName,
      tokenEncrypted: hermesProfiles.tokenEncrypted,
      baseUrl: gatewayResources.baseUrl,
    })
    .from(npcs)
    .innerJoin(hermesProfiles, eq(npcs.hermesProfileId, hermesProfiles.id))
    .innerJoin(gatewayResources, eq(hermesProfiles.gatewayId, gatewayResources.id))
    .where(eq(npcs.id, npcId))
    .limit(1);

  if (!rows[0]) return null;
  return buildProfileClient(rows[0]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/lib/hermes-profiles.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/hermes-profiles.ts src/lib/hermes-profiles.test.ts
git commit -m "feat(hermes): add profile resource layer with validation and client assembly"
```

---

## Task 6: 어댑터 인터페이스 정리

**Files:**
- Modify: `src/lib/adapters/types.ts:4-18`
- Modify: `src/lib/adapters/openclaw-adapter.ts:32` (제거된 필드 대응)
- Modify: `src/server/socket-handlers.ts` (`agentId`/`channelId` 전달 지점)
- Test: `src/lib/adapters/types.test.ts` (기존 파일 확장)

**Interfaces:**
- Consumes: 없음
- Produces: 개정된 `AdapterExecuteOptions` — `conversationHistory?`, `onToolProgress?`, `onRunStarted?` 추가. `agentId`/`channelId` 제거.

OpenClaw 어댑터는 `executeWithGateway(gateway, options, agentId)` 형태로 `agentId`를 **별도 인자**로 받게 바꾼다. 옵션 객체에서 백엔드 전용 필드를 몰아내는 것이 이 태스크의 목적이므로, OpenClaw만을 위해 필드를 남기면 목적을 잃는다.

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/adapters/types.test.ts 에 추가
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { AdapterExecuteOptions } from "./types";

describe("AdapterExecuteOptions", () => {
  test("carries backend-neutral multi-party and control fields", () => {
    const options: AdapterExecuteOptions = {
      sessionKey: "s",
      prompt: "p",
      conversationHistory: [{ role: "user", content: "이전 발언" }],
      onToolProgress: () => {},
      onRunStarted: () => {},
    };
    assert.equal(options.conversationHistory?.[0].role, "user");
    assert.equal(typeof options.onToolProgress, "function");
    assert.equal(typeof options.onRunStarted, "function");
  });

  test("no longer accepts OpenClaw-specific fields", () => {
    // @ts-expect-error agentId was removed from the neutral options object
    const bad: AdapterExecuteOptions = { sessionKey: "s", prompt: "p", agentId: "a" };
    assert.ok(bad);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc --noEmit`
Expected: FAIL — `@ts-expect-error` 지시자가 "사용되지 않음"으로 보고된다(아직 `agentId`가 존재하므로)

- [ ] **Step 3: Write minimal implementation**

`src/lib/adapters/types.ts:4-18`을 교체:

```typescript
export interface AdapterExecuteOptions {
  sessionKey: string;
  prompt: string;
  /** Multi-party transcript owned by the caller (ConversationEngine). */
  conversationHistory?: Array<{ role: string; content: string }>;
  onDelta?: (chunk: string) => void;
  onToolProgress?: (toolName: string, preview: string) => void;
  /** Fires as soon as the backend assigns a run handle, for abort/steer. */
  onRunStarted?: (runId: string) => void;
  attachments?: AdapterAttachment[];
  model?: string;
  locale?: string;
  timeoutMs?: number;
  userId?: string;
  projectId?: string;
}
```

`src/lib/adapters/openclaw-adapter.ts:28-46`의 `executeWithGateway` 시그니처를 `(gateway, options, agentId)`로 바꾸고, 내부에서 `options.agentId` 대신 인자를 쓴다.

`src/server/socket-handlers.ts`의 호출 지점(392·656·750행 부근)에서 `agentId`를 옵션 객체가 아니라 세 번째 인자로 넘기도록 수정한다.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsc --noEmit && npm test`
Expected: 타입 체크 통과, 기존 테스트 전부 통과 (`openclaw-adapter.test.ts` 포함)

- [ ] **Step 5: Commit**

```bash
git add src/lib/adapters src/server/socket-handlers.ts
git commit -m "refactor(adapters): make AdapterExecuteOptions backend-neutral"
```

---

## Task 7: HermesAdapter

**Files:**
- Create: `src/lib/adapters/hermes-adapter.ts`
- Test: `src/lib/adapters/hermes-adapter.test.ts`

**Interfaces:**
- Consumes: `HermesClient` (Task 3), `AdapterExecuteOptions`/`NpcAdapter`/`AdapterHealthResult` (Task 6)
- Produces:
  - `class HermesAdapter implements NpcAdapter` — `readonly type = "hermes"`
  - `constructor(client: HermesClient, opts?: { sessionId?: string })`
  - `execute(options)` — `conversationHistory`가 있으면 runs 경로, 없으면 session 경로
  - `abort(sessionKey)` — 마지막 `runId`로 `stopRun`
  - `steer(text)` — 마지막 `runId`로 `steerRun`
  - `testConnection()` — capabilities 조회

어댑터는 클라이언트를 **주입받는다.** DB를 몰라야 테스트가 게이트웨이 없이 돌고, 프로필 해석은 `getProfileClientForNpc`(Task 5)의 일이다.

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/adapters/hermes-adapter.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { HermesAdapter } from "./hermes-adapter";
import { HermesClient } from "@/lib/hermes/hermes-client";

function sseResponse(frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

function clientWith(handler: (url: string, init?: RequestInit) => Response) {
  const fetchImpl = async (u: string | URL | Request, init?: RequestInit) => handler(String(u), init);
  return new HermesClient({
    baseUrl: "http://gw:8642", profileName: "sophie", token: "t",
    fetchImpl: fetchImpl as typeof fetch,
  });
}

describe("HermesAdapter", () => {
  test("type is 'hermes'", () => {
    assert.equal(new HermesAdapter(clientWith(() => new Response("{}"))).type, "hermes");
  });

  test("uses the session chat path for 1:1 conversation", async () => {
    const urls: string[] = [];
    const client = clientWith((url) => {
      urls.push(url);
      return sseResponse([
        'event: assistant.delta\ndata: {"delta":"반갑","run_id":"r1"}\n\n',
        'event: assistant.completed\ndata: {"content":"반갑습니다","session_id":"sess-1","run_id":"r1"}\n\n',
      ]);
    });

    const adapter = new HermesAdapter(client, { sessionId: "sess-1" });
    const chunks: string[] = [];
    const result = await adapter.execute({
      sessionKey: "npc-1-dm-user-9",
      prompt: "안녕",
      onDelta: (c) => chunks.push(c),
    });

    assert.equal(result.response, "반갑습니다");
    assert.equal(result.session.sessionRef, "sess-1");
    assert.deepEqual(chunks, ["반갑"]);
    assert.ok(urls[0].includes("/p/sophie/api/sessions/sess-1/chat/stream"), urls[0]);
  });

  test("uses the runs path when conversation history is supplied", async () => {
    const urls: string[] = [];
    const client = clientWith((url) => {
      urls.push(url);
      if (url.endsWith("/v1/runs")) return new Response(JSON.stringify({ run_id: "r9" }), { status: 202 });
      return sseResponse(['event: assistant.completed\ndata: {"content":"제 의견은"}\n\n']);
    });

    const adapter = new HermesAdapter(client);
    const result = await adapter.execute({
      sessionKey: "meeting-1",
      prompt: "발언하세요",
      conversationHistory: [{ role: "user", content: "주제: 배포 전략" }],
    });

    assert.equal(result.response, "제 의견은");
    assert.ok(urls[0].endsWith("/p/sophie/v1/runs"), urls[0]);
    assert.ok(urls[1].includes("/v1/runs/r9/events"), urls[1]);
  });

  test("reports the run handle so callers can abort", async () => {
    const client = clientWith((url) => {
      if (url.endsWith("/v1/runs")) return new Response(JSON.stringify({ run_id: "r5" }), { status: 202 });
      return sseResponse(['event: assistant.completed\ndata: {"content":"ok"}\n\n']);
    });

    const adapter = new HermesAdapter(client);
    const seen: string[] = [];
    await adapter.execute({
      sessionKey: "m", prompt: "p",
      conversationHistory: [{ role: "user", content: "c" }],
      onRunStarted: (id) => seen.push(id),
    });
    assert.deepEqual(seen, ["r5"]);
  });

  test("forwards tool progress to the caller", async () => {
    const client = clientWith(() => sseResponse([
      'event: tool.progress\ndata: {"tool_name":"read_file","delta":"src/app.ts"}\n\n',
      'event: assistant.completed\ndata: {"content":"완료"}\n\n',
    ]));

    const adapter = new HermesAdapter(client, { sessionId: "s" });
    const progress: Array<[string, string]> = [];
    await adapter.execute({
      sessionKey: "k", prompt: "p",
      onToolProgress: (name, preview) => progress.push([name, preview]),
    });
    assert.deepEqual(progress, [["read_file", "src/app.ts"]]);
  });

  test("abort stops the last run", async () => {
    const urls: string[] = [];
    const client = clientWith((url) => {
      urls.push(url);
      if (url.endsWith("/v1/runs")) return new Response(JSON.stringify({ run_id: "r2" }), { status: 202 });
      if (url.includes("/stop")) return new Response("{}", { status: 200 });
      return sseResponse(['event: assistant.completed\ndata: {"content":"x"}\n\n']);
    });

    const adapter = new HermesAdapter(client);
    await adapter.execute({ sessionKey: "k", prompt: "p", conversationHistory: [{ role: "user", content: "c" }] });
    await adapter.abort("k");
    assert.ok(urls.some((u) => u.endsWith("/v1/runs/r2/stop")), urls.join("\n"));
  });

  test("abort is a no-op when no run is in flight", async () => {
    const adapter = new HermesAdapter(clientWith(() => new Response("{}")));
    await adapter.abort("k"); // must not throw
  });

  test("testConnection reports ok when capabilities are readable", async () => {
    const client = clientWith(() => new Response(
      JSON.stringify({ features: { run_steer: true }, endpoints: {}, version: "0.20.2" }),
      { status: 200 },
    ));
    const result = await new HermesAdapter(client).testConnection({});
    assert.equal(result.status, "ok");
  });

  test("testConnection reports error on 401", async () => {
    const client = clientWith(() => new Response("{}", { status: 401 }));
    const result = await new HermesAdapter(client).testConnection({});
    assert.equal(result.status, "error");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/lib/adapters/hermes-adapter.test.ts`
Expected: FAIL — `Cannot find module './hermes-adapter'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/lib/adapters/hermes-adapter.ts
// NpcAdapter over a profile-scoped HermesClient.
// Two call paths: persisted session chat (1:1) and runs + history (multi-party).

import { HermesClient } from "@/lib/hermes/hermes-client";
import type { SseEvent } from "@/lib/hermes/sse";
import type {
  AdapterExecuteOptions,
  AdapterHealthResult,
  AdapterSessionInfo,
  NpcAdapter,
} from "./types";

export class HermesAdapter implements NpcAdapter {
  readonly type = "hermes";

  private readonly client: HermesClient;
  private sessionId: string | null;
  private lastRunId: string | null = null;

  constructor(client: HermesClient, opts?: { sessionId?: string }) {
    this.client = client;
    this.sessionId = opts?.sessionId ?? null;
  }

  private relay(options: AdapterExecuteOptions) {
    return (event: SseEvent) => {
      if (typeof event.data.run_id === "string" && event.data.run_id !== this.lastRunId) {
        this.lastRunId = event.data.run_id;
        options.onRunStarted?.(event.data.run_id);
      }
      if (event.event === "assistant.delta" && typeof event.data.delta === "string") {
        options.onDelta?.(event.data.delta);
      }
      if (event.event === "tool.progress") {
        const name = typeof event.data.tool_name === "string" ? event.data.tool_name : "";
        const preview = typeof event.data.delta === "string" ? event.data.delta : "";
        options.onToolProgress?.(name, preview);
      }
    };
  }

  async execute(options: AdapterExecuteOptions): Promise<{
    response: string;
    session: AdapterSessionInfo;
  }> {
    const onEvent = this.relay(options);

    if (options.conversationHistory?.length) {
      const { runId } = await this.client.startRun({
        input: options.prompt,
        conversationHistory: options.conversationHistory,
        sessionKey: options.sessionKey,
      });
      this.lastRunId = runId;
      options.onRunStarted?.(runId);

      const { text } = await this.client.streamRunEvents(runId, onEvent);
      return { response: text, session: { sessionRef: options.sessionKey, displayId: runId } };
    }

    if (!this.sessionId) {
      const created = await this.client.createSession(options.sessionKey);
      this.sessionId = created.sessionId;
    }

    const result = await this.client.streamSessionChat({
      sessionId: this.sessionId,
      message: options.prompt,
      sessionKey: options.sessionKey,
      onEvent,
    });
    this.sessionId = result.sessionId;
    this.lastRunId = result.runId;

    return { response: result.text, session: { sessionRef: result.sessionId } };
  }

  async abort(_sessionKey: string): Promise<void> {
    if (!this.lastRunId) return;
    await this.client.stopRun(this.lastRunId);
  }

  async steer(text: string): Promise<void> {
    if (!this.lastRunId) return;
    await this.client.steerRun(this.lastRunId, text);
  }

  async testConnection(_config: Record<string, unknown>): Promise<AdapterHealthResult> {
    try {
      await this.client.getCapabilities();
      return { status: "ok" };
    } catch (err) {
      return { status: "error", message: err instanceof Error ? err.message : "unknown" };
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/lib/adapters/hermes-adapter.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/adapters/hermes-adapter.ts src/lib/adapters/hermes-adapter.test.ts
git commit -m "feat(adapters): add HermesAdapter with session and run call paths"
```

---

## Task 8: 프로필 API 라우트

**Files:**
- Create: `src/app/api/gateways/[id]/profiles/route.ts`
- Create: `src/app/api/gateways/[id]/profiles/[profileId]/test/route.ts`
- Create: `src/app/api/npcs/[id]/rebind/route.ts`
- Test: `src/app/api/gateways/profiles-route.test.ts`

**Interfaces:**
- Consumes: `listHermesProfiles`/`registerHermesProfile`/`validateHermesProfile` (Task 5), `hermesProfiles`/`npcs` (Task 4)
- Produces: HTTP 계약
  - `GET /api/gateways/{id}/profiles` → `{ profiles: Array<{ id, profileName, displayName, lastValidationStatus }> }`
  - `POST /api/gateways/{id}/profiles` body `{ profileName, token, displayName? }` → `201 { profile }` / `403 { errorCode: "forbidden" }` / `400 { errorCode: "invalid_token" }`
  - `POST /api/gateways/{id}/profiles/{profileId}/test` → `{ status, error?, capabilities? }`
  - `POST /api/npcs/{id}/rebind` body `{ profileId }` → `{ npc }` / `404`

기존 라우트의 인증 패턴(`src/app/api/gateways/[id]/test/route.ts`)을 그대로 따른다. `token`은 **16자 미만이면 거부**한다 — Hermes가 `has_usable_secret(key, min_length=16)`로 fail-closed 판정하므로, 짧은 키를 저장하면 등록은 성공하고 사용만 401로 실패하는 최악의 조합이 된다.

- [ ] **Step 1: Write the failing test**

```typescript
// src/app/api/gateways/profiles-route.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { validateProfileRegistration } from "@/app/api/gateways/[id]/profiles/validation";

describe("validateProfileRegistration", () => {
  test("accepts a well-formed registration", () => {
    const result = validateProfileRegistration({ profileName: "sophie", token: "0123456789abcdef01" });
    assert.equal(result.ok, true);
  });

  test("rejects a token shorter than Hermes's 16-char floor", () => {
    const result = validateProfileRegistration({ profileName: "sophie", token: "short" });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "invalid_token");
  });

  test("rejects an empty profile name", () => {
    const result = validateProfileRegistration({ profileName: "   ", token: "0123456789abcdef01" });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "invalid_profile_name");
  });

  test("rejects a profile name with URL-unsafe characters", () => {
    const result = validateProfileRegistration({ profileName: "so/phie", token: "0123456789abcdef01" });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "invalid_profile_name");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/app/api/gateways/profiles-route.test.ts`
Expected: FAIL — `Cannot find module '@/app/api/gateways/[id]/profiles/validation'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/app/api/gateways/[id]/profiles/validation.ts
/** Hermes rejects profile-scoped keys under 16 chars (hermes_cli.auth.has_usable_secret). */
const MIN_TOKEN_LENGTH = 16;
const PROFILE_NAME_RE = /^[A-Za-z0-9._-]+$/;

export type RegistrationValidation =
  | { ok: true; profileName: string; token: string }
  | { ok: false; errorCode: "invalid_profile_name" | "invalid_token" };

export function validateProfileRegistration(input: {
  profileName?: unknown;
  token?: unknown;
}): RegistrationValidation {
  const profileName = typeof input.profileName === "string" ? input.profileName.trim() : "";
  const token = typeof input.token === "string" ? input.token.trim() : "";

  if (!profileName || !PROFILE_NAME_RE.test(profileName)) {
    return { ok: false, errorCode: "invalid_profile_name" };
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    return { ok: false, errorCode: "invalid_token" };
  }
  return { ok: true, profileName, token };
}
```

이어서 세 라우트를 작성한다. `src/app/api/gateways/[id]/test/route.ts`의 세션 인증 헬퍼와 응답 형태를 그대로 본떠 `GET`/`POST` 핸들러를 만들고, 본문 검증은 위 `validateProfileRegistration`을 호출한다. `rebind` 라우트는 `npcs.hermesProfileId`를 설정하고 `adapterType`을 `"hermes"`로 갱신한다.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test src/app/api/gateways/profiles-route.test.ts && npx tsc --noEmit`
Expected: PASS (4 tests), 타입 체크 통과

- [ ] **Step 5: Manually exercise the routes against a local gateway**

```bash
# 사전: hermes gateway가 multiplex_profiles + api_server로 떠 있어야 함
npm run dev
# 다른 터미널에서 — 세션 쿠키는 브라우저 로그인 후 복사
curl -s -X POST localhost:3000/api/gateways/<GW_ID>/profiles \
  -H 'Content-Type: application/json' -b "$COOKIE" \
  -d '{"profileName":"sophie","token":"'"$KEY"'"}' | jq
curl -s -X POST localhost:3000/api/gateways/<GW_ID>/profiles/<PROFILE_ID>/test -b "$COOKIE" | jq
```
Expected: 등록은 `201`, 검증은 `{"status":"valid"}`. 일부러 틀린 키로 등록하면 `{"status":"unauthorized"}`.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/gateways src/app/api/npcs
git commit -m "feat(api): add Hermes profile registration, validation and NPC rebind routes"
```

---

## Task 9: 소켓 배선 — DM 경로를 Hermes로

**Files:**
- Modify: `src/server/socket-handlers.ts:56-90` (어댑터 등록), `:639-700` (NPC 채팅 분기)
- Test: `src/server/hermes-dispatch.test.ts`

**Interfaces:**
- Consumes: `HermesAdapter` (Task 7), `getProfileClientForNpc` (Task 5)
- Produces: `function resolveNpcAdapter(npcConfig: { adapterType: string; id: string }): Promise<NpcAdapter | null>` — `adapterType === "hermes"`면 프로필 클라이언트를 조립해 `HermesAdapter`를 만들고, 아니면 기존 레지스트리에서 찾는다. `"unbound"`면 `null`.

`unbound` NPC(마이그레이션으로 연결이 끊긴 기존 NPC)는 **조용히 실패하지 않고** `npc_unbound` 시스템 메시지를 낸다.

- [ ] **Step 1: Write the failing test**

```typescript
// src/server/hermes-dispatch.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { classifyNpcDispatch } from "./hermes-dispatch";

describe("classifyNpcDispatch", () => {
  test("routes hermes NPCs to the profile-backed adapter", () => {
    assert.equal(classifyNpcDispatch({ adapterType: "hermes", hermesProfileId: "p1" }), "hermes");
  });

  test("reports unbound when a hermes NPC has no profile", () => {
    assert.equal(classifyNpcDispatch({ adapterType: "hermes", hermesProfileId: null }), "unbound");
  });

  test("reports unbound for migration-marked NPCs", () => {
    assert.equal(classifyNpcDispatch({ adapterType: "unbound", hermesProfileId: null }), "unbound");
  });

  test("leaves CLI adapters on the registry path", () => {
    assert.equal(classifyNpcDispatch({ adapterType: "claude", hermesProfileId: null }), "registry");
  });

  test("leaves openclaw on the legacy gateway path during P1", () => {
    assert.equal(classifyNpcDispatch({ adapterType: "openclaw", hermesProfileId: null }), "openclaw");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/server/hermes-dispatch.test.ts`
Expected: FAIL — `Cannot find module './hermes-dispatch'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/server/hermes-dispatch.ts
export type NpcDispatchKind = "hermes" | "openclaw" | "registry" | "unbound";

export function classifyNpcDispatch(npc: {
  adapterType: string;
  hermesProfileId: string | null;
}): NpcDispatchKind {
  if (npc.adapterType === "unbound") return "unbound";
  if (npc.adapterType === "hermes") return npc.hermesProfileId ? "hermes" : "unbound";
  if (npc.adapterType === "openclaw") return "openclaw";
  return "registry";
}
```

`src/server/socket-handlers.ts`의 NPC 채팅 핸들러(639행 부근)에서 기존 `if (adapterType === "openclaw") ... else if (adapterRegistry.has(...))` 분기를 `classifyNpcDispatch()` 결과로 스위치하도록 바꾼다. `"hermes"` 갈래에서:

```typescript
const client = await getProfileClientForNpc(npcId);
if (!client) { emitNpcSystemResponse(socket, npcId, "npc_unbound"); return; }
const adapter = new HermesAdapter(client, { sessionId: storedSessionRef ?? undefined });
const { response, session } = await adapter.execute({
  sessionKey, prompt: messageToSend,
  onDelta: (chunk) => { /* 기존 delta emit 그대로 */ },
  onToolProgress: (name) => { /* 기존 상태 emit 재사용 */ },
});
// 세션 ID를 npc_sessions.session_ref 에 저장해 다음 턴에 재개
```

`"unbound"` 갈래는 `emitNpcSystemResponse(socket, npcId, "npc_unbound")`를 호출한다. 4개 로케일 파일(`ko`/`en`/`ja`/`zh`)에 `npc_unbound` 문구를 추가한다 — 한국어는 "이 NPC는 아직 Hermes 프로필에 연결되지 않았습니다."

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test src/server/hermes-dispatch.test.ts && npm test && npx tsc --noEmit`
Expected: PASS 전부

- [ ] **Step 5: Manually verify a 1:1 conversation end to end**

```bash
npm run dev
```
브라우저에서 게이트웨이 등록 → 프로필 등록 → NPC 재바인딩 → NPC에게 말 걸기.
Expected: 응답이 스트리밍으로 들어오고, 두 번째 메시지에서 NPC가 앞 대화를 기억한다(세션 재개 확인).

- [ ] **Step 6: Commit**

```bash
git add src/server src/lib/i18n
git commit -m "feat(server): dispatch hermes NPCs through the profile-backed adapter"
```

---

## Task 10: 게이트웨이/프로필 관리 UI

**Files:**
- Modify: `src/app/gateways/page.tsx` (프로필 섹션 추가)
- Modify: `src/components/NpcHireModal.tsx` (프로필 선택기)
- Create: `src/components/hermes/HermesProfileList.tsx`
- Test: `src/components/hermes/profile-status.test.ts`

**Interfaces:**
- Consumes: `GET/POST /api/gateways/{id}/profiles`, `POST .../test`, `POST /api/npcs/{id}/rebind` (Task 8)
- Produces: `function profileStatusLabel(status: string | null): { tone: "ok" | "warn" | "error" | "unknown"; key: string }` — i18n 키와 표시 톤

UI 로직 자체는 표시 상태 매핑만 순수 함수로 분리해 테스트하고, 렌더링은 수동 확인한다. 이 코드베이스에 컴포넌트 렌더 테스트 인프라가 없으므로 없는 관행을 새로 들이지 않는다.

- [ ] **Step 1: Write the failing test**

```typescript
// src/components/hermes/profile-status.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { profileStatusLabel } from "./profile-status";

describe("profileStatusLabel", () => {
  test("valid renders as ok", () => {
    assert.deepEqual(profileStatusLabel("valid"), { tone: "ok", key: "gateway.profile.status.valid" });
  });

  test("unauthorized renders as an error the operator must fix", () => {
    assert.equal(profileStatusLabel("unauthorized").tone, "error");
  });

  test("unknown_profile renders as an error", () => {
    assert.equal(profileStatusLabel("unknown_profile").tone, "error");
  });

  test("unreachable renders as a warning", () => {
    assert.equal(profileStatusLabel("unreachable").tone, "warn");
  });

  test("never-validated renders as unknown", () => {
    assert.equal(profileStatusLabel(null).tone, "unknown");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/components/hermes/profile-status.test.ts`
Expected: FAIL — `Cannot find module './profile-status'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/components/hermes/profile-status.ts
export type ProfileStatusTone = "ok" | "warn" | "error" | "unknown";

const TONES: Record<string, ProfileStatusTone> = {
  valid: "ok",
  unauthorized: "error",
  unknown_profile: "error",
  unreachable: "warn",
  error: "error",
};

export function profileStatusLabel(status: string | null): { tone: ProfileStatusTone; key: string } {
  if (!status) return { tone: "unknown", key: "gateway.profile.status.unknown" };
  return { tone: TONES[status] ?? "unknown", key: `gateway.profile.status.${status}` };
}
```

이어서 `HermesProfileList.tsx`를 만든다 — 프로필 목록, "프로필 추가"(이름 + 토큰 입력), 행별 "연결 테스트" 버튼, `profileStatusLabel`로 색을 입힌 상태 배지. `src/app/gateways/page.tsx`의 게이트웨이 카드 안에 이 컴포넌트를 넣는다. `NpcHireModal.tsx`의 어댑터 선택기에 `hermes`를 추가하고, 선택 시 프로필 드롭다운을 노출한다.

i18n 키 6개를 4개 로케일 파일에 추가한다: `gateway.profile.status.{valid,unauthorized,unknown_profile,unreachable,error,unknown}`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test src/components/hermes/profile-status.test.ts && npx tsc --noEmit && npm run lint`
Expected: PASS 전부

- [ ] **Step 5: Manually verify the UI flow**

```bash
npm run dev
```
`/gateways`에서 게이트웨이 추가 → 프로필 추가 → 연결 테스트가 초록으로 → NPC 고용 시 프로필 선택이 뜨는지 확인. 틀린 토큰으로 등록하면 빨간 `unauthorized` 배지가 뜬다.

- [ ] **Step 6: Commit**

```bash
git add src/components src/app/gateways src/lib/i18n
git commit -m "feat(ui): add Hermes profile management and NPC profile binding"
```

---

## Task 11: 최종 검증

**Files:**
- Modify: `deploy/pre-deploy-checklist.md` (Hermes 프로필 확인 항목 추가)

**Interfaces:**
- Consumes: Task 1~10 전부
- Produces: 없음 (게이트)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: 전부 통과. 특히 `schema-drift.test.ts`(30 테이블), 기존 `meeting-*.test.ts`, `phase1/phase2a-integration.test.ts`가 깨지지 않아야 한다.

- [ ] **Step 2: Type-check and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: 오류 0

- [ ] **Step 3: Verify a blank SQLite runtime boots**

```bash
rm -rf /tmp/deskrpg-p1-final
DESKRPG_HOME=/tmp/deskrpg-p1-final node bin/deskrpg.js init
DESKRPG_HOME=/tmp/deskrpg-p1-final node bin/deskrpg.js doctor
```
Expected: 오류 없음

- [ ] **Step 4: Verify the production build**

Run: `npm run build`
Expected: 성공

- [ ] **Step 5: Confirm OpenClaw NPCs still work**

기존 OpenClaw NPC로 대화를 1회 수행한다.
Expected: 정상 동작. P1은 OpenClaw 경로를 유지한다 — 여기서 깨지면 롤백 경로를 잃은 것이다.

- [ ] **Step 6: Commit**

```bash
git add deploy/pre-deploy-checklist.md
git commit -m "chore: add Hermes profile checks to the pre-deploy checklist"
```

---

## Self-Review 결과

**스펙 커버리지** — P1 범위(§5 표)는 `HermesClient` + `HermesAdapter`, `types.ts` 인터페이스 정리, 스키마, 게이트웨이/프로필 등록 UI, 재바인딩 UI다. Task 1~3이 클라이언트, Task 6~7이 어댑터, Task 4~5가 스키마·자원, Task 8~10이 API·UI를 덮는다. 스펙 §3.4의 `/steer`는 `HermesAdapter.steer()`로 노출만 하고 호출부는 P2(ConversationEngine)에서 붙인다 — P1에는 다자 대화가 없으므로 의도된 유예다.

**P1 범위 밖으로 미룬 것** — 폴링 청크 분할(P2, 다자 대화 없이는 의미 없음), 프로필 자동 생성(`hermes profile create` 셸 호출, 스펙 §6 미해결), `conversation_rooms`(P3), Docker 자산 교체(P4).

**타입 일관성 확인** — `SseEvent`(T1) → `HermesClient.drain`(T3) → `HermesAdapter.relay`(T7)로 일관되게 흐른다. `AdapterExecuteOptions`(T6)의 `onRunStarted`/`onToolProgress`/`conversationHistory`가 T7 구현과 T7 테스트에서 같은 이름으로 쓰인다. `mapValidationError`의 반환값(T5)이 `profileStatusLabel`의 키(T10) 및 API 응답(T8)과 같은 문자열 집합(`valid`/`unauthorized`/`unknown_profile`/`unreachable`/`error`)을 쓴다.

**의도적으로 남긴 결정** — `npcs.openclaw_config`를 삭제하지 않고 `agent_config`를 병존시킨다(T4). 롤백 경로 유지가 목적이며 P4에서 정리한다.
