import test from "node:test";
import assert from "node:assert/strict";

import { composeNpcInstructions, SECTION } from "./npc-prompt-layers";

// Pins down the contract for layer assembly. Two facts this file guards:
//   1) If there's nothing to send, the field itself isn't created (undefined, not an empty
//      string).
//   2) Each layer sits inside a labeled boundary and doesn't spill into another.

test("undefined when there's no layer to send at all — never sends an empty string", () => {
  // Hermes appends instructions after the existing system prompt. Sending an empty string
  // would leave two meaningless newlines in the prompt. It's correct to not create the
  // field at all.
  assert.equal(composeNpcInstructions({}), undefined);
  assert.equal(composeNpcInstructions({ meetingProtocol: "   " }), undefined);
});

test("only that layer is included when there's only a meeting rule", () => {
  const out = composeNpcInstructions({ meetingProtocol: "한 번에 한 명씩 말한다" });
  assert.ok(out);
  assert.match(out, new RegExp(`<${SECTION.meeting}>`));
  assert.match(out, /한 번에 한 명씩 말한다/);
});

test("each layer is closed by its label boundary", () => {
  const out = composeNpcInstructions({ meetingProtocol: "MEET" })!;
  for (const name of [SECTION.meeting]) {
    assert.match(out, new RegExp(`<${name}>[\\s\\S]*</${name}>`));
  }
});

test("the body is preserved as-is — only leading/trailing whitespace is trimmed", () => {
  const body = "줄1\n\n줄2  ";
  const out = composeNpcInstructions({ meetingProtocol: body })!;
  assert.match(out, /줄1\n\n줄2/);
});

test("identity is never sent — SOUL.md is the sole owner", () => {
  // Identity can't be changed from beyond the gateway (instructions only gets appended
  // after SOUL.md). If two identities coexisted the result would be unstable, so it's not
  // sent at all until it can be sent properly.
  // Breaking this contract requires deleting this test first.
  const out = composeNpcInstructions({
    meetingProtocol: "MEET",
    // @ts-expect-error — identity isn't in the input type. The type already blocks this.
    identity: "나는 소피다",
  })!;
  assert.doesNotMatch(out, /나는 소피다/);
});
