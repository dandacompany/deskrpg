import assert from "node:assert/strict";
import test from "node:test";

import { meetingErrorDisplay } from "./meeting-error-display";

const KEYS: Record<string, string> = {
  "meeting.reason.forbidden": "회의에 접근할 권한이 없습니다.",
  "meeting.reason.unknown": "알 수 없는 오류입니다. 다시 시도하세요.",
};
const t = (key: string) => KEYS[key] ?? key;

test("a known reason code is translated", () => {
  assert.equal(meetingErrorDisplay("forbidden", t), "회의에 접근할 권한이 없습니다.");
});

test("an unknown reason code shows the generic reason, never the raw code", () => {
  assert.equal(meetingErrorDisplay("not_member", t), "알 수 없는 오류입니다. 다시 시도하세요.");
  assert.equal(meetingErrorDisplay("gatewayGone", t), "알 수 없는 오류입니다. 다시 시도하세요.");
});

test("an already translated message is shown as it is", () => {
  assert.equal(
    meetingErrorDisplay("회의실로 돌아온 뒤 다시 시도하세요.", t),
    "회의실로 돌아온 뒤 다시 시도하세요.",
  );
  assert.equal(
    meetingErrorDisplay("Could not reach the NPC service.", t),
    "Could not reach the NPC service.",
  );
});
