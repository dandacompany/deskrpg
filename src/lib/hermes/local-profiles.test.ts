import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveProfilesRoot,
  listLocalProfiles,
  readProfileToken,
  type ProfileFs,
} from "./local-profiles";

/** In-memory fake filesystem. Keys are absolute paths. */
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
  await t.test("defaults to ~/.hermes/profiles", () => {
    assert.equal(resolveProfilesRoot({}, "/Users/dante"), "/Users/dante/.hermes/profiles");
  });

  await t.test("uses HERMES_HOME when it is outside ~/.hermes (Docker deployment)", () => {
    // Follows the rule in hermes_cli/profiles.py:_get_default_hermes_home.
    assert.equal(
      resolveProfilesRoot({ HERMES_HOME: "/opt/data" }, "/Users/dante"),
      "/opt/data/profiles",
    );
  });

  await t.test("returns to the root even if HERMES_HOME points inside a profile", () => {
    // HERMES_HOME can itself be a profile. Creating profiles/ under it then
    // yields a nested, bogus path.
    assert.equal(
      resolveProfilesRoot({ HERMES_HOME: "/Users/dante/.hermes/profiles/sophie" }, "/Users/dante"),
      "/Users/dante/.hermes/profiles",
    );
  });
});

test("listLocalProfiles", async (t) => {
  const root = "/h/profiles";

  await t.test("treats only directories with config.yaml as profiles", () => {
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

  await t.test("hasToken=false when the token is missing or shorter than 16 chars", () => {
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

  await t.test("excludes directories that fail the name rule", () => {
    const fs = fakeFs({ "/h/profiles/../config.yaml": "x", "/h/profiles/ok/config.yaml": "x" }, [
      "/h/profiles",
      "/h/profiles/..",
      "/h/profiles/ok",
    ]);
    assert.deepEqual(listLocalProfiles(root, fs), [{ name: "ok", hasToken: false }]);
  });

  await t.test("no root yields an empty array — containers fall through to here", () => {
    const fs = fakeFs({}, []);
    assert.deepEqual(listLocalProfiles(root, fs), []);
  });
});

test("readProfileToken", async (t) => {
  await t.test("a named profile reads from its own .env", () => {
    const fs = fakeFs(
      {
        "/h/profiles/sophie/.env": "FOO=1\nAPI_SERVER_KEY=" + "a".repeat(48) + "\n",
      },
      ["/h/profiles", "/h/profiles/sophie"],
    );
    assert.equal(readProfileToken("/h/profiles", "sophie", fs), "a".repeat(48));
  });

  await t.test("the default profile reads from the root's parent .env", () => {
    // Measured: ~/.hermes/profiles/default/ has no .env. default's home is
    // ~/.hermes/ itself, so the token lives in <root's parent>/.env.
    const fs = fakeFs({ "/h/.env": "API_SERVER_KEY=" + "b".repeat(48) + "\n" }, [
      "/h",
      "/h/profiles",
      "/h/profiles/default",
    ]);
    assert.equal(readProfileToken("/h/profiles", "default", fs), "b".repeat(48));
  });

  await t.test("the last definition wins — the key may have been appended multiple times", () => {
    const fs = fakeFs(
      {
        "/h/profiles/sophie/.env":
          "API_SERVER_KEY=" + "a".repeat(48) + "\nAPI_SERVER_KEY=" + "c".repeat(48) + "\n",
      },
      ["/h/profiles", "/h/profiles/sophie"],
    );
    assert.equal(readProfileToken("/h/profiles", "sophie", fs), "c".repeat(48));
  });

  await t.test("strips surrounding quotes from the value", () => {
    const fs = fakeFs(
      {
        "/h/profiles/sophie/.env": 'API_SERVER_KEY="' + "a".repeat(48) + '"\n',
      },
      ["/h/profiles", "/h/profiles/sophie"],
    );
    assert.equal(readProfileToken("/h/profiles", "sophie", fs), "a".repeat(48));
  });

  await t.test("null when missing", () => {
    const fs = fakeFs({}, ["/h/profiles", "/h/profiles/sophie"]);
    assert.equal(readProfileToken("/h/profiles", "sophie", fs), null);
  });

  // Task 4 review, Critical 1: a caller (the local-discovery registration route) fed a
  // request-body name straight into this function's path concatenation with no
  // validation, so "../../../../srv/otherapp" walked out of the profiles root and read
  // an arbitrary .env off the box. This function must refuse such names itself —
  // defence in depth, independent of whatever the caller does or forgets to do.
  await t.test("a path-traversal name returns null without calling readFileSync", () => {
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

  // Final review I1: the three cases below originally passed even without the guard — fakeFs had
  // no such path at all, so existsSync returned false and that was it. Now we
  // **plant files at the locations the path join actually produces**, and a readFileSync spy
  // confirms the file was not opened. Remove the guard and all three turn red.
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

  await t.test("rejects names containing a slash (even if the file exists)", () => {
    const { fs, opened } = spyFs({ "/h/profiles/a/b/.env": `API_SERVER_KEY=${SECRET}\n` }, [
      "/h/profiles",
      "/h/profiles/a",
      "/h/profiles/a/b",
    ]);
    assert.equal(readProfileToken("/h/profiles", "a/b", fs), null);
    assert.deepEqual(opened, [], "readFileSync가 호출되면 안 된다");
  });

  await t.test("rejects a single dot (.) — only default is special-cased", () => {
    // "." becomes /h/profiles/./.env in the `${root}/${name}/.env` join. A real file must be
    // planted there to show that the guard is the only line of defense.
    const { fs, opened } = spyFs({ "/h/profiles/./.env": `API_SERVER_KEY=${SECRET}\n` }, [
      "/h/profiles",
    ]);
    assert.equal(readProfileToken("/h/profiles", ".", fs), null);
    assert.deepEqual(opened, [], "readFileSync가 호출되면 안 된다");
  });

  await t.test("rejects double dot (..) (even if a .env outside the profile root exists)", () => {
    const { fs, opened } = spyFs({ "/h/profiles/../.env": `API_SERVER_KEY=${SECRET}\n` }, [
      "/h",
      "/h/profiles",
    ]);
    assert.equal(readProfileToken("/h/profiles", "..", fs), null);
    assert.deepEqual(opened, [], "readFileSync가 호출되면 안 된다");
  });
});
