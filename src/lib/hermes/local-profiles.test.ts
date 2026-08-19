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
