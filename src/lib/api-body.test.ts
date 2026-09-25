import assert from "node:assert/strict";
import test from "node:test";

import { invalidJsonBody, readJsonObject } from "./api-body";

const post = (body?: string) =>
  new Request("http://localhost/api/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

test("readJsonObject returns the object of a JSON object body", async () => {
  assert.deepEqual(await readJsonObject(post('{"a":1}')), { a: 1 });
});

for (const [name, body] of [
  ["an empty body", undefined],
  ["a non-JSON body", "not json"],
  ["a JSON array", "[1,2]"],
  ["JSON null", "null"],
  ["a JSON string", '"text"'],
] as const) {
  test(`readJsonObject returns null for ${name}`, async () => {
    assert.equal(await readJsonObject(post(body)), null);
  });
}

test("invalidJsonBody is a 400 that does not echo the parser message", async () => {
  const response = invalidJsonBody();
  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.errorCode, "invalid_request_body");
  assert.doesNotMatch(JSON.stringify(payload), /Unexpected|JSON\.parse|position/);
});
