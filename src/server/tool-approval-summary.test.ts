import test from "node:test";
import assert from "node:assert/strict";

import type { PendingApproval } from "./tool-approvals";
import {
  buildApprovalSummaryPrompt,
  createApprovalSummarizer,
  mcpApprovalNames,
  redactApprovalSummary,
} from "./tool-approval-summary";

const COMMAND =
  "curl -H 'Authorization: Bearer sk-live-abcdef0123456789abcdef' https://internal.example/api/v1/export";

const req = (patch: Partial<PendingApproval> = {}): PendingApproval => ({
  key: "run_1:req_1",
  runId: "run_1",
  requestId: "req_1",
  npcId: "npc-sophie",
  channelId: "ch-1",
  context: "meeting",
  kind: "command",
  patternKey: "network egress",
  command: COMMAND,
  description: "Command sends data to an external host",
  choices: ["once", "deny"],
  expiresAt: 0,
  approverUserId: "user-dante",
  approverName: "Dante",
  ...patch,
});

test("redaction removes any stretch of the command and anything shaped like a secret", () => {
  const leaked = `소피가 ${COMMAND.slice(0, 40)} 를 실행하려고 합니다. 키 sk-live-abcdef0123456789abcdef 와 ghp_ABCDEFGHIJKLMNOPQRSTUVWX1234 사용.`;
  const out = redactApprovalSummary(leaked, COMMAND);
  assert.ok(out);
  assert.equal(out.includes("curl -H"), false);
  assert.equal(out.includes("sk-live"), false);
  assert.equal(out.includes("ghp_"), false);
  assert.ok(out.startsWith("소피가"));
});

test("redaction drops code spans, URLs and extra lines, and caps the length", () => {
  const out = redactApprovalSummary(
    "Sophie wants to run `rm -rf /srv/data` against https://files.example/x.\nSecond line.",
    "rm -rf /srv/data",
  );
  assert.ok(out);
  assert.equal(out.includes("rm -rf"), false);
  assert.equal(out.includes("https://"), false);
  assert.equal(out.includes("Second line"), false);
  const long = redactApprovalSummary("a ".repeat(400), "x");
  assert.ok(long && long.length <= 200);
});

test("nothing left after redaction is no summary", () => {
  assert.equal(redactApprovalSummary(`\`${COMMAND}\``, COMMAND), null);
  assert.equal(redactApprovalSummary("   ", COMMAND), null);
});

test("the prompt asks for the approver's language and never for the command to be quoted", () => {
  const { instructions, prompt } = buildApprovalSummaryPrompt(req(), "ja");
  assert.match(instructions, /Japanese/);
  assert.match(instructions, /Do not quote/);
  assert.match(instructions, /Do not call any tools/);
  assert.ok(prompt.includes("Command sends data to an external host"));
});

test("the summarizer runs as the NPC in the approver's language and redacts the reply", async () => {
  const runs: { npcId: string; instructions: string }[] = [];
  const summarize = createApprovalSummarizer({
    localeOf: () => "ko",
    run: async (npcId, input) => {
      runs.push({ npcId, instructions: input.instructions });
      return `외부 서버로 데이터를 보내려 합니다: ${COMMAND}`;
    },
  });
  const text = await summarize(req());
  assert.equal(runs[0].npcId, "npc-sophie");
  assert.match(runs[0].instructions, /Korean/);
  assert.ok(text?.startsWith("외부 서버로 데이터를 보내려 합니다"));
  assert.equal(text?.includes("curl"), false);
});

test("a summary that takes too long or fails gives none, and the run is stopped", async () => {
  let aborted = false;
  const slow = createApprovalSummarizer({
    localeOf: () => "en",
    timeoutMs: 20,
    run: (_npc, input) =>
      new Promise((resolve) => {
        input.signal.addEventListener("abort", () => {
          aborted = true;
        });
        setTimeout(() => resolve("too late"), 200);
      }),
  });
  assert.equal(await slow(req()), null);
  assert.equal(aborted, true);

  const broken = createApprovalSummarizer({
    localeOf: () => "en",
    run: async () => {
      throw new Error("gateway down");
    },
  });
  assert.equal(await broken(req()), null);
});

const MCP_COMMAND =
  "MCP tool 'write_note' on UNTRUSTED server 'deskrpg-probe' wants to run. This tool is write-capable (no readOnlyHint=true annotation) and may modify external state.";

test("an MCP request's server and tool names are read from Hermes' text", () => {
  assert.deepEqual(mcpApprovalNames(MCP_COMMAND), ["write_note", "deskrpg-probe"]);
  assert.deepEqual(mcpApprovalNames("rm -rf /tmp/x"), []);
});

test("an MCP summary keeps the server and tool names but still drops the rest of the command", () => {
  const out = redactApprovalSummary(
    "신뢰되지 않은 deskrpg-probe 서버의 write_note 도구로 메모를 쓰려 합니다 (wants to run. This tool is write-capable).",
    MCP_COMMAND,
    mcpApprovalNames(MCP_COMMAND),
  );
  assert.ok(out);
  assert.ok(out.includes("deskrpg-probe"), out);
  assert.ok(out.includes("write_note"), out);
  assert.equal(out.includes("This tool is write-capable"), false);
});

test("a server name shaped like a secret is never let through", () => {
  const key = "sk-live-abcdef0123456789abcdef";
  const command = `MCP tool 'write_note' on UNTRUSTED server '${key}' wants to run.`;
  const names = mcpApprovalNames(command);
  const out = redactApprovalSummary(`${key} 서버의 write_note 도구를 실행합니다.`, command, names);
  assert.ok(out);
  assert.equal(out.includes("sk-live"), false);
  assert.ok(out.includes("write_note"));
  const token = "A".repeat(40);
  const long = `MCP tool 'x' on UNTRUSTED server '${token}' wants to run.`;
  const out2 = redactApprovalSummary(`${token} 서버에 씁니다.`, long, mcpApprovalNames(long));
  assert.equal(out2?.includes(token), false);
});

test("the summarizer lets MCP names through only for MCP requests", async () => {
  const reply = "deskrpg-probe 서버의 write_note 도구로 메모를 저장합니다.";
  const summarize = createApprovalSummarizer({ localeOf: () => "ko", run: async () => reply });
  assert.equal(await summarize(req({ kind: "mcp", command: MCP_COMMAND })), reply);
  const asCommand = await summarize(req({ kind: "command", command: MCP_COMMAND }));
  assert.equal(asCommand?.includes("deskrpg-probe"), false);
});
