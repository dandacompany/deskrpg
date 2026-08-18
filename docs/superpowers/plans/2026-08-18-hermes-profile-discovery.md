# Hermes 프로필 발견·등록 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 로컬 Hermes 게이트웨이에서는 프로필 목록과 토큰을 자동으로 찾아 체크박스로 등록하고, 원격에서는 입력한 프로필 이름의 존재 여부를 즉시 알려준다.

**Architecture:** 파일시스템 발견(`<루트>/profiles/`)과 게이트웨이 탐침(`/p/<이름>/health`)을 겹쳐 후보를 만든다. "로컬인가"는 URL 파싱이 아니라 프로필 루트가 실제로 존재하는지로 판정하므로 Docker에서 자동 교정된다. 비밀 파일 읽기는 게이트웨이별 명시적 옵인 뒤에만 일어난다.

**Tech Stack:** TypeScript, Next.js 16 App Router, Drizzle ORM(pg + sqlite 양쪽), `node:test` + `tsx`, React 19 클라이언트 컴포넌트

**Spec:** [docs/superpowers/specs/2026-08-18-hermes-profile-discovery-design.md](../specs/2026-08-18-hermes-profile-discovery-design.md)

## Global Constraints

- **테스트 실행 명령은 정확히 이것이다:**
  `npx tsx --test $(git ls-files 'src/**/*.test.ts' 'src/**/*.test.js' 'src/**/*.test.tsx' | tr '\n' ' ')`
  시작 시점 기준 **537 pass / 0 fail**. 모든 태스크는 이 수를 늘리기만 한다.
- 테스트 파일은 이제 gitignore되지 않는다. `git add -f` 불필요(2026-08-18 `ef8fbaa4`).
- **토큰 값은 어떤 API 응답에도 넣지 않는다.** 유무 불리언만 내보낸다.
- 프로필 이름은 `PROFILE_NAME_RE`(`src/app/api/gateways/[id]/profiles/validation.ts:8`)를 통과해야 하고, 토큰은 16자 이상이어야 한다(`MIN_TOKEN_LENGTH`).
- 스키마를 바꾸면 **6곳 전부** 고친다: `src/db/schema.ts`, `src/db/schema-sqlite.ts`, `src/db/schema.pg.cjs`, `src/db/schema.sqlite.cjs`, `src/db/sqlite-base-schema.js`, `src/db/server-db.js`. `src/db/schema-drift.test.ts`가 .ts와 .cjs를 컬럼 단위로 대조한다.
- 커밋은 반드시 pathspec으로 범위를 한정한다: `git commit -m "..." -- <경로>`.

---

### Task 1: 로컬 프로필 발견 모듈

파일시스템에서 프로필 후보와 토큰을 읽는 순수 모듈. 실제 파일시스템에 의존하지 않도록 최소 인터페이스를 주입받는다.

