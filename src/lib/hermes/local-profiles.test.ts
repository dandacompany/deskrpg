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
    const fs = fakeFs({ "/h/profiles/../config.yaml": "x", "/h/profiles/ok/config.yaml": "x" }, [
      "/h/profiles",
      "/h/profiles/..",
      "/h/profiles/ok",
    ]);
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
      {
        "/h/profiles/sophie/.env": "FOO=1\nAPI_SERVER_KEY=" + "a".repeat(48) + "\n",
      },
      ["/h/profiles", "/h/profiles/sophie"],
    );
    assert.equal(readProfileToken("/h/profiles", "sophie", fs), "a".repeat(48));
  });

  await t.test("default 프로필은 루트의 부모 .env 에서 읽는다", () => {
    // 실측: ~/.hermes/profiles/default/ 에는 .env가 없다. default의 홈은
    // ~/.hermes/ 자체이므로 토큰은 <루트의 부모>/.env 에 있다.
    const fs = fakeFs({ "/h/.env": "API_SERVER_KEY=" + "b".repeat(48) + "\n" }, [
      "/h",
      "/h/profiles",
      "/h/profiles/default",
    ]);
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
      {
        "/h/profiles/sophie/.env": 'API_SERVER_KEY="' + "a".repeat(48) + '"\n',
      },
      ["/h/profiles", "/h/profiles/sophie"],
    );
    assert.equal(readProfileToken("/h/profiles", "sophie", fs), "a".repeat(48));
  });

  await t.test("없으면 null", () => {
    const fs = fakeFs({}, ["/h/profiles", "/h/profiles/sophie"]);
    assert.equal(readProfileToken("/h/profiles", "sophie", fs), null);
  });

  // Task 4 review, Critical 1: a caller (the local-discovery registration route) fed a
  // request-body name straight into this function's path concatenation with no
  // validation, so "../../../../srv/otherapp" walked out of the profiles root and read
  // an arbitrary .env off the box. This function must refuse such names itself —
  // defence in depth, independent of whatever the caller does or forgets to do.
  await t.test("경로 순회 이름은 readFileSync를 호출하지 않고 null을 돌려준다", () => {
    let readFileSyncCalled = false;
    const fs: ProfileFs = {
      ...fakeFs({ "/srv/otherapp/.env": "API_SERVER_KEY=" + "a".repeat(48) + "\n" }, [
        "/h/profiles",
        "/srv/otherapp",
      ]),
      readFileSync: (p) => {
        readFileSyncCalled = true;
        throw new Error("should never be reached: " + p);
      },
    };
    assert.equal(readProfileToken("/h/profiles", "../../../../srv/otherapp", fs), null);
    assert.equal(
      readFileSyncCalled,
      false,
      "readFileSync must never be called for a traversal name",
    );
  });

  // 최종 리뷰 I1: 아래 세 케이스는 원래 가드가 없어도 통과했다 — fakeFs에 해당
  // 경로가 아예 없었기 때문에 existsSync가 false를 돌려주고 끝났다. 이제는
  // **경로 결합이 실제로 만들어내는 자리에 파일을 심고**, readFileSync 스파이로
  // 파일이 열리지 않았음을 확인한다. 가드를 지우면 이 세 개가 전부 빨개진다.
  function spyFs(files: Record<string, string>, dirs: string[]) {
    const base = fakeFs(files, dirs);
    const opened: string[] = [];
    const fs: ProfileFs = {
      ...base,
      readFileSync: (p, enc) => {
        opened.push(p);
        return base.readFileSync(p, enc);
      },
    };
    return { fs, opened };
  }

  const SECRET = "s".repeat(48);

  await t.test("슬래시를 포함한 이름은 거부한다 (파일이 실재해도)", () => {
    const { fs, opened } = spyFs({ "/h/profiles/a/b/.env": `API_SERVER_KEY=${SECRET}\n` }, [
      "/h/profiles",
      "/h/profiles/a",
      "/h/profiles/a/b",
    ]);
    assert.equal(readProfileToken("/h/profiles", "a/b", fs), null);
    assert.deepEqual(opened, [], "readFileSync가 호출되면 안 된다");
  });

  await t.test("단일 점(.)은 거부한다 — default 만 특례다", () => {
    // "." 은 `${root}/${name}/.env` 결합에서 /h/profiles/./.env 가 된다. 그 자리에
    // 실제 파일을 심어 두어야 가드가 유일한 방어선임이 드러난다.
    const { fs, opened } = spyFs({ "/h/profiles/./.env": `API_SERVER_KEY=${SECRET}\n` }, [
      "/h/profiles",
    ]);
    assert.equal(readProfileToken("/h/profiles", ".", fs), null);
    assert.deepEqual(opened, [], "readFileSync가 호출되면 안 된다");
  });

  await t.test("이중 점(..)은 거부한다 (프로필 루트 밖의 .env가 실재해도)", () => {
    const { fs, opened } = spyFs({ "/h/profiles/../.env": `API_SERVER_KEY=${SECRET}\n` }, [
      "/h",
      "/h/profiles",
    ]);
    assert.equal(readProfileToken("/h/profiles", "..", fs), null);
    assert.deepEqual(opened, [], "readFileSync가 호출되면 안 된다");
  });
});
