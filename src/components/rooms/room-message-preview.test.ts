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