**Files:**
- Create: `src/lib/hermes/local-profiles.ts`
- Test: `src/lib/hermes/local-profiles.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `type ProfileFs = { existsSync(p: string): boolean; readdirSync(p: string): string[]; readFileSync(p: string, enc: "utf8"): string; statIsDirectory(p: string): boolean }`
  - `resolveProfilesRoot(env: Record<string, string | undefined>, homedir: string): string`
  - `type LocalProfile = { name: string; hasToken: boolean }`
  - `listLocalProfiles(root: string, fs: ProfileFs): LocalProfile[]`
  - `readProfileToken(root: string, name: string, fs: ProfileFs): string | null`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/lib/hermes/local-profiles.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveProfilesRoot,
  listLocalProfiles,
  readProfileToken,
  type ProfileFs,
} from "./local-profiles";

/** 메모리 위의 가짜 파일시스템. 키는 절대 경로. */
function fakeFs(files: Record<string, string>, dirs: string[]): ProfileFs {
  const dirSet = new Set(dirs);
  return {
    existsSync: (p) => p in files || dirSet.has(p),
    readdirSync: (p) =>
      [...dirSet]
        .filter((d) => d.startsWith(p + "/") && !d.slice(p.length + 1).includes("/"))
        .map((d) => d.slice(p.length + 1)),
    readFileSync: (p) => {
      if (!(p in files)) throw new Error("ENOENT " + p);
      return files[p];
    },
    statIsDirectory: (p) => dirSet.has(p),
  };
}

test("resolveProfilesRoot", async (t) => {
  await t.test("기본은 ~/.hermes/profiles", () => {
    assert.equal(resolveProfilesRoot({}, "/Users/dante"), "/Users/dante/.hermes/profiles");
  });

  await t.test("HERMES_HOME이 ~/.hermes 밖이면 그쪽을 쓴다 (Docker 배포)", () => {
    // hermes_cli/profiles.py:_get_default_hermes_home 의 규칙을 따른다.
    assert.equal(
      resolveProfilesRoot({ HERMES_HOME: "/opt/data" }, "/Users/dante"),
      "/opt/data/profiles",
    );
  });

  await t.test("HERMES_HOME이 프로필 안을 가리켜도 루트로 되돌린다", () => {
    // HERMES_HOME은 그 자체가 프로필일 수 있다. 그때 profiles/ 를 그 아래에 만들면
    // 중첩된 엉뚱한 경로가 된다.
    assert.equal(
      resolveProfilesRoot({ HERMES_HOME: "/Users/dante/.hermes/profiles/sophie" }, "/Users/dante"),
      "/Users/dante/.hermes/profiles",
    );
  });
});

test("listLocalProfiles", async (t) => {
  const root = "/h/profiles";

  await t.test("config.yaml 이 있는 디렉토리만 프로필로 본다", () => {
    const fs = fakeFs(
      {
        "/h/profiles/sophie/config.yaml": "model: x",
        "/h/profiles/sophie/.env": "API_SERVER_KEY=aaaaaaaaaaaaaaaaaaaa\n",
        "/h/profiles/notes/readme.txt": "hi",
      },
      ["/h/profiles", "/h/profiles/sophie", "/h/profiles/notes"],
    );
    assert.deepEqual(listLocalProfiles(root, fs), [{ name: "sophie", hasToken: true }]);
  });

  await t.test("토큰이 없거나 16자 미만이면 hasToken=false", () => {
    const fs = fakeFs(
      {
        "/h/profiles/ada/config.yaml": "model: x",
        "/h/profiles/mia/config.yaml": "model: x",
        "/h/profiles/mia/.env": "API_SERVER_KEY=short\n",
      },
      ["/h/profiles", "/h/profiles/ada", "/h/profiles/mia"],
    );
    assert.deepEqual(listLocalProfiles(root, fs), [
      { name: "ada", hasToken: false },
      { name: "mia", hasToken: false },
    ]);
  });

  await t.test("이름 규칙을 통과 못 하는 디렉토리는 제외한다", () => {
    const fs = fakeFs(
      { "/h/profiles/../config.yaml": "x", "/h/profiles/ok/config.yaml": "x" },
      ["/h/profiles", "/h/profiles/..", "/h/profiles/ok"],
    );
    assert.deepEqual(listLocalProfiles(root, fs), [{ name: "ok", hasToken: false }]);
  });

  await t.test("루트가 없으면 빈 배열 — 컨테이너에서 여기로 떨어진다", () => {
    const fs = fakeFs({}, []);
    assert.deepEqual(listLocalProfiles(root, fs), []);
  });
});

test("readProfileToken", async (t) => {
  await t.test("named 프로필은 자기 .env 에서 읽는다", () => {
    const fs = fakeFs(
      { "/h/profiles/sophie/.env": "FOO=1\nAPI_SERVER_KEY=" + "a".repeat(48) + "\n" },
      ["/h/profiles", "/h/profiles/sophie"],
    );
    assert.equal(readProfileToken("/h/profiles", "sophie", fs), "a".repeat(48));
  });

  await t.test("default 프로필은 루트의 부모 .env 에서 읽는다", () => {
    // 실측: ~/.hermes/profiles/default/ 에는 .env가 없다. default의 홈은
    // ~/.hermes/ 자체이므로 토큰은 <루트의 부모>/.env 에 있다.
    const fs = fakeFs(
      { "/h/.env": "API_SERVER_KEY=" + "b".repeat(48) + "\n" },
      ["/h", "/h/profiles", "/h/profiles/default"],
    );
    assert.equal(readProfileToken("/h/profiles", "default", fs), "b".repeat(48));
  });

  await t.test("마지막 정의가 이긴다 — 키를 여러 번 append 했을 수 있다", () => {
    const fs = fakeFs(
      {
        "/h/profiles/sophie/.env":
          "API_SERVER_KEY=" + "a".repeat(48) + "\nAPI_SERVER_KEY=" + "c".repeat(48) + "\n",
      },
      ["/h/profiles", "/h/profiles/sophie"],
    );
    assert.equal(readProfileToken("/h/profiles", "sophie", fs), "c".repeat(48));
  });

  await t.test("값이 따옴표로 감싸여 있으면 벗긴다", () => {
    const fs = fakeFs(
      { "/h/profiles/sophie/.env": 'API_SERVER_KEY="' + "a".repeat(48) + '"\n' },
      ["/h/profiles", "/h/profiles/sophie"],
    );
    assert.equal(readProfileToken("/h/profiles", "sophie", fs), "a".repeat(48));
  });

  await t.test("없으면 null", () => {
    const fs = fakeFs({}, ["/h/profiles", "/h/profiles/sophie"]);
    assert.equal(readProfileToken("/h/profiles", "sophie", fs), null);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx tsx --test src/lib/hermes/local-profiles.test.ts`
Expected: FAIL — `Cannot find module './local-profiles'`

- [ ] **Step 3: 구현한다**

`src/lib/hermes/local-profiles.ts`:

