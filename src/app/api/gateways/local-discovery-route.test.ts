import crypto from "node:crypto";
import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";

/** 감시(watchHermesFs)가 같은 객체를 패치할 수 있도록 별칭 하나만 쓴다. */
const fs = nodeFs;

// Task 4 review, Critical 1 + Important 1 regression coverage.
//
// DB-backed (drizzle over @/db) — same rationale as src/app/api/npcs/rebind-route.test.ts:
// `db` is a lazily initialized module singleton and node:test runs each test file in its
// own process, so setting SQLITE_PATH once at module scope pins this file to one
// throwaway DB.
//
// Lives at this top-level path (not inside `[id]/local-discovery/`) for the same reason
// as profiles-probe-route.test.ts: node's test runner treats `[id]` as a glob character
// class when discovering files by path, so a `*.test.ts` file nested inside a bracketed
// route segment is never collected.
const sqlitePath = path.join(os.tmpdir(), `local-discovery-route-test-${crypto.randomUUID()}.db`);
process.env.DESKRPG_HOME = os.tmpdir();
process.env.SQLITE_PATH = sqlitePath;
// 최종 리뷰 C1: 로컬 발견은 이제 운영자가 켜야 하는 인스턴스 레벨 스위치 뒤에 있다.
// 기본값은 꺼짐이므로, 이 파일의 "정상 동작" 테스트는 명시적으로 켠 상태를 쓴다.
process.env.DESKRPG_LOCAL_DISCOVERY_ENABLED = "true";

// 게이트웨이 URL은 루프백이어야 한다(스펙 §4 1단계). 실제로 아무것도 듣고 있지
// 않은 포트를 골라 탐침이 즉시 ECONNREFUSED로 떨어지게 한다 — 테스트가 바깥
// 네트워크나 DNS에 의존하지 않는다.
const LOOPBACK_URL = "http://127.0.0.1:59321";
const REMOTE_URL = "https://attacker.example";
for (const ext of ["", "-wal", "-shm"]) {
  process.on("exit", () => fs.rmSync(`${sqlitePath}${ext}`, { force: true }));
}

// A real ~/.hermes-style directory tree on disk, rooted outside the actual home
// directory via HERMES_HOME. `readProfileToken`/`listLocalProfiles` read real files —
// this is not mocked — so a traversal name that escapes the profiles root really would
// reach `decoyDir` on this machine's filesystem if the route failed to reject it.
const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), "local-discovery-hermes-"));
const profilesRoot = path.join(hermesHome, "profiles");
const sophieDir = path.join(profilesRoot, "sophie");
fs.mkdirSync(sophieDir, { recursive: true });
fs.writeFileSync(path.join(sophieDir, "config.yaml"), "name: sophie\n");
const SOPHIE_TOKEN = "s".repeat(48);
fs.writeFileSync(path.join(sophieDir, ".env"), `API_SERVER_KEY=${SOPHIE_TOKEN}\n`);

// A canary secret living one level *outside* the profiles root, at the exact spot
// "../decoy-app" would resolve to from `profilesRoot`. If the route's name validation
// were ever removed or bypassed, this is what would leak.
const decoyDir = path.join(hermesHome, "decoy-app");
fs.mkdirSync(decoyDir, { recursive: true });
const CANARY_TOKEN = "CANARY-SECRET-" + "c".repeat(34);
fs.writeFileSync(path.join(decoyDir, ".env"), `API_SERVER_KEY=${CANARY_TOKEN}\n`);
for (const dir of [hermesHome]) {
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
}

async function loadDb() {
  return import("@/db");
}

async function seedOwnerAndGateway(baseUrl: string = LOOPBACK_URL) {
  const { db, users, gatewayResources } = await loadDb();
  const { encryptGatewayToken } = await import("@/lib/gateway-resources");
  const [owner] = await db
    .insert(users)
    .values({
      loginId: `owner-${crypto.randomUUID().slice(0, 8)}`,
      nickname: `owner-${crypto.randomUUID().slice(0, 8)}`,
      passwordHash: "hash",
    })
    .returning();
  const [gateway] = await db
    .insert(gatewayResources)
    .values({
      ownerUserId: owner.id,
      displayName: "Test Gateway",
      baseUrl,
      tokenEncrypted: encryptGatewayToken("gateway-owner-key-1234567890"),
    })
    .returning();
  return { owner, gateway };
}

