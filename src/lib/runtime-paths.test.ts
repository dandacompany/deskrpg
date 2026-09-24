import assert from "node:assert/strict";
import test from "node:test";

test("runtime paths resolve under DESKRPG_HOME when provided", async () => {
  process.env.DESKRPG_HOME = "/tmp/deskrpg-home";

  const runtimePaths = await import("./runtime-paths");

  assert.equal(runtimePaths.getDeskRpgHomeDir(), "/tmp/deskrpg-home");
  assert.equal(runtimePaths.getDeskRpgEnvPath(), "/tmp/deskrpg-home/.env.local");
  assert.equal(runtimePaths.getDeskRpgDataDir(), "/tmp/deskrpg-home/data");
  assert.equal(runtimePaths.getDeskRpgSqlitePath(), "/tmp/deskrpg-home/data/deskrpg.db");
  assert.equal(runtimePaths.getDeskRpgUploadsDir(), "/tmp/deskrpg-home/uploads");
  assert.equal(runtimePaths.getDeskRpgLogsDir(), "/tmp/deskrpg-home/logs");
});

test("the placeholder JWT_SECRET in `.env.example` is replaced with a random value", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "deskrpg-home-"));
  const example = path.join(home, ".env.example");
  fs.writeFileSync(example, "JWT_SECRET=change-me-to-a-random-64-char-string\n");

  const runtimePaths = await import("./runtime-paths");
  runtimePaths.ensureDeskRpgHome({ homeDir: home, envExamplePath: example });

  const envText = fs.readFileSync(path.join(home, ".env.local"), "utf8");
  const value = /^JWT_SECRET=(.*)$/m.exec(envText)?.[1] ?? "";
  assert.notEqual(value, "change-me-to-a-random-64-char-string");
  assert.equal(value.length, 48, "randomBytes(24).toString('hex') 길이");

  // A second call doesn't touch the real secret already generated.
  runtimePaths.ensureDeskRpgHome({ homeDir: home, envExamplePath: example });
  const again = fs.readFileSync(path.join(home, ".env.local"), "utf8");
  assert.equal(/^JWT_SECRET=(.*)$/m.exec(again)?.[1], value);

  fs.rmSync(home, { recursive: true, force: true });
});

test("the placeholder check catches instructional text and values that are too short", async () => {
  const { isPlaceholderSecret } = await import("./runtime-paths");
  for (const placeholder of [
    "",
    "short",
    "change-me-to-a-random-64-char-string",
    "CHANGE_THIS_SECRET_PLEASE_NOW_OK",
    "your-secret-goes-right-here-ok",
    // Our own compose default. It starts with `deskrpg-`, so it slipped past the prefix check,
    // and at 48 chars it also passed the length check — every untouched Hostinger deployment was
    // signing session tokens with this public key (measured 2026-09-16). Now it's caught
    // wherever it appears, not just as a prefix.
    "deskrpg-change-this-secret-before-inviting-anyone",
    "prod-CHANGE-ME-later-abcdefghijklmnop",
  ]) {
    assert.equal(isPlaceholderSecret(placeholder), true, placeholder);
  }
  assert.equal(isPlaceholderSecret("a".repeat(48)), false);
  // A genuinely random value must pass — the runtime must never overwrite a value the user set directly.
  assert.equal(isPlaceholderSecret("a3f9c1e07b2d48a6f5c1e9d720b4a8c6"), false);
  // A real key starting with `my` must also pass. While `my` was in the prefix list, the runtime
  // treated a value the user set directly as a placeholder and overwrote it.
  assert.equal(isPlaceholderSecret("my-production-key-9f3a2b7c1d4e6f8a"), false);
});