```ts
/**
 * 로컬 Hermes 설치에서 프로필을 발견한다.
 *
 * Hermes API Server에는 프로필을 나열하는 엔드포인트가 없고(스펙 §2.1), 대시보드의
 * profiles.list RPC는 외부 서버에 인증 경로가 없다(§2.2). 앱과 Hermes가 같은
 * 머신일 때만 쓸 수 있는 경로가 파일시스템이다.
 *
 * 파일시스템은 순수 함수 밖으로 밀어낸다 — 테스트가 실제 홈 디렉토리에 의존하면
 * 실행하는 사람마다 결과가 달라진다.
 */

/** Hermes가 프로필 키에 요구하는 최소 길이 (hermes_cli.auth.has_usable_secret). */
const MIN_TOKEN_LENGTH = 16;

/** src/app/api/gateways/[id]/profiles/validation.ts 와 같은 규칙. */
const PROFILE_NAME_RE = /^[A-Za-z0-9._-]*[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type ProfileFs = {
  existsSync(p: string): boolean;
  readdirSync(p: string): string[];
  readFileSync(p: string, enc: "utf8"): string;
  statIsDirectory(p: string): boolean;
};

export type LocalProfile = { name: string; hasToken: boolean };

/**
 * 프로필 디렉토리의 위치. hermes_cli/profiles.py 의 _get_profiles_root 규칙을 따른다 —
 * "In Docker/custom deployments where HERMES_HOME points outside ~/.hermes,
 *  profiles live under HERMES_HOME/profiles/ so they persist on the mounted volume."
 */
export function resolveProfilesRoot(
  env: Record<string, string | undefined>,
  homedir: string,
): string {
  const defaultHome = `${homedir}/.hermes`;
  const override = (env.HERMES_HOME || "").trim();
  if (!override || override === defaultHome || override.startsWith(defaultHome + "/")) {
    // HERMES_HOME이 없거나 ~/.hermes 안을 가리킨다(그 자체가 프로필일 수 있다).
    // 어느 쪽이든 프로필 루트는 ~/.hermes/profiles 다.
    return `${defaultHome}/profiles`;
  }
  return `${override.replace(/\/+$/, "")}/profiles`;
}

function parseEnvValue(contents: string, key: string): string | null {
  let found: string | null = null;
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith(`${key}=`)) continue;
    let value = line.slice(key.length + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    // 마지막 정의가 이긴다 — 키를 여러 번 append 했을 수 있다.
    found = value;
  }
  return found || null;
}

/**
 * 프로필의 API_SERVER_KEY. named 프로필은 자기 .env, default는 루트의 부모 .env.
 * 실측: ~/.hermes/profiles/default/ 에는 .env가 없다 — default의 홈은 ~/.hermes 자체다.
 */
export function readProfileToken(root: string, name: string, fs: ProfileFs): string | null {
  const envPath = name === "default" ? `${root.replace(/\/profiles$/, "")}/.env` : `${root}/${name}/.env`;
  if (!fs.existsSync(envPath)) return null;
  let contents: string;
  try {
    contents = fs.readFileSync(envPath, "utf8");
  } catch {
    return null;
  }
  return parseEnvValue(contents, "API_SERVER_KEY");
}

/**
 * config.yaml 을 가진 하위 디렉토리를 프로필 후보로 본다.
 *
 * 이 목록만으로 판단하면 안 된다. 실측상 ~/.hermes/profiles/ 에는 acestep_output
 * 처럼 에이전트가 아닌 디렉토리도 같은 레이아웃을 갖고 있다. 호출자가 게이트웨이
 * 탐침과 겹쳐서 최종 판단한다(스펙 §6.1).
 */
export function listLocalProfiles(root: string, fs: ProfileFs): LocalProfile[] {
  if (!fs.existsSync(root)) return [];
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out: LocalProfile[] = [];
  for (const name of entries.sort()) {
    if (!PROFILE_NAME_RE.test(name)) continue;
    const dir = `${root}/${name}`;
    if (!fs.statIsDirectory(dir)) continue;
    if (!fs.existsSync(`${dir}/config.yaml`)) continue;
    const token = readProfileToken(root, name, fs);
    out.push({ name, hasToken: !!token && token.length >= MIN_TOKEN_LENGTH });
  }
  return out;
}

/** 실제 파일시스템을 쓰는 기본 구현. 서버 코드에서만 부른다. */
export function nodeProfileFs(): ProfileFs {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require("node:fs") as typeof import("node:fs");
  return {
    existsSync: (p) => nodeFs.existsSync(p),
    readdirSync: (p) => nodeFs.readdirSync(p),
    readFileSync: (p, enc) => nodeFs.readFileSync(p, enc),
    statIsDirectory: (p) => {
      try {
        return nodeFs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
  };
}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `npx tsx --test src/lib/hermes/local-profiles.test.ts`
Expected: PASS (13 subtests)

- [ ] **Step 5: 커밋**

```bash
git add src/lib/hermes/local-profiles.ts src/lib/hermes/local-profiles.test.ts
git commit -m "feat(hermes): discover local profiles from the filesystem" -- src/lib/hermes/local-profiles.ts src/lib/hermes/local-profiles.test.ts
```

---

### Task 2: 프로필 경로 탐침

`probeHermesGateway`가 프로필 이름을 받아 `/p/<이름>/health` 를 찌를 수 있게 확장한다. 원격 검증과 로컬 교차 검증 양쪽이 이걸 쓴다.

**Files:**
- Modify: `src/lib/hermes/gateway-probe.ts`
- Test: `src/lib/hermes/gateway-probe.test.ts` (기존 파일에 추가)

**Interfaces:**
- Consumes: 없음
- Produces: `probeHermesGateway(baseUrl, opts?: { fetchImpl?; timeoutMs?; profile?: string })`
  — `profile`이 주어지면 `<baseUrl>/p/<profile>/health`, 없으면 `<baseUrl>/health`.
  반환 타입은 기존 그대로 `{kind:"hermes"|"not-hermes"|"unreachable"}`.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/lib/hermes/gateway-probe.test.ts` 의 `test("probeHermesGateway", …)` 블록 안에 추가한다:

```ts
  await t.test("profile을 주면 /p/<이름>/health 를 찌른다", async () => {
    let called = "";
    const result = await probeHermesGateway("http://127.0.0.1:8642", {
      profile: "sophie",
      fetchImpl: fakeFetch((url) => {
        called = url;
        return new Response("ok", { status: 200 });
      }),
    });
    assert.deepEqual(result, { kind: "hermes", status: 200 });
    assert.equal(called, "http://127.0.0.1:8642/p/sophie/health");
  });

  await t.test("없는 프로필은 404 — not-hermes 로 구분된다", async () => {
    // 실측: /p/nosuch/health → 404, /p/sophie/health → 200.
    const result = await probeHermesGateway("http://127.0.0.1:8642", {
      profile: "nosuch",
      fetchImpl: fakeFetch(() => new Response("no", { status: 404 })),
    });
    assert.deepEqual(result, { kind: "not-hermes", status: 404 });
  });

  await t.test("프로필 이름은 URL 인코딩된다", async () => {
    let called = "";
    await probeHermesGateway("http://127.0.0.1:8642", {
      profile: "a b",
      fetchImpl: fakeFetch((url) => {
        called = url;
        return new Response("ok", { status: 200 });
      }),
    });
    assert.equal(called, "http://127.0.0.1:8642/p/a%20b/health");
  });
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx tsx --test src/lib/hermes/gateway-probe.test.ts`
Expected: FAIL — 첫 테스트가 `http://127.0.0.1:8642/health` 를 받아 `/p/sophie/health` 와 다르다고 보고한다.

- [ ] **Step 3: 구현한다**

`src/lib/hermes/gateway-probe.ts` 에서 opts 타입과 url 조립부만 고친다:

```ts
export async function probeHermesGateway(
  baseUrl: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; profile?: string } = {},
): Promise<GatewayProbeResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = baseUrl.replace(/\/+$/, "");
  // 프로필 스코프는 /p/<name>/ 프리픽스다. 이름은 인코딩한다 — 검증을 통과하지 않은
  // 이름이 그대로 들어오는 경로(원격 검증)가 있다.
  const prefix = opts.profile ? `${base}/p/${encodeURIComponent(opts.profile)}` : base;
  const url = `${prefix}/health`;
```

이후 본문은 그대로 둔다.

- [ ] **Step 4: 통과를 확인한다**

Run: `npx tsx --test src/lib/hermes/gateway-probe.test.ts`
Expected: PASS (9 subtests — 기존 6 + 신규 3)

- [ ] **Step 5: 커밋**

```bash
git commit -m "feat(hermes): let the gateway probe target a profile path" -- src/lib/hermes/gateway-probe.ts src/lib/hermes/gateway-probe.test.ts
```

