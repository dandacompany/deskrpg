import test from "node:test";
import assert from "node:assert/strict";

import type { PendingApproval } from "./tool-approvals";
import {
  buildApprovalSummaryPrompt,
  createApprovalSummarizer,
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
