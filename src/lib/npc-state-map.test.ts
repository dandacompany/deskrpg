import assert from "node:assert/strict";
import test from "node:test";

import { npcStates, primaryNpcState, type NpcStateInput } from "./npc-state-map";

const idle: NpcStateInput = {
  connection: "ok",
  approvals: 0,
  failedCards: 0,
  responseFailed: false,
  responding: false,
  workingCount: 0,
  reporting: false,
};

test("an idle employee on a reachable gateway has no state to show", () => {
  assert.deepEqual(npcStates(idle), []);
  assert.equal(primaryNpcState(idle), null);
});

test("every overlapping state is listed, most urgent first", () => {
  const states = npcStates({
    ...idle,
    approvals: 1,
    failedCards: 2,
    responseFailed: true,
    responding: true,
    workingCount: 3,
    reporting: true,
  });
  assert.deepEqual(states, [
    "awaiting_approval",
    "stopped_after_failures",
    "response_failed",
    "responding",
    "working",
    "reporting",
  ]);
});

test("waiting on a person outranks being busy on the name tag", () => {
  assert.equal(primaryNpcState({ ...idle, workingCount: 2, approvals: 1 }), "awaiting_approval");
  assert.equal(
    primaryNpcState({ ...idle, responding: true, failedCards: 1 }),
    "stopped_after_failures",
  );
});

test("when the gateway can't be seen, live states are dropped but what waits on a person stays", () => {
  for (const connection of ["unreachable", "unauthorized", "unknown", "socket_down"] as const) {
    assert.deepEqual(
      npcStates({
        ...idle,
        connection,
        workingCount: 2,
        responding: true,
        reporting: true,
        approvals: 1,
      }),
      ["unknown", "awaiting_approval"],
      connection,
    );
  }
});

test("before the first gateway verdict nothing is claimed unknown", () => {
  assert.deepEqual(npcStates({ ...idle, connection: null, workingCount: 1 }), ["working"]);
});