---

### Task 3: 옵인 컬럼 (스키마 6곳 + 마이그레이션)

`gateway_resources`에 옵인 사실을 기록할 nullable 두 칼럼을 더한다. 값이 아니라 **동의 사실**을 남긴다.

**Files:**
- Modify: `src/db/schema.ts:54-68` (pg drizzle)
- Modify: `src/db/schema-sqlite.ts:54-68` (sqlite drizzle)
- Modify: `src/db/schema.pg.cjs:75` 블록
- Modify: `src/db/schema.sqlite.cjs:73` 블록
- Modify: `src/db/sqlite-base-schema.js:54` 의 CREATE TABLE
- Modify: `src/db/server-db.js:229` 의 CREATE TABLE + `ensureSqliteCompatibility`(`:155`)
- Create: `drizzle/0004_local_discovery_optin.sql`
- Test: `src/db/local-discovery-schema.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces: `gatewayResources.localDiscoveryOptedInAt` (`local_discovery_opted_in_at`, TEXT nullable), `gatewayResources.localDiscoveryOptedInBy` (`local_discovery_opted_in_by`, TEXT nullable, `users.id` 참조)

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/db/local-discovery-schema.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";

import { gatewayResources as pgTable } from "./schema";
import { gatewayResources as sqliteTable } from "./schema-sqlite";

const NEW_COLUMNS = ["local_discovery_opted_in_at", "local_discovery_opted_in_by"];

test("옵인 컬럼이 두 dialect 모두에 있다", () => {
  for (const [label, table] of [["pg", pgTable], ["sqlite", sqliteTable]] as const) {
    const names = Object.values(table).map((c) => (c as { name?: string })?.name).filter(Boolean);
    for (const col of NEW_COLUMNS) {
      assert.ok(names.includes(col), `[${label}] ${col} 컬럼이 없다`);
    }
  }
});

test("빈 SQLite DB를 부트스트랩해도 옵인 컬럼이 생긴다", async () => {
  // 런타임 부트스트랩 경로(sqlite-base-schema.js)는 drizzle 정의와 별개다.
  // 여기가 어긋나면 새 DB로 뜬 서버에서만 'no such column' 이 난다.
  const Database = (await import("better-sqlite3")).default;
  const { ensureSqliteBaseSchema } = await import("./server-db.js");
  const db = new Database(":memory:");
  ensureSqliteBaseSchema(db);
  const cols = db.prepare("PRAGMA table_info(gateway_resources)").all() as { name: string }[];
  const names = cols.map((c) => c.name);
  for (const col of NEW_COLUMNS) {
    assert.ok(names.includes(col), `${col} 이 빈 DB 부트스트랩에서 누락됐다`);
  }
  db.close();
});

test("컬럼이 없는 기존 DB도 호환 경로가 채워준다", async () => {
  const Database = (await import("better-sqlite3")).default;
  const { ensureSqliteCompatibility } = await import("./server-db.js");
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE gateway_resources (
      id TEXT PRIMARY KEY NOT NULL,
      owner_user_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      token_encrypted TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  ensureSqliteCompatibility(db);
  const names = (db.prepare("PRAGMA table_info(gateway_resources)").all() as { name: string }[])
    .map((c) => c.name);
  for (const col of NEW_COLUMNS) {
    assert.ok(names.includes(col), `${col} 이 기존 DB 마이그레이션에서 누락됐다`);
  }
  db.close();
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx tsx --test src/db/local-discovery-schema.test.ts`
Expected: FAIL — 첫 테스트가 `[pg] local_discovery_opted_in_at 컬럼이 없다`

- [ ] **Step 3: 여섯 곳을 고친다**

`src/db/schema-sqlite.ts` — `lastValidationError` 다음 줄에 추가:

```ts
  localDiscoveryOptedInAt: text("local_discovery_opted_in_at"),
  localDiscoveryOptedInBy: text("local_discovery_opted_in_by").references(() => users.id, { onDelete: "set null" }),
```

`src/db/schema.ts` — 같은 위치에, pg 헬퍼로:

```ts
  localDiscoveryOptedInAt: timestamp("local_discovery_opted_in_at"),
  localDiscoveryOptedInBy: text("local_discovery_opted_in_by").references(() => users.id, { onDelete: "set null" }),
```

`src/db/schema.sqlite.cjs` 와 `src/db/schema.pg.cjs` — 각 파일의 `gatewayResources` 블록에 위 두 줄을 같은 순서·같은 이름으로 넣는다. `schema-drift.test.ts`가 .ts와 .cjs를 **컬럼 순서까지** 대조하므로 위치를 맞춘다.

`src/db/sqlite-base-schema.js` — CREATE TABLE 안 `last_validation_error TEXT,` 다음에:

```sql
      local_discovery_opted_in_at TEXT,
      local_discovery_opted_in_by TEXT REFERENCES users(id) ON DELETE SET NULL,
```

`src/db/server-db.js:229` 의 CREATE TABLE에도 같은 두 줄을 넣고, `ensureSqliteCompatibility`(`:155`)에 기존 `hermes_profile_id` 패턴(`:340-341`)을 따라 추가한다:

```js
  const gwCols = sqlite.prepare("PRAGMA table_info(gateway_resources)").all().map((c) => c.name);
  if (!gwCols.includes("local_discovery_opted_in_at")) {
    sqlite.exec("ALTER TABLE gateway_resources ADD COLUMN local_discovery_opted_in_at TEXT");
  }
  if (!gwCols.includes("local_discovery_opted_in_by")) {
    sqlite.exec("ALTER TABLE gateway_resources ADD COLUMN local_discovery_opted_in_by TEXT REFERENCES users(id) ON DELETE SET NULL");
  }
```

`drizzle/0004_local_discovery_optin.sql` 생성:

```sql
ALTER TABLE "gateway_resources" ADD COLUMN IF NOT EXISTS "local_discovery_opted_in_at" timestamp;
ALTER TABLE "gateway_resources" ADD COLUMN IF NOT EXISTS "local_discovery_opted_in_by" text;
DO $$ BEGIN
  ALTER TABLE "gateway_resources"
    ADD CONSTRAINT "gateway_resources_local_discovery_opted_in_by_users_id_fk"
    FOREIGN KEY ("local_discovery_opted_in_by") REFERENCES "users"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
```

