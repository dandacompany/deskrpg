import assert from "node:assert/strict";
import test from "node:test";

import { roomMessagePreview } from "./room-message-preview";

const t = (key: string) => `<${key}>`;
const base = { senderName: "소피", createdAt: "2026-09-24T00:00:00Z" };

test("an empty cron result previews as failed or no result", () => {
  assert.equal(
    roomMessagePreview(
      { ...base, content: "", notice: { kind: "cron_result", status: "error" } },
      t,
    ),
    "<room.cronResult.failed>",
  );
  assert.equal(
    roomMessagePreview(
      { ...base, content: "  ", notice: { kind: "cron_result", status: "ok" } },
      t,
    ),
    "<room.cronResult.empty>",
  );
});

test("a stored body is shown as it is — old Korean rows and ordinary messages", () => {
  assert.equal(
    roomMessagePreview(
      { ...base, content: "실행 실패", notice: { kind: "cron_result", status: "error" } },
      t,
    ),
    "실행 실패",
  );
  assert.equal(roomMessagePreview({ ...base, content: "hi", notice: null }, t), "hi");
  assert.equal(roomMessagePreview({ ...base, content: "hi" }, t), "hi");
  assert.equal(roomMessagePreview({ ...base, content: "", notice: null }, t), "");
});

// Measured on staging: the room list showed "🔔 **[r5 검증] 물 한 잔 마시기**" — the chat itself renders
// that as bold text, so the one-line preview shows the words without the markdown marks.
test("the preview drops markdown marks and keeps the words on one line", () => {
  const preview = (content: string) => roomMessagePreview({ ...base, content }, t);
  assert.equal(preview("🔔 **[r5 검증] 물 한 잔 마시기**"), "🔔 [r5 검증] 물 한 잔 마시기");
  assert.equal(
    preview("# 보고\n- __첫째__ 일\n- `code` 와 [링크](https://x.io)"),
    "보고 첫째 일 code 와 링크",
  );
  assert.equal(preview("2 * 3 = 6, a_b_c"), "2 * 3 = 6, a_b_c", "lone marks are ordinary text");
});
