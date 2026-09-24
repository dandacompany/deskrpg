import assert from "node:assert/strict";
import test from "node:test";

import { isUniqueViolation } from "./db-unique-violation";

test("recognizes a unique violation from both pg and sqlite", () => {
  assert.equal(isUniqueViolation({ code: "23505" }), true);
  assert.equal(isUniqueViolation({ code: "SQLITE_CONSTRAINT_UNIQUE" }), true);
  assert.equal(isUniqueViolation({ code: "SQLITE_CONSTRAINT_PRIMARYKEY" }), true);
});

test("doesn't let other errors through", () => {
  assert.equal(isUniqueViolation({ code: "23503" }), false);
  assert.equal(isUniqueViolation(new Error("boom")), false);
  assert.equal(isUniqueViolation(null), false);
  assert.equal(isUniqueViolation("23505"), false);
});