- [ ] **Step 4: 통과를 확인한다**

Run: `npx tsx --test src/db/local-discovery-schema.test.ts src/db/schema-drift.test.ts`
Expected: 둘 다 PASS. 드리프트 테스트가 실패하면 .ts와 .cjs의 컬럼 **순서**가 다른 것이다.

- [ ] **Step 5: 커밋**

```bash
git commit -m "feat(db): record per-gateway local-discovery opt-in" -- src/db/ drizzle/0004_local_discovery_optin.sql
```

---

### Task 4: 발견 API

옵인과 발견을 서버에서 처리한다. 토큰은 서버 밖으로 나가지 않는다.

**Files:**
- Create: `src/lib/hermes/local-discovery.ts`
- Create: `src/lib/hermes/local-discovery.test.ts`
- Create: `src/app/api/gateways/[id]/local-discovery/route.ts`
- Create: `src/app/api/gateways/[id]/profiles/probe/route.ts`

**Interfaces:**
- Consumes: `listLocalProfiles`, `readProfileToken`, `resolveProfilesRoot`, `nodeProfileFs` (Task 1), `probeHermesGateway` (Task 2), `getAccessibleGatewayResource`(`src/lib/gateway-resources.ts:142`), `registerHermesProfile`(`src/lib/hermes-profiles.ts`)
- Produces:
  - `type DiscoveryCandidate = { name: string; hasToken: boolean; servedByGateway: boolean; alreadyRegistered: boolean }`
  - `discoverLocalProfiles(deps): Promise<DiscoveryCandidate[]>`
  - `POST /api/gateways/:id/local-discovery` — 옵인 (소유자 한정)
  - `GET  /api/gateways/:id/local-discovery` — 후보 목록 (옵인 후에만)
  - `POST /api/gateways/:id/local-discovery` body `{ profiles: string[] }` 로 선택 등록
  - `POST /api/gateways/:id/profiles/probe` body `{ profileName }` → `{ status: "ok"|"not_found"|"unknown" }`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/lib/hermes/local-discovery.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";

import { discoverLocalProfiles } from "./local-discovery";

const BASE = "http://127.0.0.1:8642";

