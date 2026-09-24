// Non-Korean users get the English instruction templates. A missing locale (a socket or request without the
// language cookie) is `null` and falls back to English, while an omitted argument keeps Korean.
import assert from "node:assert/strict";
import test from "node:test";
import { buildFilePromptSection, extractFileContent } from "./file-extractor";
import { composeNpcInstructions } from "./npc-prompt-layers";
import { formatOpenChatMessage } from "./open-chat-formatter";
import { prefixReportFormat } from "./report-format";
import { appendRequesterLine, prefixUserContext } from "./user-context";

const HANGUL = /[가-힣]/;
const ENGLISH_LOCALES = ["en", "ja", "zh", "fr", null] as const;

test("open-chat script uses the English template and markers outside Korean", () => {
  for (const locale of ENGLISH_LOCALES) {
    const out = formatOpenChatMessage(
      { displayName: "Danbi" },
      [{ displayName: "Haneul", role: "Designer" }],
      [{ sender: "Dante", content: "hi" }],
      "Dante",
      { name: "Dante", bio: "CEO" },
      locale,
    );
    assert.doesNotMatch(out, HANGUL, String(locale));
    for (const marker of [
      "[Conversation partner] Name: Dante · About: CEO",
      "[Colleagues in the same space]",
      "[Report format]",
      "[Recent conversation]",
      "[How to reply]",
    ]) {
      assert.ok(out.includes(marker), `${locale}: ${marker}`);
    }
    // Callers slice the recent block between these two markers — the order must hold in every language.
    assert.ok(out.indexOf("[Recent conversation]") < out.indexOf("[How to reply]"));
  }
});

test("user context, requester line and report format use English outside Korean", () => {
  for (const locale of ENGLISH_LOCALES) {
    assert.equal(
      prefixUserContext("body", { name: "Dante", bio: null }, locale),
      "[Conversation partner] Name: Dante\n\nbody",
    );
    assert.equal(
      appendRequesterLine("body", { name: "Dante", bio: "CEO" }, locale),
      "body\n\nRequested by: Dante — CEO",
    );
    assert.doesNotMatch(prefixReportFormat("body", locale), HANGUL);
  }
});

test("task-registration layer is English outside Korean, and only an omitted locale keeps Korean", () => {
  for (const locale of ENGLISH_LOCALES) {
    const out = composeNpcInstructions({ taskConfirmation: true, locale }) ?? "";
    assert.match(out, /^<task-registration>\n/);
    assert.doesNotMatch(out, HANGUL, String(locale));
  }
  assert.match(composeNpcInstructions({ taskConfirmation: true }) ?? "", HANGUL);
});

test("attachment wording is English outside Korean", async () => {
  const file = {
    name: "a.txt",
    mimeType: "text/plain",
    textContent: "x",
    imageBase64: null,
    truncated: false,
  };
  for (const locale of ENGLISH_LOCALES) {
    assert.equal(buildFilePromptSection([file], locale), "\n\n📎 Attachment: a.txt\n```\nx\n```");
    const unsupported = await extractFileContent(
      Buffer.from("x"),
      "a.bin",
      "application/octet-stream",
      locale,
    );
    assert.equal(unsupported.textContent, "Unsupported file type.");
    const long = await extractFileContent(
      Buffer.from("y".repeat(50_001)),
      "a.txt",
      "text/plain",
      locale,
    );
    assert.doesNotMatch(long.textContent!, HANGUL);
    assert.match(long.textContent!, /truncated/);
    // Numbers follow the reader's locale, not the host's (e.g. a de_DE server would print "50.001").
    assert.match(long.textContent!, /showing 50,000 of 50,001 characters/);
  }
});
