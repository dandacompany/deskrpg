// docker/docker-compose.hermes.yml runs DeskRPG + Hermes on my own computer without a VPS.
// Unlike the root VPS stack, it assumes HTTP/localhost, so if the rules below break, login or gateway connection fails silently.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..", "..");
const compose = fs.readFileSync(path.join(ROOT, "docker", "docker-compose.hermes.yml"), "utf8");

test("every published port binds to 127.0.0.1 only — so no one else on the network can reach the office/dashboard", () => {
  const published = [...compose.matchAll(/^\s+- "([^"]+)"\s*$/gm)].map((m) => m[1]);
  assert.ok(published.length >= 3, `포트 매핑 ${published.length}개`);
  for (const p of published) assert.match(p, /^127\.0\.0\.1:\d+:\d+$/, p);
});

test("opens the office and socket ports together — without the socket port, the screen loads but the realtime connection fails", () => {
  assert.match(compose, /"127\.0\.0\.1:3102:3000"/);
  assert.match(compose, /"127\.0\.0\.1:3103:3001"/);
});

test("COOKIE_SECURE defaults to false — over HTTP, a Secure cookie gets dropped and login loops", () => {
  assert.match(compose, /COOKIE_SECURE: \$\{COOKIE_SECURE:-false\}/);
});

test("the Hermes API server isn't published — DeskRPG reaches it via hermes:8642 on the compose-internal network", () => {
  assert.doesNotMatch(compose, /:8642"/);
  assert.match(compose, /API_SERVER_PORT: "8642"/);
});

test("plugin install and the gateway receive the same HERMES_API_KEY, and startup is refused if it's empty", () => {
  const keys = [...compose.matchAll(/API_SERVER_KEY: (.+)$/gm)].map((m) => m[1].trim());
  assert.equal(keys.length, 2);
  for (const k of keys) assert.match(k, /^\$\{HERMES_API_KEY:\?/);
});

test("installs and enables the plugin before the gateway", () => {
  assert.match(compose, /hermes plugins enable deskrpg/);
  assert.match(compose, /hermes plugins update deskrpg/);
  assert.match(compose, /hermes-plugins:\s*\n\s*condition: service_completed_successfully/);
});

test("the dashboard turns on only when a password is set", () => {
  assert.match(compose, /HERMES_DASHBOARD: \$\{HERMES_DASHBOARD_PASSWORD:\+true\}/);
});

test("no Traefik labels and no public JWT default", () => {
  assert.doesNotMatch(compose, /traefik\./);
  assert.match(compose, /JWT_SECRET: \$\{JWT_SECRET:-\}/);
});

test("model keys are written to .env in the Hermes volume — container env vars alone aren't read by Hermes, and a new employee inherits keys from that file", () => {
  const block = compose.slice(compose.indexOf("  hermes-plugins:"), compose.indexOf("\n  hermes:"));
  for (const v of ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {
    assert.match(block, new RegExp(`${v}: \\$\\{${v}:-\\}`));
  }
  assert.match(block, /for v in OPENROUTER_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY/);
  assert.match(block, /> \/opt\/data\/\.env/);
});
