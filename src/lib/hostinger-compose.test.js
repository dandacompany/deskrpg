// The root docker-compose.yml is deployed as-is by the Hostinger docker manager. Every rule
// below came from actual observation, and breaking any one silently fails the one-click
// deploy (basis: deploy/hostinger/README.md).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..", "..");
const compose = fs.readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");

test("is 8192 characters or fewer — the docker manager API rejects longer content", () => {
  assert.ok(compose.length <= 8192, `현재 ${compose.length}자`);
});

test("does not declare traefik-proxy as a network — external breaks host-mode Traefik, and creating it breaks bridge-mode Traefik", () => {
  assert.doesNotMatch(compose, /^networks:/m);
  assert.doesNotMatch(compose, /^\s+-\s*traefik-proxy\s*$/m);
});

test("specifies the network bridge-mode Traefik will use via a label, and the connector attaches it at runtime", () => {
  assert.match(compose, /traefik\.docker\.network=traefik-proxy/);
  assert.match(compose, /^ {2}traefik-connect:/m);
  assert.match(compose, /docker network connect traefik-proxy/);
  // The connector finds its target by its own project label — it must work even when the project name isn't deskrpg.
  assert.match(compose, /com\.docker\.compose\.project/);
});

test("the DeskRPG image default is :latest — the docker manager's update just re-pulls the image from the saved compose", () => {
  // Pinning a version means clicking update just re-pulls the same version instead of
  // moving to a new release. To stay on or roll back to a specific version, override with
  // the DESKRPG_IMAGE environment variable.
  assert.match(compose, /image: \$\{DESKRPG_IMAGE:-ghcr\.io\/dandacompany\/deskrpg:latest\}/);
});

test("installs and enables the DeskRPG plugin before hermes — without it, gateway connection can't get past the profile list", () => {
  assert.match(compose, /^ {2}hermes-plugins:/m);
  assert.match(compose, /hermes plugins install/);
  assert.match(compose, /hermes plugins enable deskrpg/);
  // Calling install again on an already-installed plugin exits 1 — must branch to update based on install state.
  assert.match(compose, /hermes plugins update deskrpg/);
  assert.match(compose, /hermes-plugins:\s*\n\s*condition: service_completed_successfully/);
});

test("the plugin-install service receives the same API_SERVER_KEY as hermes — otherwise the image generates its own key into the volume .env, which overwrites the user's key and DeskRPG gets 401", () => {
  const block = compose.slice(compose.indexOf("  hermes-plugins:"), compose.indexOf("\n  hermes:"));
  assert.match(block, /API_SERVER_KEY: \$\{HERMES_API_KEY:-change-this-hermes-api-key\}/);
  assert.match(block, /HERMES_UID: \$\{HERMES_UID:-10000\}/);
});

test("the plugin step writes non-empty provider keys into /opt/data/.env — Hermes ignores a key passed only as env and answers Provider authentication failed", () => {
  const block = compose.slice(compose.indexOf("  hermes-plugins:"), compose.indexOf("\n  hermes:"));
  for (const key of ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {
    assert.match(
      block,
      new RegExp(`${key}: \\$\\{${key}:-\\}`),
      `${key} is not passed to hermes-plugins`,
    );
  }
  assert.match(block, /touch \/opt\/data\/\.env/);
  assert.match(block, /for v in OPENROUTER_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY; do/);
  // Only non-empty values are written: an empty variable must not erase a key set in the dashboard.
  assert.match(block, /\[ -n "\$\$val" \] \|\| continue/);
  // Upsert: drop the old line for that key, then append the new one.
  assert.match(block, /grep -v "\^\$\$v=" \/opt\/data\/\.env/);
  // The keys are written before the plugin install, whose `set -e` would otherwise stop first.
  assert.ok(block.indexOf("/opt/data/.env") < block.indexOf("hermes plugins"));
});

test("the Hermes dashboard turns on only when a password is set — empty and the auth gate blocks it, so s6 keeps restarting", () => {
  assert.match(compose, /HERMES_DASHBOARD: \$\{HERMES_DASHBOARD_PASSWORD:\+true\}/);
  assert.match(compose, /HERMES_DASHBOARD_BASIC_AUTH_PASSWORD: \$\{HERMES_DASHBOARD_PASSWORD:-\}/);
  assert.match(compose, /loadbalancer\.server\.port=9119/);
});

test("the connector attaches both deskrpg and hermes to traefik-proxy", () => {
  assert.match(compose, /for service in deskrpg hermes/);
});

test(".env.example pre-populates every field the Hostinger environment panel needs — so the user never has to add one with '+ Environment'", () => {
  const env = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
  const keys = env
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split("=")[0]);
  // Hostinger does not fill in TRAEFIK_HOST (observed 2026-09-17) — without a field for it, an extra step is needed.
  // The order matches the tutorial 2-2 screenshot.
  assert.deepEqual(keys, [
    "JWT_SECRET",
    "HERMES_API_KEY",
    "OPENROUTER_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "TRAEFIK_HOST",
    "DESKRPG_IMAGE",
    "HERMES_DASHBOARD_PASSWORD",
  ]);
  // The image field is pre-filled with the same value as the compose default — it can be empty, but filling it removes any guesswork about what to put there.
  assert.match(env, /^DESKRPG_IMAGE=ghcr\.io\/dandacompany\/deskrpg:latest$/m);
});

test(".env.example has no comment lines — Hostinger copies it verbatim and reads `# FOO` as a variable name", () => {
  const env = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
  assert.deepEqual(
    env.split(/\r?\n/).filter((l) => l.trim().startsWith("#")),
    [],
  );
});
