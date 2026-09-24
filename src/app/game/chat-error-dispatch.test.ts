import assert from "node:assert/strict";
import test from "node:test";
import { decideChatError } from "./chat-error-dispatch";

test("not_joined → request a rejoin, do not go to the list", () => {
  assert.deepEqual(decideChatError({ roomId: "r1", code: "not_joined" }), {
    toastKey: "game.room.error.not_joined",
    rejoin: true,
    backToList: false,
  });
});

test("not_found and forbidden send you back to the list — that room can no longer be seen", () => {
  for (const code of ["not_found", "forbidden"]) {
    assert.deepEqual(
      decideChatError({ code }),
      { toastKey: `game.room.error.${code}`, rejoin: false, backToList: true },
      code,
    );
  }
});

test("other codes only toast — the screen does not move", () => {
  for (const code of ["not_open", "empty", "cooldown", "invalid"]) {
    assert.deepEqual(
      decideChatError({ code }),
      { toastKey: `game.room.error.${code}`, rejoin: false, backToList: false },
      code,
    );
  }
});

test("unknown codes give a generic failure toast, with neither rejoin nor navigation", () => {
  const generic = { toastKey: "game.channelChatFailed", rejoin: false, backToList: false };
  assert.deepEqual(decideChatError({ code: "weird" }), generic);
  assert.deepEqual(decideChatError(null), generic);
  assert.deepEqual(decideChatError({}), generic);
});
