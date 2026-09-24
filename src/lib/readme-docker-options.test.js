// Checks whether the README's Docker instructions actually point at a compose file that
// comes up over HTTP.
//
// On 2026-09-17 the root `docker-compose.yml` changed to be Hostinger-only (Traefik/HTTPS),
// but the README's generic Docker instructions stayed the same. A self-hoster following
// those instructions has **no port to connect to**, and even opening a port directly, the
// `COOKIE_SECURE` default of `true` drops the login cookie over HTTP. This is a defect from
// the docs and the files drifting apart, so fixing the docs alone won't prevent it happening
// again.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..", "..");
const READMES = ["README.md", "README.ko.md"];

/** Every `docker compose …` command line in the README. */
function composeCommands(readme) {
  return readme.split(/\r?\n/).filter((line) => line.trim().startsWith("docker compose "));
}

for (const name of READMES) {
  const readme = fs.readFileSync(path.join(ROOT, name), "utf8");
  const commands = composeCommands(readme);

  test(`${name} — docker compose 안내가 있다`, () => {
    assert.ok(commands.length > 0, "안내가 사라졌으면 아래 검사들이 조용히 무의미해진다");
  });

  test(`${name} — 모든 docker compose 안내가 -f 로 파일을 지정한다 — 루트 compose 는 Hostinger 전용이다`, () => {
    for (const command of commands)
      assert.match(
        command,
        /-f docker\/docker-compose\.[a-z]+\.yml/,
        `파일 지정이 없다: ${command}`,
      );
  });

  test(`${name} — 가리키는 compose 파일이 존재하고, HTTP 포트를 열고, COOKIE_SECURE 기본값이 false 다`, () => {
    const files = new Set(
      commands.flatMap((command) => command.match(/docker\/docker-compose\.[a-z]+\.yml/g) ?? []),
    );
    assert.ok(files.size > 0);
    for (const file of files) {
      const full = path.join(ROOT, file);
      assert.ok(fs.existsSync(full), `${file} 가 없다`);
      const compose = fs.readFileSync(full, "utf8");
      assert.match(compose, /^\s+ports:/m, `${file} 가 포트를 열지 않는다 — 접속할 곳이 없다`);
      assert.match(
        compose,
        /COOKIE_SECURE: \$\{COOKIE_SECURE:-false\}/,
        `${file} 의 COOKIE_SECURE 기본값이 false 가 아니다 — HTTP 에서 로그인이 막힌다`,
      );
    }
  });

  test(`${name} — 그 compose 가 저장소 파일을 마운트하므로 clone 안내가 함께 있다`, () => {
    // Mounts `../public/assets` — running outside the repo means compose can't find the path.
    assert.match(readme, /git clone https:\/\/github\.com\/dandacompany\/deskrpg\.git/);
  });
}

test("the root docker-compose.yml is still Hostinger-only — the premise of this test", () => {
  const compose = fs.readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");
  assert.doesNotMatch(compose, /^\s+ports:/m, "포트가 생겼다면 README 안내를 다시 판단한다");
  assert.match(compose, /COOKIE_SECURE: \$\{COOKIE_SECURE:-true\}/);
});

test("server.js leaves COOKIE_SECURE false when unset — npm and standalone docker run are HTTP", () => {
  // This file is the standalone bundle's entry point, so importing it would look for the
  // Next build output. So we check it by content instead — if this rule disappeared,
  // `NODE_ENV=production` would fall back to Secure.
  const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  assert.match(
    server,
    /if \(!process\.env\.COOKIE_SECURE\) process\.env\.COOKIE_SECURE = "false";/,
  );
});
