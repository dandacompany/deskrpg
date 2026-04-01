import assert from "node:assert/strict";
import test from "node:test";

import { buildSpeechBubblePreview } from "./speech-preview";

test("speech bubble preview keeps only the latest short text", () => {
  assert.equal(buildSpeechBubblePreview("짧은 한 줄"), "짧은 한 줄");
  assert.equal(
    buildSpeechBubblePreview("이 문장은 회의 자리 위 말풍선에 전부 올라가기에는 너무 길다"),
    "...에 전부 올라가기에는 너무 길다",
  );
});
