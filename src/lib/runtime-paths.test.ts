import assert from "node:assert/strict";
import test from "node:test";

test("runtime paths resolve under DESKRPG_HOME when provided", async () => {
  process.env.DESKRPG_HOME = "/tmp/deskrpg-home";

  const runtimePaths = await import("./runtime-paths.ts");

  assert.equal(runtimePaths.getDeskRpgHomeDir(), "/tmp/deskrpg-home");
  assert.equal(runtimePaths.getDeskRpgEnvPath(), "/tmp/deskrpg-home/.env.local");
  assert.equal(runtimePaths.getDeskRpgDataDir(), "/tmp/deskrpg-home/data");
  assert.equal(runtimePaths.getDeskRpgSqlitePath(), "/tmp/deskrpg-home/data/deskrpg.db");
  assert.equal(runtimePaths.getDeskRpgUploadsDir(), "/tmp/deskrpg-home/uploads");
  assert.equal(runtimePaths.getDeskRpgLogsDir(), "/tmp/deskrpg-home/logs");
});
