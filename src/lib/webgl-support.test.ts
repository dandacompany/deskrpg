import assert from "node:assert/strict";
import test from "node:test";

import { detectWebglSupport, type WebglProbeDocument } from "./webgl-support";

function docWith(getContext: (contextId: string) => unknown): WebglProbeDocument {
  return { createElement: () => ({ getContext }) };
}

test("treated as supported when a webgl2 context comes back", () => {
  const asked: string[] = [];
  const supported = detectWebglSupport(
    docWith((contextId) => {
      asked.push(contextId);
      return {};
    }),
  );
  assert.equal(supported, true);
  assert.deepEqual(asked, ["webgl2"]);
});

test("treated as supported when webgl exists even without webgl2", () => {
  const supported = detectWebglSupport(docWith((contextId) => (contextId === "webgl" ? {} : null)));
  assert.equal(supported, true);
});

test("unsupported when every context is null", () => {
  assert.equal(detectWebglSupport(docWith(() => null)), false);
});

test("falls back to unsupported even if getContext throws", () => {
  assert.equal(
    detectWebglSupport(
      docWith(() => {
        throw new Error("context creation failed");
      }),
    ),
    false,
  );
});

test("falls back to unsupported even if createElement throws", () => {
  const doc = {
    createElement() {
      throw new Error("no document");
    },
  } as unknown as WebglProbeDocument;
  assert.equal(detectWebglSupport(doc), false);
});

test("unsupported when there's no document (server rendering)", () => {
  assert.equal(detectWebglSupport(null), false);
  assert.equal(detectWebglSupport(undefined), false);
});
