import crypto from "node:crypto";
import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";

/** Use a single alias so the watcher (watchHermesFs) can patch the same object. */
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
// Final review C1: local discovery now sits behind an instance-level switch the operator must turn on.
// The default is off, so this file's "normal behavior" tests use the explicitly enabled state.
process.env.DESKRPG_LOCAL_DISCOVERY_ENABLED = "true";

// The gateway URL must be loopback (spec §4 step 1). Pick a port where nothing is actually listening
// so the probe drops immediately with ECONNREFUSED — the test does not depend on the outside
// network or DNS.
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
 * Record **real** filesystem access to the Hermes profile tree.
 *
 * Spec §10 completion criterion 6 — "on a gateway that has not opted in the server does not touch the
 * filesystem (pinned by a test)". Looking only at status codes, the test passes even with the gate removed
 * (final review I1's mutation experiment proved it). So we watch the **behavior**, not the
 * response.
 *
 * Only paths under hermesHome are counted — catching unrelated fs use like module loading or SQLite
 * would give meaningless failures.
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

/** Set up HERMES_HOME + fs watching and run one request. */
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

describe("local discovery gates — tests that must go red if the gate is removed", () => {
  // Final review I1. All four below check "was the filesystem touched" along with the
  // "response shape". Assertions on status codes alone passed even with the gate removed.

  test("GET on a gateway that has not opted in → optedIn:false, candidates:[], no file access", async () => {
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

  test("GET by an opted-in owner actually reads files (the control group for the watcher itself)", async () => {
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
    // Without this assertion the tests above would pass falsely if the watcher silently broke.
    assert.ok(
      calls.some((c) => c.includes("sophie")),
      "감시가 실제 접근을 잡아내야 한다",
    );
  });

  test("POST {profiles} on a gateway that has not opted in → 403 not_opted_in, no file access", async () => {
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

  test("POST {profiles} by a share-only user → 403 forbidden, no file access", async () => {
    // Removing this gate lets share-only users reach readProfileToken.
    // registerHermesProfile returns forbidden later, but **the file has already been read** by then.
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

describe("local discovery gates — spec §4 step 1 (loopback) and the instance switch", () => {
  // Final review C1. Without these two, any authenticated user could create a gateway with an arbitrary URL,
  // read the host's Hermes keys, and send those keys to their own server as Bearer
  // through the "profile test" button.

  test("a non-loopback gateway is available:false on GET and touches no files", async () => {
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

  test("a non-loopback gateway gets 403 local_discovery_unavailable for both opt-in and registration", async () => {
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

    // Consent itself must not be recorded — it must not come back to life when the switch is later turned on.
    const { db, gatewayResources } = await loadDb();
    const [row] = await db
      .select()
      .from(gatewayResources)
      .where(eq(gatewayResources.id, gateway.id));
    assert.equal(row.localDiscoveryOptedInAt, null);
  });

  test("with the instance switch off it is invisible even on loopback (default)", async () => {
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