async function optIn(gatewayId: string, ownerId: string) {
  const { POST } = await import("./[id]/local-discovery/route");
  const req = new NextRequest(`http://localhost/api/gateways/${gatewayId}/local-discovery`, {
    method: "POST",
    headers: { "x-user-id": ownerId, "content-type": "application/json" },
    body: JSON.stringify({ action: "opt-in" }),
  });
  const res = await POST(req, { params: Promise.resolve({ id: gatewayId }) });
  assert.equal(res.status, 200);
}

/**
 * Hermes 프로필 트리에 대한 **실제** 파일시스템 접근을 기록한다.
 *
 * 스펙 §10 완료 기준 6 — "옵인하지 않은 게이트웨이에서는 서버가 파일시스템을
 * 건드리지 않는다 (테스트로 고정)". 상태 코드만 보면 게이트를 지워도 테스트가
 * 통과한다(최종 리뷰 I1의 변이 실험이 실증했다). 그래서 응답이 아니라 **행위**를
 * 본다.
 *
 * hermesHome 아래 경로만 센다 — 모듈 로딩·SQLite 같은 무관한 fs 사용을 잡으면
 * 의미 없는 실패가 된다.
 */
function watchHermesFs() {
  const original = {
    existsSync: nodeFs.existsSync,
    readdirSync: nodeFs.readdirSync,
    readFileSync: nodeFs.readFileSync,
    statSync: nodeFs.statSync,
  };
  const calls: string[] = [];
  const record = (name: string, p: unknown) => {
    if (typeof p === "string" && p.startsWith(hermesHome)) {
      calls.push(`${name} ${p}`);
    }
  };
  for (const name of Object.keys(original) as (keyof typeof original)[]) {
    const impl = original[name] as (...args: unknown[]) => unknown;
    (nodeFs as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
      record(name, args[0]);
      return impl(...args);
    };
  }
  return {
    calls,
    restore() {
      Object.assign(nodeFs, original);
    },
  };
}

/** HERMES_HOME + fs 감시를 걸고 한 번의 요청을 돌린다. */
async function withWatchedFs<T>(run: () => Promise<T>) {
  const priorEnv = process.env.HERMES_HOME;
  process.env.HERMES_HOME = hermesHome;
  const watcher = watchHermesFs();
  try {
    const value = await run();
    return { value, calls: [...watcher.calls] };
  } finally {
    watcher.restore();
    process.env.HERMES_HOME = priorEnv;
  }
}

