/**
 * Phase 2A Integration Tests — workspace and subprocess helpers
 *
 * The CLI adapters (claude/codex/gemini/opencode) are gone; what remains here covers the helpers
 * the provider CLI login route still uses:
 * 1. WorkspaceManager creates the right persona file per adapter type
 * 2. SubprocessPool executes real subprocesses
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";

import { WorkspaceManager } from "./workspace-manager";
import { SubprocessPool } from "./subprocess-pool";

// ---------------------------------------------------------------------------
// 1. WorkspaceManager persona files per adapter
// ---------------------------------------------------------------------------

describe("Phase2A: WorkspaceManager persona per adapter", () => {
  let tmpDir: string;

  test("creates CLAUDE.md for claude adapter", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "deskrpg-test-"));
    const wm = new WorkspaceManager();

    await wm.writePersonaFiles(
      tmpDir,
      "claude",
      { identity: "You are a developer", soul: "Be helpful" },
      "en",
    );

    const content = await fs.readFile(path.join(tmpDir, "CLAUDE.md"), "utf-8");
    assert.ok(content.includes("You are a developer"));
    assert.ok(content.includes("Be helpful"));
    await fs.rm(tmpDir, { recursive: true });
  });

  test("creates AGENTS.md for codex adapter", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "deskrpg-test-"));
    const wm = new WorkspaceManager();

    await wm.writePersonaFiles(
      tmpDir,
      "codex",
      { identity: "You are a coder", soul: "Be precise" },
      "en",
    );

    const content = await fs.readFile(path.join(tmpDir, "AGENTS.md"), "utf-8");
    assert.ok(content.includes("You are a coder"));
    await fs.rm(tmpDir, { recursive: true });
  });

  test("creates GEMINI.md for gemini adapter", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "deskrpg-test-"));
    const wm = new WorkspaceManager();

    await wm.writePersonaFiles(
      tmpDir,
      "gemini",
      { identity: "You are an analyst", soul: "Be thorough" },
      "en",
    );

    const content = await fs.readFile(path.join(tmpDir, "GEMINI.md"), "utf-8");
    assert.ok(content.includes("You are an analyst"));
    await fs.rm(tmpDir, { recursive: true });
  });

  test("no-op for openclaw adapter", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "deskrpg-test-"));
    const wm = new WorkspaceManager();

    await wm.writePersonaFiles(tmpDir, "openclaw", { identity: "test", soul: "test" }, "en");

    const files = await fs.readdir(tmpDir);
    assert.equal(files.length, 0, "openclaw should not create any files");
    await fs.rm(tmpDir, { recursive: true });
  });

  test("all adapter persona files can coexist in same directory", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "deskrpg-test-"));
    const wm = new WorkspaceManager();

    await wm.writePersonaFiles(tmpDir, "claude", { identity: "Claude persona", soul: "s" }, "en");
    await wm.writePersonaFiles(tmpDir, "codex", { identity: "Codex persona", soul: "s" }, "en");
    await wm.writePersonaFiles(tmpDir, "gemini", { identity: "Gemini persona", soul: "s" }, "en");

    const files = (await fs.readdir(tmpDir)).sort();
    assert.deepEqual(files, ["AGENTS.md", "CLAUDE.md", "GEMINI.md"]);

    // Each file has its own content
    const claude = await fs.readFile(path.join(tmpDir, "CLAUDE.md"), "utf-8");
    const agents = await fs.readFile(path.join(tmpDir, "AGENTS.md"), "utf-8");
    const gemini = await fs.readFile(path.join(tmpDir, "GEMINI.md"), "utf-8");
    assert.ok(claude.includes("Claude persona"));
    assert.ok(agents.includes("Codex persona"));
    assert.ok(gemini.includes("Gemini persona"));
    await fs.rm(tmpDir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// 2. SubprocessPool real execution
// ---------------------------------------------------------------------------

describe("Phase2A: SubprocessPool real execution", () => {
  test("executes node -e and captures stdout", async () => {
    const pool = new SubprocessPool();
    const result = await pool.execute({
      command: "node",
      args: ["-e", 'process.stdout.write("phase2a-test")'],
      timeoutMs: 5000,
    });
    assert.equal(result.fullOutput, "phase2a-test");
    assert.equal(result.exitCode, 0);
  });

  test("pipes stdin to subprocess", async () => {
    const pool = new SubprocessPool();
    const result = await pool.execute({
      command: "node",
      args: [
        "-e",
        'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write(d.toUpperCase()))',
      ],
      stdin: "hello adapters",
      timeoutMs: 5000,
    });
    assert.equal(result.fullOutput, "HELLO ADAPTERS");
  });

  test("captures streaming onStdout callbacks", async () => {
    const pool = new SubprocessPool();
    const chunks: string[] = [];
    await pool.execute({
      command: "node",
      args: [
        "-e",
        'process.stdout.write("a");setTimeout(()=>process.stdout.write("b"),50);setTimeout(()=>process.stdout.write("c"),100)',
      ],
      onStdout: (chunk) => chunks.push(chunk),
      timeoutMs: 5000,
    });
    assert.ok(chunks.length >= 1, "should receive at least one chunk");
    assert.equal(chunks.join(""), "abc");
  });
});
