import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("ensureDeskRpgHome creates env, data, uploads, and logs directories", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "deskrpg-home-"));
  const envExamplePath = path.join(homeDir, ".env.example");
  fs.writeFileSync(envExamplePath, "JWT_SECRET=\n");
  process.env.DESKRPG_HOME = homeDir;

  const runtimePaths = await import("./runtime-paths.ts");

  runtimePaths.ensureDeskRpgHome({
    homeDir,
    envExamplePath,
  });

  assert.equal(fs.existsSync(path.join(homeDir, ".env.local")), true);
  assert.equal(fs.existsSync(path.join(homeDir, "data")), true);
  assert.equal(fs.existsSync(path.join(homeDir, "uploads")), true);
  assert.equal(fs.existsSync(path.join(homeDir, "logs")), true);

  const envText = fs.readFileSync(path.join(homeDir, ".env.local"), "utf8");
  assert.match(envText, /DB_TYPE=sqlite/);
  assert.match(envText, /SQLITE_PATH=/);
});
