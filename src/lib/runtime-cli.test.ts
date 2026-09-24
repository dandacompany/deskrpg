import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cliPath = path.join(repoRoot, "bin", "deskrpg.js");

function createInstalledCliFixture() {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deskrpg-installed-cli-"));
  const packageRoot = path.join(fixtureRoot, "node_modules", "deskrpg");
  const fixtureBinDir = path.join(packageRoot, "bin");
  const fixtureLibDir = path.join(packageRoot, "src", "lib");
  fs.mkdirSync(fixtureBinDir, { recursive: true });
  fs.mkdirSync(fixtureLibDir, { recursive: true });

  fs.copyFileSync(cliPath, path.join(fixtureBinDir, "deskrpg.js"));
  fs.copyFileSync(
    path.join(repoRoot, "src", "lib", "runtime-paths.ts"),
    path.join(fixtureLibDir, "runtime-paths.ts"),
  );

  const runtimePathsJs = path.join(repoRoot, "src", "lib", "runtime-paths.js");
  if (fs.existsSync(runtimePathsJs)) {
    fs.copyFileSync(runtimePathsJs, path.join(fixtureLibDir, "runtime-paths.js"));
  }

  return path.join(fixtureBinDir, "deskrpg.js");
}

test("deskrpg doctor reports that init has not been run", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "deskrpg-cli-home-"));
  const result = spawnSync(process.execPath, [cliPath, "doctor"], {
    env: {
      ...process.env,
      DESKRPG_HOME: homeDir,
      DESKRPG_SKIP_BUILD_CHECK: "1",
    },
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Run "deskrpg init" first/);
});

test("deskrpg init creates the runtime home and prints the next step", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "deskrpg-cli-home-"));
  const envExamplePath = path.join(homeDir, ".env.example");
  fs.writeFileSync(envExamplePath, "JWT_SECRET=\n");

  const result = spawnSync(process.execPath, [cliPath, "init"], {
    env: {
      ...process.env,
      DESKRPG_HOME: homeDir,
      DESKRPG_ENV_EXAMPLE_PATH: envExamplePath,
      DESKRPG_SKIP_DB_PUSH: "1",
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.equal(fs.existsSync(path.join(homeDir, ".env.local")), true);
  assert.equal(fs.existsSync(path.join(homeDir, "data")), true);
  assert.equal(fs.existsSync(path.join(homeDir, "uploads")), true);
  assert.equal(fs.existsSync(path.join(homeDir, "logs")), true);
  assert.match(result.stdout, /deskrpg start/);
});

test("deskrpg init works from an installed node_modules path", () => {
  const installedCliPath = createInstalledCliFixture();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "deskrpg-cli-home-"));
  const envExamplePath = path.join(homeDir, ".env.example");
  fs.writeFileSync(envExamplePath, "JWT_SECRET=\n");

  const result = spawnSync(process.execPath, [installedCliPath, "init"], {
    env: {
      ...process.env,
      DESKRPG_HOME: homeDir,
      DESKRPG_ENV_EXAMPLE_PATH: envExamplePath,
      DESKRPG_SKIP_DB_PUSH: "1",
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(homeDir, ".env.local")), true);
  assert.match(result.stdout, /DeskRPG home ready/);
});

for (const dbType of [undefined, "", "sqlite", "postgresql"]) {
  test(`installed deskrpg start selects DB with DATABASE_URL and DB_TYPE=${String(dbType)}`, () => {
    const installedCliPath = createInstalledCliFixture();
    const packageRoot = path.dirname(path.dirname(installedCliPath));
    const fixtureRoot = path.dirname(path.dirname(packageRoot));
    const homeDir = path.join(fixtureRoot, "home");
    fs.mkdirSync(homeDir);
    fs.writeFileSync(path.join(homeDir, ".env.local"), "DB_TYPE=sqlite\nSQLITE_PATH=/saved.db\n");
    for (const name of ["runtime-env-bootstrap.js", "startup-check.js", "cli-messages.js"]) {
      fs.copyFileSync(
        path.join(repoRoot, "src/lib", name),
        path.join(packageRoot, "src/lib", name),
      );
    }
    // Only the server boundary and loader are fixtures; execute the installed CLI and real bootstrap.
    const loaderDir = path.join(fixtureRoot, "node_modules", "tsx");
    fs.mkdirSync(loaderDir);
    fs.writeFileSync(path.join(loaderDir, "index.js"), "");
    fs.writeFileSync(
      path.join(packageRoot, "server.js"),
      `require('./src/lib/runtime-env-bootstrap.js').bootstrapRuntimeEnv({ packageRoot: __dirname });
       const { inspectEnvironment } = require('./src/lib/startup-check.js');
       console.log('DB(' + inspectEnvironment(process.env).dbTarget + ')');`,
    );
    try {
      const result = spawnSync(process.execPath, [installedCliPath, "start"], {
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "test",
          DESKRPG_HOME: homeDir,
          DATABASE_URL: "postgresql://localhost/test",
          ...(dbType === undefined ? {} : { DB_TYPE: dbType }),
        },
        encoding: "utf8",
        timeout: 10000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, dbType === "sqlite" ? /DB\(sqlite\)/ : /DB\(postgresql\)/);
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
}
