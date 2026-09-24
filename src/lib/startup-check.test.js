import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import startupCheck from "./startup-check.js";

const { checkDatabaseReachable, inspectEnvironment, hostSetupHint } = startupCheck;

/** Fill in everything except the variable this test cares about — so unrelated warnings don't leak in. */
function baseEnv(overrides = {}) {
  return {
    JWT_SECRET: "x".repeat(32),
    INTERNAL_RPC_SECRET: "y".repeat(32),
    ...overrides,
  };
}

test("an empty JWT_SECRET in production is a startup-blocking error", () => {
  const result = inspectEnvironment(baseEnv({ NODE_ENV: "production", JWT_SECRET: "" }));
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /JWT_SECRET/);
});

test("an empty JWT_SECRET in development mode is only a warning", () => {
  const result = inspectEnvironment(baseEnv({ NODE_ENV: "development", JWT_SECRET: "" }));
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.some((line) => line.includes("JWT_SECRET")));
});

test("DB_TYPE=postgresql with no DATABASE_URL is an error", () => {
  const result = inspectEnvironment(baseEnv({ DB_TYPE: "postgresql" }));
  assert.equal(result.dbTarget, "postgresql");
  assert.ok(result.errors.some((line) => line.includes("DATABASE_URL")));
});

test("the DB_TYPE=postgres spelling is caught with the same error", () => {
  const result = inspectEnvironment(baseEnv({ DB_TYPE: "POSTGRES" }));
  assert.equal(result.dbTarget, "postgresql");
  assert.equal(result.errors.length, 1);
});

test("with neither DATABASE_URL nor DB_TYPE, the fallback to SQLite is surfaced as a warning", () => {
  const result = inspectEnvironment(baseEnv());
  assert.deepEqual(result.errors, []);
  assert.equal(result.dbTarget, "sqlite");
  assert.ok(result.warnings.some((line) => line.includes("SQLite")));
});

test("DATABASE_URL alone targets PostgreSQL with no warnings", () => {
  const result = inspectEnvironment(
    baseEnv({ DATABASE_URL: "postgresql://user:pw@localhost:5432/deskrpg" }),
  );
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.dbTarget, "postgresql");
});

test("explicitly setting DB_TYPE=sqlite suppresses the silent-fallback warning", () => {
  const result = inspectEnvironment(baseEnv({ DB_TYPE: "sqlite" }));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.dbTarget, "sqlite");
});

test("warns when INTERNAL_RPC_SECRET is missing and falls back to JWT_SECRET", () => {
  const result = inspectEnvironment(baseEnv({ INTERNAL_RPC_SECRET: "" }));
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.some((line) => line.includes("INTERNAL_RPC_SECRET")));
});

test("the warning text never includes the secret value itself, only its length", () => {
  const secret = "supersecretvalue-do-not-print";
  const result = inspectEnvironment({ JWT_SECRET: secret });
  const joined = [...result.errors, ...result.warnings].join("\n");
  assert.ok(!joined.includes(secret));
  assert.ok(joined.includes(`${secret.length}자`));
});

test("warns that internal RPC is fully rejected when both secrets are empty", () => {
  const result = inspectEnvironment({ NODE_ENV: "development" });
  assert.ok(result.warnings.some((line) => line.includes("403")));
});

test("a whitespace-only value is treated as empty", () => {
  const result = inspectEnvironment({ NODE_ENV: "production", JWT_SECRET: "   " });
  assert.ok(result.errors.some((line) => line.includes("JWT_SECRET")));
});

test("the DB reachability check returns a result object rather than throwing, even on failure", async () => {
  const result = await checkDatabaseReachable({ sqlitePath: "/definitely/missing/dir/deskrpg.db" });
  assert.equal(result.ok, false);
  assert.equal(result.target, "sqlite");
  assert.ok(result.message.length > 0);
});

test("passes if the parent directory is writable, even when the SQLite file does not exist", async () => {
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const result = await checkDatabaseReachable({
    sqlitePath: join(tmpdir(), `deskrpg-startup-check-${process.pid}.db`),
  });
  assert.equal(result.ok, true);
});

test("an SQLite runtime probes SQLite even when a leftover legacy DATABASE_URL remains", async () => {
  // `deskrpg init` copies `.env.example`, so a stray PostgreSQL URL line remains even in an
  // SQLite home. Deciding the target by URL presence would show a perfectly fine SQLite
  // user "PostgreSQL connection failed" (observed).
  const result = await checkDatabaseReachable({
    databaseUrl: "postgresql://nobody@127.0.0.1:1/none",
    sqlitePath: path.join(os.tmpdir(), "deskrpg-startup-check-probe.db"),
    target: "sqlite",
  });
  assert.equal(result.target, "sqlite");
  assert.equal(result.ok, true);
});

test("with a PostgreSQL target and no URL, reports failure without probing", async () => {
  const result = await checkDatabaseReachable({ target: "postgresql" });
  assert.equal(result.ok, false);
  assert.equal(result.target, "postgresql");
  assert.match(result.message, /DATABASE_URL/);
});

test("when Hermes is missing, says the connection wizard can install it (on by default)", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "deskrpg-hint-"));
  assert.match(String(startupCheck.hostSetupHint({ PATH: "" }, home)), /로컬 연결에서 설치/);
});

test("when the operator has turned the switch off, tells them the command to turn it on", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "deskrpg-hint-"));
  for (const env of [
    { DESKRPG_HOST_SETUP_ENABLED: "0" },
    { DESKRPG_HERMES_INSTALL_ENABLED: "off" },
  ]) {
    assert.match(
      String(startupCheck.hostSetupHint({ ...env, PATH: "" }, home)),
      /host-setup on --with-install/,
    );
  }
});

test("is silent when Hermes is already present", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "deskrpg-hint-"));
  fs.mkdirSync(path.join(home, ".hermes", "hermes-agent"), { recursive: true });
  assert.equal(startupCheck.hostSetupHint({}, home), null);
});

test("a bundled image with HERMES_HOME set does not show the Hermes install hint", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-home-"));
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "user-home-"));
  try {
    assert.equal(hostSetupHint({ HERMES_HOME: dir, PATH: "" }, emptyHome), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(emptyHome, { recursive: true, force: true });
  }
});

test("does not show the install hint when hermes is on PATH", () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-bin-"));
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "user-home-"));
  fs.writeFileSync(path.join(binDir, "hermes"), "#!/bin/sh\n");
  try {
    assert.equal(hostSetupHint({ PATH: binDir }, emptyHome), null);
  } finally {
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(emptyHome, { recursive: true, force: true });
  }
});

test("shows the install hint when Hermes is found nowhere", () => {
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "user-home-"));
  const missing = path.join(emptyHome, "nope");
  try {
    const hint = hostSetupHint({ HERMES_HOME: missing, PATH: missing }, emptyHome);
    assert.match(String(hint), /Hermes 가 없습니다/);
  } finally {
    fs.rmSync(emptyHome, { recursive: true, force: true });
  }
});

test("a placeholder JWT_SECRET blocks startup in production", () => {
  const result = inspectEnvironment(
    baseEnv({ NODE_ENV: "production", JWT_SECRET: "change-me-to-a-random-64-char-string" }),
  );
  assert.ok(
    result.errors.some((line) => line.includes("자리표시자")),
    `errors: ${JSON.stringify(result.errors)}`,
  );
});