function discoveryRequest(gatewayId: string, userId: string, body?: unknown): NextRequest {
  return new NextRequest(
    `http://localhost/api/gateways/${gatewayId}/local-discovery`,
    body === undefined
      ? { method: "GET", headers: { "x-user-id": userId } }
      : {
          method: "POST",
          headers: { "x-user-id": userId, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );
}

describe("POST /api/gateways/[id]/local-discovery (registration batch)", () => {
  test("rejects every path-traversal / non-canonical shape and never stores the canary token, while a legitimate name still registers", async () => {
    const priorEnv = process.env.HERMES_HOME;
    process.env.HERMES_HOME = hermesHome;
    try {
      const { owner, gateway } = await seedOwnerAndGateway();
      await optIn(gateway.id, owner.id);

      const { POST } = await import("./[id]/local-discovery/route");
      const req = new NextRequest(`http://localhost/api/gateways/${gateway.id}/local-discovery`, {
        method: "POST",
        headers: {
          "x-user-id": owner.id,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          profiles: ["../decoy-app", "a/b", "..", ".", "sophie"],
        }),
      });
      const res = await POST(req, {
        params: Promise.resolve({ id: gateway.id }),
      });
      const body = await res.json();

      const byName = Object.fromEntries(
        (body.results as { name: string; ok: boolean; errorCode?: string }[]).map((r) => [
          r.name,
          r,
        ]),
      );
      for (const traversal of ["../decoy-app", "a/b", "..", "."]) {
        assert.equal(byName[traversal].ok, false, `${traversal} must not register`);
        assert.equal(byName[traversal].errorCode, "invalid_profile_name");
      }
      assert.equal(byName["sophie"].ok, true, "a normal profile name must still work");

      const { db, hermesProfiles } = await loadDb();
      const rows = await db
        .select()
        .from(hermesProfiles)
        .where(eq(hermesProfiles.gatewayId, gateway.id));
      assert.equal(rows.length, 1, "only the legitimate profile must have been registered");
      assert.equal(rows[0].profileName, "sophie");

      const { decryptGatewayToken } = await import("@/lib/gateway-resources");
      const storedToken = decryptGatewayToken(rows[0].tokenEncrypted);
      assert.equal(storedToken, SOPHIE_TOKEN);
      assert.notEqual(
        storedToken,
        CANARY_TOKEN,
        "the canary secret from outside the profiles root must never be stored",
      );
    } finally {
      process.env.HERMES_HOME = priorEnv;
    }
  });
});

describe("GET /api/gateways/[id]/local-discovery (owner gate)", () => {
  test("returns empty candidates to a share-only caller even after the owner has opted in", async () => {
    const priorEnv = process.env.HERMES_HOME;
    process.env.HERMES_HOME = hermesHome;
    try {
      const { owner, gateway } = await seedOwnerAndGateway();
      await optIn(gateway.id, owner.id);

      const { db, gatewayShares, users } = await loadDb();
      const [sharedUser] = await db
        .insert(users)
        .values({
          loginId: `shared-${crypto.randomUUID().slice(0, 8)}`,
          nickname: `shared-${crypto.randomUUID().slice(0, 8)}`,
          passwordHash: "hash",
        })
        .returning();
      await db
        .insert(gatewayShares)
        .values({ gatewayId: gateway.id, userId: sharedUser.id, role: "use" });

      const { GET } = await import("./[id]/local-discovery/route");

      const ownerReq = new NextRequest(
        `http://localhost/api/gateways/${gateway.id}/local-discovery`,
        {
          method: "GET",
          headers: { "x-user-id": owner.id },
        },
      );
      const ownerRes = await GET(ownerReq, {
        params: Promise.resolve({ id: gateway.id }),
      });
      const ownerBody = await ownerRes.json();
      assert.equal(ownerBody.optedIn, true);
      assert.ok(
        ownerBody.candidates.some((c: { name: string }) => c.name === "sophie"),
        "owner sees real candidates",
      );

      const sharedReq = new NextRequest(
        `http://localhost/api/gateways/${gateway.id}/local-discovery`,
        {
          method: "GET",
          headers: { "x-user-id": sharedUser.id },
        },
      );
      const sharedRes = await GET(sharedReq, {
        params: Promise.resolve({ id: gateway.id }),
      });
      const sharedBody = await sharedRes.json();
      assert.equal(sharedRes.status, 200);
      assert.equal(sharedBody.optedIn, true);
      assert.deepEqual(
        sharedBody.candidates,
        [],
        "a share-only caller must not see the owner's local profile names",
      );
    } finally {
      process.env.HERMES_HOME = priorEnv;
    }
  });
});

describe("local discovery gates — 게이트를 지우면 빨개져야 하는 테스트들", () => {
  // 최종 리뷰 I1. 아래 네 개는 전부 "응답 모양"이 아니라 "파일시스템을 건드렸는가"를
  // 함께 본다. 상태 코드만 보는 단정은 게이트를 지워도 통과했다.

  test("옵인하지 않은 게이트웨이 GET → optedIn:false, candidates:[], 파일 미접촉", async () => {
    const { owner, gateway } = await seedOwnerAndGateway();
    const { GET } = await import("./[id]/local-discovery/route");
    const { value: body, calls } = await withWatchedFs(async () => {
      const res = await GET(discoveryRequest(gateway.id, owner.id), {
        params: Promise.resolve({ id: gateway.id }),
      });
      assert.equal(res.status, 200);
      return res.json();
    });
    assert.equal(body.optedIn, false);
    assert.deepEqual(body.candidates, []);
    assert.deepEqual(
      calls.filter((c) => !c.startsWith("existsSync")),
      [],
      "옵인 전에는 프로필 디렉토리를 읽거나 .env를 열지 않는다",
    );
    assert.equal(
      calls.some((c) => c.includes("sophie")),
      false,
      "프로필 디렉토리 자체를 들여다보지 않는다",
    );
  });

  test("옵인한 소유자 GET은 실제로 파일을 읽는다 (감시 자체의 대조군)", async () => {
    const { owner, gateway } = await seedOwnerAndGateway();
    await optIn(gateway.id, owner.id);
    const { GET } = await import("./[id]/local-discovery/route");
    const { value: body, calls } = await withWatchedFs(async () => {
      const res = await GET(discoveryRequest(gateway.id, owner.id), {
        params: Promise.resolve({ id: gateway.id }),
      });
      return res.json();
    });
    assert.equal(body.optedIn, true);
    assert.ok(body.candidates.some((c: { name: string }) => c.name === "sophie"));
    // 이 단정이 없으면 감시가 조용히 고장 났을 때 위 테스트들이 가짜로 통과한다.
    assert.ok(
      calls.some((c) => c.includes("sophie")),
      "감시가 실제 접근을 잡아내야 한다",
    );
  });

  test("옵인하지 않은 게이트웨이 POST {profiles} → 403 not_opted_in, 파일 미접촉", async () => {
    const { owner, gateway } = await seedOwnerAndGateway();
    const { POST } = await import("./[id]/local-discovery/route");
    const { value, calls } = await withWatchedFs(async () => {
      const res = await POST(discoveryRequest(gateway.id, owner.id, { profiles: ["sophie"] }), {
        params: Promise.resolve({ id: gateway.id }),
      });
      return { status: res.status, body: await res.json() };
    });
    assert.equal(value.status, 403);
    assert.equal(value.body.errorCode, "not_opted_in");
    assert.deepEqual(calls, [], "동의 전에는 파일시스템을 건드리지 않는다");
  });

  test("share-only 사용자 POST {profiles} → 403 forbidden, 파일 미접촉", async () => {
    // 이 게이트를 지우면 share-only 사용자가 readProfileToken 까지 도달한다.
    // registerHermesProfile 이 뒤에서 forbidden 을 돌려주지만 **파일은 이미 읽힌 뒤**다.
    const { owner, gateway } = await seedOwnerAndGateway();
    await optIn(gateway.id, owner.id);
    const { db, gatewayShares, users } = await loadDb();
    const [sharedUser] = await db
      .insert(users)
      .values({
        loginId: `shared-${crypto.randomUUID().slice(0, 8)}`,
        nickname: `shared-${crypto.randomUUID().slice(0, 8)}`,
        passwordHash: "hash",
      })
      .returning();
    await db
      .insert(gatewayShares)
      .values({ gatewayId: gateway.id, userId: sharedUser.id, role: "use" });

    const { POST } = await import("./[id]/local-discovery/route");
    const { value, calls } = await withWatchedFs(async () => {
      const res = await POST(
        discoveryRequest(gateway.id, sharedUser.id, { profiles: ["sophie"] }),
        { params: Promise.resolve({ id: gateway.id }) },
      );
      return { status: res.status, body: await res.json() };
    });
    assert.equal(value.status, 403);
    assert.equal(value.body.errorCode, "forbidden");
    assert.deepEqual(calls, [], "소유자가 아니면 .env 가 열리기 전에 거부돼야 한다");
  });
});

describe("local discovery gates — 스펙 §4 1단계(루프백)와 인스턴스 스위치", () => {
  // 최종 리뷰 C1. 이 둘이 없으면 인증된 아무 사용자나 임의 URL로 게이트웨이를
  // 만들어 호스트의 Hermes 키를 읽고, "프로필 테스트" 버튼으로 그 키를 자기
  // 서버에 Bearer 로 보낼 수 있다.

  test("루프백이 아닌 게이트웨이는 GET에서 available:false 이고 파일을 건드리지 않는다", async () => {
    const { owner, gateway } = await seedOwnerAndGateway(REMOTE_URL);
    await optIn(gateway.id, owner.id).catch(() => undefined);
    const { GET } = await import("./[id]/local-discovery/route");
    const { value: body, calls } = await withWatchedFs(async () => {
      const res = await GET(discoveryRequest(gateway.id, owner.id), {
        params: Promise.resolve({ id: gateway.id }),
      });
      return res.json();
    });
    assert.equal(body.available, false, "기능이 아예 없는 것처럼 보여야 한다");
    assert.deepEqual(body.candidates, []);
    assert.deepEqual(calls, [], "프로필 루트 존재 확인조차 하지 않는다");
  });

  test("루프백이 아닌 게이트웨이는 옵인도 등록도 403 local_discovery_unavailable", async () => {
    const { owner, gateway } = await seedOwnerAndGateway(REMOTE_URL);
    const { POST } = await import("./[id]/local-discovery/route");
    const { value, calls } = await withWatchedFs(async () => {
      const optInRes = await POST(discoveryRequest(gateway.id, owner.id, { action: "opt-in" }), {
        params: Promise.resolve({ id: gateway.id }),
      });
      const registerRes = await POST(
        discoveryRequest(gateway.id, owner.id, { profiles: ["sophie"] }),
        { params: Promise.resolve({ id: gateway.id }) },
      );
      return {
        optIn: { status: optInRes.status, body: await optInRes.json() },
        register: {
          status: registerRes.status,
          body: await registerRes.json(),
        },
      };
    });
    assert.equal(value.optIn.status, 403);
    assert.equal(value.optIn.body.errorCode, "local_discovery_unavailable");
    assert.equal(value.register.status, 403);
    assert.equal(value.register.body.errorCode, "local_discovery_unavailable");
    assert.deepEqual(calls, []);

    // 동의 자체가 기록되지 않아야 한다 — 나중에 스위치가 켜졌을 때 되살아나면 안 된다.
    const { db, gatewayResources } = await loadDb();
    const [row] = await db
      .select()
      .from(gatewayResources)
      .where(eq(gatewayResources.id, gateway.id));
    assert.equal(row.localDiscoveryOptedInAt, null);
  });

  test("인스턴스 스위치가 꺼져 있으면 루프백이어도 보이지 않는다 (기본값)", async () => {
    const { owner, gateway } = await seedOwnerAndGateway();
    await optIn(gateway.id, owner.id);
    const { GET, POST } = await import("./[id]/local-discovery/route");
    const priorFlag = process.env.DESKRPG_LOCAL_DISCOVERY_ENABLED;
    delete process.env.DESKRPG_LOCAL_DISCOVERY_ENABLED;
    try {
      const { value, calls } = await withWatchedFs(async () => {
        const getRes = await GET(discoveryRequest(gateway.id, owner.id), {
          params: Promise.resolve({ id: gateway.id }),
        });
        const postRes = await POST(
          discoveryRequest(gateway.id, owner.id, { profiles: ["sophie"] }),
          { params: Promise.resolve({ id: gateway.id }) },
        );
        return {
          get: await getRes.json(),
          post: { status: postRes.status, body: await postRes.json() },
        };
      });
      assert.equal(value.get.available, false);
      assert.equal(value.get.optedIn, false, "옵인 사실도 노출하지 않는다");
      assert.deepEqual(value.get.candidates, []);
      assert.equal(value.post.status, 403);
      assert.equal(value.post.body.errorCode, "local_discovery_unavailable");
      assert.deepEqual(calls, []);
    } finally {
      process.env.DESKRPG_LOCAL_DISCOVERY_ENABLED = priorFlag;
    }
  });
});
