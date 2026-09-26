import test from "node:test";
import assert from "node:assert/strict";

import { parseApprovalEvent } from "./tool-approval-event";
import { statusForChoice, toolApprovalKey } from "./tool-approval-types";

// Payload measured on staging (spec appendix A), trimmed.
const MEASURED = {
  command: "MCP tool 'write_note' on UNTRUSTED server 'deskrpg-probe' wants to run.",
  description: "Server 'deskrpg-probe' is configured 'trust: untrusted'.",
  pattern_key: "mcp_elicitation",
  pattern_keys: ["mcp_elicitation"],
  request_id: "9848ac96dd7347efafd2c6a0e74389c2",
  run_id: "run_e938",
  message_id: "msg_1",
  choices: ["once", "session", "always", "deny"],
};

test("parses the measured MCP approval and drops always", () => {
  assert.deepEqual(parseApprovalEvent(MEASURED), {
    runId: "run_e938",
    requestId: "9848ac96dd7347efafd2c6a0e74389c2",
    command: MEASURED.command,
    description: MEASURED.description,
    kind: "mcp",
    patternKey: "mcp_elicitation",
    choices: ["once", "session", "deny"],
  });
});

test("a dangerous command without session choice keeps what Hermes offered", () => {
  const parsed = parseApprovalEvent({
    run_id: "r1",
    command: "rm -r /tmp/x",
    pattern_key: "recursive delete",
    choices: ["once", "deny"],
  });
  assert.equal(parsed?.kind, "command");
  assert.equal(parsed?.patternKey, "recursive delete");
  assert.deepEqual(parsed?.choices, ["once", "deny"]);
  assert.equal(parsed?.requestId, null);
});

test("no run id, no card; missing choices fall back to once/deny", () => {
  assert.equal(parseApprovalEvent({ command: "x" }), null);
  assert.deepEqual(parseApprovalEvent({ run_id: "r" })?.choices, ["once", "deny"]);
  assert.deepEqual(parseApprovalEvent({ run_id: "r", choices: ["always"] })?.choices, [
    "once",
    "deny",
  ]);
});

test("long command text is capped", () => {
  assert.equal(parseApprovalEvent({ run_id: "r", command: "x".repeat(900) })?.command.length, 500);
});

test("keys and statuses", () => {
  assert.equal(toolApprovalKey("r1", null), "r1:0");
  assert.equal(toolApprovalKey("r1", "q"), "r1:q");
  assert.equal(statusForChoice("session"), "approved_session");
  assert.equal(statusForChoice("deny"), "denied");
});