test("discoverLocalProfiles", async (t) => {
  await t.test("파일시스템과 게이트웨이를 겹쳐 판단한다", async () => {
    // acestep_output 은 실측상 프로필과 같은 레이아웃이지만 게이트웨이가 서빙하지
    // 않는다. 파일시스템만 믿으면 이걸 프로필로 제시하게 된다.
    const result = await discoverLocalProfiles({
      baseUrl: BASE,
      localProfiles: [
        { name: "sophie", hasToken: true },
        { name: "acestep_output", hasToken: true },
      ],
      registeredNames: [],
      probe: async (_base, profile) => (profile === "sophie" ? "hermes" : "not-hermes"),
    });
    assert.deepEqual(result, [
      { name: "sophie", hasToken: true, servedByGateway: true, alreadyRegistered: false },
      { name: "acestep_output", hasToken: true, servedByGateway: false, alreadyRegistered: false },
    ]);
  });

  await t.test("이미 등록된 이름을 표시한다", async () => {
    const result = await discoverLocalProfiles({
      baseUrl: BASE,
      localProfiles: [{ name: "danvi", hasToken: true }],
      registeredNames: ["danvi"],
      probe: async () => "hermes",
    });
    assert.equal(result[0].alreadyRegistered, true);
  });

  await t.test("탐침이 실패해도 목록은 돌려준다 — servedByGateway=false", async () => {
    const result = await discoverLocalProfiles({
      baseUrl: BASE,
      localProfiles: [{ name: "sophie", hasToken: true }],
      registeredNames: [],
      probe: async () => "unreachable",
    });
    assert.deepEqual(result, [
      { name: "sophie", hasToken: true, servedByGateway: false, alreadyRegistered: false },
    ]);
  });

  await t.test("반환값에 토큰이 절대 실리지 않는다", async () => {
    const result = await discoverLocalProfiles({
      baseUrl: BASE,
      localProfiles: [{ name: "sophie", hasToken: true }],
      registeredNames: [],
      probe: async () => "hermes",
    });
    assert.equal(JSON.stringify(result).includes("API_SERVER_KEY"), false);
    assert.deepEqual(Object.keys(result[0]).sort(), [
      "alreadyRegistered",
      "hasToken",
      "name",
      "servedByGateway",
    ]);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx tsx --test src/lib/hermes/local-discovery.test.ts`
Expected: FAIL — `Cannot find module './local-discovery'`

- [ ] **Step 3: 구현한다**

`src/lib/hermes/local-discovery.ts`:

```ts
import type { LocalProfile } from "./local-profiles";

export type DiscoveryCandidate = {
  name: string;
  hasToken: boolean;
  servedByGateway: boolean;
  alreadyRegistered: boolean;
};

export type DiscoverDeps = {
  baseUrl: string;
  localProfiles: LocalProfile[];
  registeredNames: string[];
  /** "hermes" = 그 게이트웨이가 이 프로필을 서빙한다. */
  probe: (baseUrl: string, profile: string) => Promise<"hermes" | "not-hermes" | "unreachable">;
};

/**
 * 파일시스템 목록과 게이트웨이 탐침을 겹쳐 후보를 만든다.
 *
 * 파일시스템은 "이름과 토큰이 있다"만 알려주고, 게이트웨이는 "실제로 서빙 중이다"를
 * 알려준다. 각자 상대의 약점을 덮는다(스펙 §6.1).
 */
export async function discoverLocalProfiles(deps: DiscoverDeps): Promise<DiscoveryCandidate[]> {
  const registered = new Set(deps.registeredNames);
  const probed = await Promise.all(
    deps.localProfiles.map(async (p) => {
      let kind: "hermes" | "not-hermes" | "unreachable";
      try {
        kind = await deps.probe(deps.baseUrl, p.name);
      } catch {
        kind = "unreachable";
      }
      return { p, kind };
    }),
  );
  return probed.map(({ p, kind }) => ({
    name: p.name,
    hasToken: p.hasToken,
    servedByGateway: kind === "hermes",
    alreadyRegistered: registered.has(p.name),
  }));
}
```

`src/app/api/gateways/[id]/local-discovery/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { homedir } from "node:os";

import { getAccessibleGatewayResource } from "@/lib/gateway-resources";
import { probeHermesGateway } from "@/lib/hermes/gateway-probe";
import { discoverLocalProfiles } from "@/lib/hermes/local-discovery";
import {
  listLocalProfiles,
  nodeProfileFs,
  readProfileToken,
  resolveProfilesRoot,
} from "@/lib/hermes/local-profiles";
import { listHermesProfiles, registerHermesProfile } from "@/lib/hermes-profiles";
import { getUserId } from "@/lib/internal-rpc";
import { eq } from "drizzle-orm";

import { db, gatewayResources } from "@/db";

function nowForDb() {
  return new Date().toISOString();
}

/** 옵인 전에는 파일시스템을 건드리지 않는다. */
function optedIn(resource: { localDiscoveryOptedInAt?: string | Date | null }) {
  return !!resource.localDiscoveryOptedInAt;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const accessible = await getAccessibleGatewayResource(userId, id);
  if (!accessible) {
    return NextResponse.json({ errorCode: "gateway_not_found", error: "Gateway not found" }, { status: 404 });
  }

  const root = resolveProfilesRoot(process.env, homedir());
  const fs = nodeProfileFs();
  // 능력 검사: 루트가 실제로 있는가. URL이 127.0.0.1이어도 컨테이너 안이면 없다.
  const available = fs.existsSync(root);

  if (!optedIn(accessible.resource)) {
    return NextResponse.json({ available, optedIn: false, candidates: [] });
  }

  const registered = await listHermesProfiles(userId, id);
  const candidates = await discoverLocalProfiles({
    baseUrl: accessible.resource.baseUrl,
    localProfiles: listLocalProfiles(root, fs),
    registeredNames: registered.map((r) => r.profileName),
    probe: async (baseUrl, profile) => (await probeHermesGateway(baseUrl, { profile })).kind,
  });
  return NextResponse.json({ available, optedIn: true, candidates });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const accessible = await getAccessibleGatewayResource(userId, id);
  if (!accessible) {
    return NextResponse.json({ errorCode: "gateway_not_found", error: "Gateway not found" }, { status: 404 });
  }
  // 비밀 파일을 읽는 동의는 소유자만 줄 수 있다.
  if (!accessible.isOwner) {
    return NextResponse.json({ errorCode: "forbidden", error: "owner only" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));

  if (body?.action === "opt-in") {
    await db
      .update(gatewayResources)
      .set({ localDiscoveryOptedInAt: nowForDb(), localDiscoveryOptedInBy: userId })
      .where(eq(gatewayResources.id, id));
    return NextResponse.json({ ok: true, optedIn: true });
  }

  if (!optedIn(accessible.resource)) {
    return NextResponse.json({ errorCode: "not_opted_in", error: "opt-in required" }, { status: 403 });
  }

  const names: string[] = Array.isArray(body?.profiles)
    ? body.profiles.filter((n: unknown) => typeof n === "string")
    : [];
  if (!names.length) {
    return NextResponse.json({ errorCode: "no_profiles", error: "no profiles selected" }, { status: 400 });
  }

  const root = resolveProfilesRoot(process.env, homedir());
  const fs = nodeProfileFs();
  const results: { name: string; ok: boolean; errorCode?: string }[] = [];
  for (const name of names) {
    const token = readProfileToken(root, name, fs);
    if (!token) {
      results.push({ name, ok: false, errorCode: "no_token" });
      continue;
    }
    // 반환은 { profile } | { error: "forbidden" } 이다 — ok 불리언이 아니다.
    const registered = await registerHermesProfile({
      userId,
      gatewayId: id,
      profileName: name,
      token,
    });
    results.push(
      "error" in registered
        ? { name, ok: false, errorCode: registered.error }
        : { name, ok: true },
    );
  }
  return NextResponse.json({ results });
}
```

`src/app/api/gateways/[id]/profiles/probe/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";

import { getAccessibleGatewayResource } from "@/lib/gateway-resources";
import { probeHermesGateway } from "@/lib/hermes/gateway-probe";
import { getUserId } from "@/lib/internal-rpc";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const accessible = await getAccessibleGatewayResource(userId, id);
  if (!accessible) {
    return NextResponse.json({ errorCode: "gateway_not_found", error: "Gateway not found" }, { status: 404 });
  }
  const body = await req.json().catch(() => ({}));
  const profileName = typeof body?.profileName === "string" ? body.profileName.trim() : "";
  if (!profileName) {
    return NextResponse.json({ status: "unknown" });
  }
  const probe = await probeHermesGateway(accessible.resource.baseUrl, { profile: profileName });
  // 세 상태를 뭉개지 않는다 — "없는 프로필"과 "게이트웨이가 죽었다"는 다른 문제다.
  const status = probe.kind === "hermes" ? "ok" : probe.kind === "not-hermes" ? "not_found" : "unknown";
  return NextResponse.json({ status });
}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `npx tsx --test src/lib/hermes/local-discovery.test.ts`
Expected: PASS (4 subtests)

Run: `npx tsc --noEmit 2>&1 | grep -v '\.test\.' | grep 'error TS' | head`
Expected: 출력 없음.

`registerHermesProfile`은 소유권을 요구하고(`src/lib/hermes-profiles.ts:71-72`) `{ profile } | { error: "forbidden" }` 를 돌려준다. 옵인이 이미 소유자 한정이므로 `forbidden`은 정상 경로에서 나오지 않지만, 결과 배열에는 그대로 담아 화면이 이유를 말할 수 있게 한다.

- [ ] **Step 5: 커밋**

```bash
git add src/lib/hermes/local-discovery.ts src/lib/hermes/local-discovery.test.ts 'src/app/api/gateways/[id]/local-discovery/route.ts' 'src/app/api/gateways/[id]/profiles/probe/route.ts'
git commit -m "feat(gateways): add local profile discovery and remote name probe APIs" -- src/lib/hermes/ src/app/api/gateways/
```

---

### Task 5: 발견 UI

`HermesProfileList` 위에 발견 패널을 붙인다. 옵인 전에는 버튼만, 옵인 후에는 체크박스 목록.

**Files:**
- Create: `src/components/hermes/discovery-rows.ts`
- Create: `src/components/hermes/discovery-rows.test.ts`
- Modify: `src/components/hermes/HermesProfileList.tsx`

**Interfaces:**
- Consumes: `DiscoveryCandidate` (Task 4)
- Produces: `type DiscoveryRow = DiscoveryCandidate & { selectable: boolean; reason: "ok"|"no_token"|"not_served"|"already" }`, `toDiscoveryRows(candidates: DiscoveryCandidate[]): DiscoveryRow[]`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/components/hermes/discovery-rows.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";

import { toDiscoveryRows } from "./discovery-rows";

test("toDiscoveryRows", async (t) => {
  await t.test("토큰이 있고 서빙 중이며 미등록이면 선택 가능", () => {
    const [row] = toDiscoveryRows([
      { name: "sophie", hasToken: true, servedByGateway: true, alreadyRegistered: false },
    ]);
    assert.deepEqual(row, {
      name: "sophie",
      hasToken: true,
      servedByGateway: true,
      alreadyRegistered: false,
      selectable: true,
      reason: "ok",
    });
  });

  await t.test("이미 등록됐으면 선택 불가 — 사유가 우선한다", () => {
    const [row] = toDiscoveryRows([
      { name: "danvi", hasToken: true, servedByGateway: true, alreadyRegistered: true },
    ]);
    assert.equal(row.selectable, false);
    assert.equal(row.reason, "already");
  });

  await t.test("토큰이 없으면 선택 불가", () => {
    const [row] = toDiscoveryRows([
      { name: "ada", hasToken: false, servedByGateway: true, alreadyRegistered: false },
    ]);
    assert.equal(row.selectable, false);
    assert.equal(row.reason, "no_token");
  });

  await t.test("게이트웨이가 서빙하지 않으면 선택 불가", () => {
    // acestep_output 처럼 프로필 모양이지만 에이전트가 아닌 디렉토리가 여기 걸린다.
    const [row] = toDiscoveryRows([
      { name: "acestep_output", hasToken: true, servedByGateway: false, alreadyRegistered: false },
    ]);
    assert.equal(row.selectable, false);
    assert.equal(row.reason, "not_served");
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx tsx --test src/components/hermes/discovery-rows.test.ts`
Expected: FAIL — `Cannot find module './discovery-rows'`

- [ ] **Step 3: 구현한다**

`src/components/hermes/discovery-rows.ts`:

```ts
import type { DiscoveryCandidate } from "@/lib/hermes/local-discovery";

export type DiscoveryRow = DiscoveryCandidate & {
  selectable: boolean;
  reason: "ok" | "no_token" | "not_served" | "already";
};

/**
 * 후보를 화면 행으로 바꾼다. 사유는 하나만 보여준다 — 여러 개를 나열하면
 * 사용자가 무엇부터 고쳐야 할지 모른다. 등록됨 > 토큰 없음 > 서빙 안 함 순으로
 * 우선한다(가장 손댈 게 없는 것부터).
 */
export function toDiscoveryRows(candidates: DiscoveryCandidate[]): DiscoveryRow[] {
  return candidates.map((c) => {
    let reason: DiscoveryRow["reason"] = "ok";
    if (c.alreadyRegistered) reason = "already";
    else if (!c.hasToken) reason = "no_token";
    else if (!c.servedByGateway) reason = "not_served";
    return { ...c, selectable: reason === "ok", reason };
  });
}
```

`src/components/hermes/HermesProfileList.tsx` — 기존 "프로필 추가" 폼 위에 패널을 넣는다. 컴포넌트 안에 상태 셋을 더한다:

```tsx
const [discovery, setDiscovery] = useState<{ available: boolean; optedIn: boolean; rows: DiscoveryRow[] } | null>(null);
const [selected, setSelected] = useState<string[]>([]);
const [probeStatus, setProbeStatus] = useState<"idle" | "ok" | "not_found" | "unknown">("idle");
```

마운트 시 발견 상태를 읽는다:

```tsx
useEffect(() => {
  let cancelled = false;
  fetch(`/api/gateways/${gatewayId}/local-discovery`)
    .then((r) => r.json())
    .then((d) => {
      if (cancelled) return;
      setDiscovery({ available: !!d.available, optedIn: !!d.optedIn, rows: toDiscoveryRows(d.candidates ?? []) });
    })
    .catch(() => undefined);
  return () => { cancelled = true; };
}, [gatewayId]);
```

렌더:

```tsx
{discovery?.available && canRegister && !discovery.optedIn && (
  <button
    type="button"
    onClick={async () => {
      await fetch(`/api/gateways/${gatewayId}/local-discovery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "opt-in" }),
      });
      const d = await fetch(`/api/gateways/${gatewayId}/local-discovery`).then((r) => r.json());
      setDiscovery({ available: !!d.available, optedIn: !!d.optedIn, rows: toDiscoveryRows(d.candidates ?? []) });
    }}
  >
    {t("hermes.discovery.optIn")}
  </button>
)}

{discovery?.optedIn && discovery.rows.length > 0 && (
  <div>
    {discovery.rows.map((row) => (
      <label key={row.name}>
        <input
          type="checkbox"
          disabled={!row.selectable}
          checked={selected.includes(row.name)}
          onChange={(e) =>
            setSelected((prev) => (e.target.checked ? [...prev, row.name] : prev.filter((n) => n !== row.name)))
          }
        />
        <span>{row.name}</span>
        {row.reason !== "ok" && <span>{t(`hermes.discovery.reason.${row.reason}`)}</span>}
      </label>
    ))}
    <button
      type="button"
      disabled={!selected.length}
      onClick={async () => {
        await fetch(`/api/gateways/${gatewayId}/local-discovery`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profiles: selected }),
        });
        setSelected([]);
        await reload();
      }}
    >
      {t("hermes.discovery.registerSelected")}
    </button>
  </div>
)}
```

원격 검증은 이름 입력란의 `onBlur`에 건다(디바운스 타이머를 새로 만들지 않는다 — 입력이 끝난 시점이 곧 검증 시점이다):

```tsx
onBlur={async () => {
  if (!profileName.trim()) { setProbeStatus("idle"); return; }
  const r = await fetch(`/api/gateways/${gatewayId}/profiles/probe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profileName }),
  }).then((x) => x.json()).catch(() => ({ status: "unknown" }));
  setProbeStatus(r.status);
}}
```

i18n 키를 4개 로케일(`ko`, `en`, `ja`, `zh`) 모두에 추가한다:

```
hermes.discovery.optIn              ko "이 머신의 Hermes 프로필 읽기"
hermes.discovery.registerSelected   ko "선택한 프로필 등록"
hermes.discovery.reason.already     ko "이미 등록됨"
hermes.discovery.reason.no_token    ko "토큰 없음"
hermes.discovery.reason.not_served  ko "게이트웨이가 서빙하지 않음"
hermes.probe.ok                     ko "확인됨"
hermes.probe.not_found              ko "이 게이트웨이에 없는 프로필"
hermes.probe.unknown                ko "확인 불가"
```

en: "Read this machine's Hermes profiles" / "Register selected" / "Already registered" / "No token" / "Not served by this gateway" / "Verified" / "Not found on this gateway" / "Could not verify". ja·zh도 같은 의미로 채운다.

- [ ] **Step 4: 통과를 확인한다**

Run: `npx tsx --test src/components/hermes/discovery-rows.test.ts`
Expected: PASS (4 subtests)

Run: `for l in ko en ja zh; do printf "%s: %s\n" "$l" "$(grep -c 'hermes.discovery\.\|hermes.probe\.' src/lib/i18n/locales/$l.ts)"; done`
Expected: 네 로케일 모두 `8`

- [ ] **Step 5: 커밋**

```bash
git commit -m "feat(ui): pick Hermes profiles from a discovered list" -- src/components/hermes/ src/lib/i18n/locales/
```

---

### Task 6: 최종 검증

**Files:** 없음 (검증만)

**Interfaces:**
- Consumes: Task 1~5 전부
- Produces: 없음

- [ ] **Step 1: 전체 테스트**

Run: `npx tsx --test $(git ls-files 'src/**/*.test.ts' 'src/**/*.test.js' 'src/**/*.test.tsx' | tr '\n' ' ') 2>&1 | grep -E '^# (tests|pass|fail)'`
Expected: `# fail 0`, 그리고 pass 수가 시작값 537보다 크다(신규 24개 예상 → 561).

- [ ] **Step 2: 프로덕션 타입 에러**

Run: `npx tsc --noEmit 2>&1 | grep -v '\.test\.\(ts\|tsx\)' | grep -c 'error TS'`
Expected: `0`

- [ ] **Step 3: 린트**

Run: `npx eslint src/lib/hermes/ src/components/hermes/ 'src/app/api/gateways/' 2>&1 | grep -c 'error'`
Expected: `0` (경고는 허용)

- [ ] **Step 4: Docker COPY 폐포**

Dockerfile은 디렉토리가 아니라 **파일 단위**로 COPY한다. 새 파일은 반드시 줄을 더해야 한다.

Run:
```bash
for f in $(ls src/lib/hermes/*.ts | grep -v '\.test\.'); do
  grep -q "$f" Dockerfile || echo "MISSING $f"
done
```
Expected: 출력 없음.

누락이 있으면 `src/lib/hermes/gateway-probe.ts` 줄 아래에 같은 형식으로 더한다:

```dockerfile
COPY --from=builder /app/src/lib/hermes/local-profiles.ts ./src/lib/hermes/local-profiles.ts
COPY --from=builder /app/src/lib/hermes/local-discovery.ts ./src/lib/hermes/local-discovery.ts
```

이 프로젝트에서 COPY 누락은 이미 네 번 발생했다(가장 최근: `gateway-probe.ts`, 이 플랜을 쓰다 발견). 컨테이너에서만 module-not-found로 죽으므로 로컬 테스트로는 절대 안 잡힌다.

- [ ] **Step 5: 옵인 없이는 파일을 읽지 않는지 확인**

Run:
```bash
grep -n 'optedIn' 'src/app/api/gateways/[id]/local-discovery/route.ts'
```
Expected: GET과 POST 양쪽에서 `listLocalProfiles`/`readProfileToken` 호출 **앞에** `optedIn` 검사가 있다. GET은 옵인 전이면 `candidates: []` 로 즉시 반환하고, POST는 `not_opted_in` 403을 낸다.

- [ ] **Step 6: 토큰이 응답에 새지 않는지 확인**

Run:
```bash
grep -n 'readProfileToken' 'src/app/api/gateways/[id]/local-discovery/route.ts'
```
Expected: `readProfileToken`의 반환값이 `registerHermesProfile` 인자로만 흘러가고, `NextResponse.json` 인자에 닿는 경로가 없다.

- [ ] **Step 7: 커밋**

```bash
git commit --allow-empty -m "chore: verify hermes profile discovery" 
```

---

## 수동 확인 (에이전트가 못 하는 것)

`.superpowers/sdd/<이 플랜>/manual-verification.md` 에 기록할 것:

1. **로컬 발견** — `/gateways`에서 로컬 Hermes를 선택 → "이 머신의 Hermes 프로필 읽기" → 목록에 `sophie`·`danvi`가 "토큰 있음/서빙 중"으로, `acestep_output`이 "게이트웨이가 서빙하지 않음"으로 나오는지. **토큰을 한 번도 입력하지 않고** 등록되는지.
2. **default 프로필** — 목록에서 `default`가 "토큰 있음"으로 나오는지(`~/.hermes/.env`에서 읽는 예외 경로).
3. **원격 검증** — 게이트웨이 URL을 원격 주소로 바꾼 뒤 이름을 치고 포커스를 옮겼을 때 확인됨/없음/확인 불가가 구분되는지. 게이트웨이를 끈 상태에서도 **저장이 되는지**.
4. **옵인 격리** — 다른 사용자에게 게이트웨이를 공유한 뒤, 그 사용자에게 옵인 버튼이 안 보이는지(소유자 한정).
5. **Docker** — 컨테이너로 띄웠을 때 옵인 버튼이 나타나지 않고 원격 검증만 동작하는지.
