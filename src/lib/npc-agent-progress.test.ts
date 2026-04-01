import test from "node:test";
import assert from "node:assert/strict";

import { getAgentProgressMeter } from "./npc-agent-progress";

test("getAgentProgressMeter returns connecting presentation", () => {
  assert.deepEqual(getAgentProgressMeter("connecting"), {
    className: "bg-indigo-500 animate-pulse",
    width: "33%",
  });
});

test("getAgentProgressMeter returns done presentation", () => {
  assert.deepEqual(getAgentProgressMeter("done"), {
    className: "bg-green-500",
    width: "100%",
  });
});

test("getAgentProgressMeter returns failed presentation", () => {
  assert.deepEqual(getAgentProgressMeter("failed"), {
    className: "bg-red-500",
    width: "100%",
  });
});
