import assert from "node:assert/strict";
import test from "node:test";

import { sortHubResults } from "./hub-results";

const r = (identifier: string, trustLevel: string) => ({
  identifier,
  name: "pdf",
  description: "",
  source: "x",
  trustLevel,
});

test("orders by trust level (builtin > trusted > community > other), same level keeps server order", () => {
  const input = [
    r("c1", "community"),
    r("t1", "trusted"),
    r("u1", "unknown"),
    r("c2", "community"),
    r("b1", "builtin"),
    r("t2", "trusted"),
  ];
  assert.deepEqual(
    sortHubResults(input).map((x) => x.identifier),
    ["b1", "t1", "t2", "c1", "c2", "u1"],
  );
  assert.equal(input[0].identifier, "c1");
});
