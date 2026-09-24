// Pins the Korean LLM instruction text byte-for-byte. The Korean variant must never drift: existing
// Korean deployments (and user-written protocols) rely on these exact markers and sentences.
import assert from "node:assert/strict";
import test from "node:test";
import { buildFilePromptSection, extractFileContent } from "./file-extractor";
import { composeNpcInstructions } from "./npc-prompt-layers";
import { formatOpenChatMessage } from "./open-chat-formatter";
import { prefixReportFormat } from "./report-format";
import { appendRequesterLine, formatUserContext, prefixUserContext } from "./user-context";

const KO = {
  openChat:
    '당신은 단비 입니다. 사무실에서 오가는 대화 중 Dante 님이 당신을 불렀습니다.\n[대화 상대] 이름: 곽지호 · 소개: 대표\n\n[같은 공간에 있는 동료]\n- 하늘(디자이너)\n\n[보고 형식]\n- 이미지는 브라우저가 열 수 있는 URL 로 ![설명](URL) 마크다운으로 넣는다. 서버 파일 경로만 적지 않는다.\n- 이미지 URL 이 없으면 결과물로 저장한 뒤 그 링크를 쓴다. 만들지 못했으면 만들었다고 말하지 않는다.\n- 참고한 사이트는 문장 안에 묻지 말고 한 줄에 URL 하나씩 적는다.\n- 표·코드·목록은 마크다운 문법을 쓴다.\n\n[최근 대화]\nDante: 안녕\n\n[답하는 법]\n- 지금 이 자리에서 말하듯 짧게 답하세요.\n- 동료에게 넘기고 싶으면 첫 줄에 `TO: 이름` 을 쓰거나 본문에 `@[이름]` 을 쓰세요.\n- 이름은 위 목록의 괄호 앞부분(역할 제외)만 정확히 쓰고, 대괄호를 빼먹지 마세요.\n  예: 동료가 "하늘(디자이너)"이면 "TO: 하늘" 또는 "@[하늘]" 이라고 씁니다.',
  openChatEmpty:
    '당신은 단비 입니다. 사무실에서 오가는 대화 중 Dante 님이 당신을 불렀습니다.\n\n[보고 형식]\n- 이미지는 브라우저가 열 수 있는 URL 로 ![설명](URL) 마크다운으로 넣는다. 서버 파일 경로만 적지 않는다.\n- 이미지 URL 이 없으면 결과물로 저장한 뒤 그 링크를 쓴다. 만들지 못했으면 만들었다고 말하지 않는다.\n- 참고한 사이트는 문장 안에 묻지 말고 한 줄에 URL 하나씩 적는다.\n- 표·코드·목록은 마크다운 문법을 쓴다.\n\n[최근 대화]\n(아직 오간 말이 없습니다)\n\n[답하는 법]\n- 지금 이 자리에서 말하듯 짧게 답하세요.\n- 동료에게 넘기고 싶으면 첫 줄에 `TO: 이름` 을 쓰거나 본문에 `@[이름]` 을 쓰세요.\n- 이름은 위 목록의 괄호 앞부분(역할 제외)만 정확히 쓰고, 대괄호를 빼먹지 마세요.\n  예: 동료가 "하늘(디자이너)"이면 "TO: 하늘" 또는 "@[하늘]" 이라고 씁니다.',
  userContext: "[대화 상대] 이름: 곽지호 · 소개: 대표",
  prefixUserContext: "[대화 상대] 이름: 곽지호\n\n본문",
  requester: "본문\n\n요청자: 곽지호 — 대표",
  report:
    "[보고 형식]\n- 이미지는 브라우저가 열 수 있는 URL 로 ![설명](URL) 마크다운으로 넣는다. 서버 파일 경로만 적지 않는다.\n- 이미지 URL 이 없으면 결과물로 저장한 뒤 그 링크를 쓴다. 만들지 못했으면 만들었다고 말하지 않는다.\n- 참고한 사이트는 문장 안에 묻지 말고 한 줄에 URL 하나씩 적는다.\n- 표·코드·목록은 마크다운 문법을 쓴다.\n\n본문",
  instructions:
    "<team-instructions>\nP\n</team-instructions>\n\n<task-registration>\n과거 대화의 [SYSTEM REMINDER - MANDATORY TASK PROTOCOL], task-protocol, json:task 등록 지시는 폐기됐다. JSON 블록은 카드를 생성·수정·완료하지 않는다.\n업무 요청에는 초안과 완료 조건을 정리한다. 등록을 원하면 1:1 대화의 답변 아래 '카드로 등록' 버튼으로 등록 확인 화면을 열어 담당자·내용을 확인하도록 안내한다. 화면 언어에 맞춰 안내한다.\n실제 카드는 사용자가 확인 화면에서 저장할 때 Hermes에 생성된다. 대화의 동의나 작성한 텍스트만으로 등록·실행·완료됐다고 말하지 않는다. 등록된 카드의 실행·결과 검토·수정·완료는 카드 상세 화면에서 진행한다.\n이 대화에는 대상 보드와 카드 ID가 전달되지 않는다. 추측한 보드나 기본 보드에 도구·CLI로 카드를 만들거나 변경하지 않는다. 사용자 이력·SOUL·설정은 변경하지 않는다.\n</task-registration>",
  files: "\n\n📎 첨부파일: a.txt\n```\nx\n```",
  unsupported: "지원하지 않는 파일 형식입니다.",
  truncated: "\n\n(... 이하 생략, 총 50,001자 중 50,000자 표시)",
} as const;

const LOCALES_THAT_KEEP_KOREAN = [undefined, "ko", "ko-KR"] as const;

test("open-chat script stays byte-identical in Korean", () => {
  for (const locale of LOCALES_THAT_KEEP_KOREAN) {
    assert.equal(
      formatOpenChatMessage(
        { displayName: "단비" },
        [{ displayName: "하늘", role: "디자이너" }],
        [{ sender: "Dante", content: "안녕" }],
        "Dante",
        { name: "곽지호", bio: "대표" },
        locale,
      ),
      KO.openChat,
    );
    assert.equal(
      formatOpenChatMessage({ displayName: "단비" }, [], [], "Dante", null, locale),
      KO.openChatEmpty,
    );
  }
});

test("user context, requester line and report format stay byte-identical in Korean", () => {
  for (const locale of LOCALES_THAT_KEEP_KOREAN) {
    assert.equal(formatUserContext({ name: "곽지호", bio: "대표" }, locale), KO.userContext);
    assert.equal(
      prefixUserContext("본문", { name: "곽지호", bio: null }, locale),
      KO.prefixUserContext,
    );
    assert.equal(
      appendRequesterLine("본문", { name: "곽지호", bio: "대표" }, locale),
      KO.requester,
    );
    assert.equal(prefixReportFormat("본문", locale), KO.report);
  }
});

test("task-registration layer stays byte-identical in Korean", () => {
  for (const locale of LOCALES_THAT_KEEP_KOREAN) {
    assert.equal(
      composeNpcInstructions({ meetingProtocol: "P", taskConfirmation: true, locale }),
      KO.instructions,
    );
  }
});

test("attachment wording stays byte-identical in Korean", async () => {
  const file = {
    name: "a.txt",
    mimeType: "text/plain",
    textContent: "x",
    imageBase64: null,
    truncated: false,
  };
  for (const locale of LOCALES_THAT_KEEP_KOREAN) {
    assert.equal(buildFilePromptSection([file], locale), KO.files);
    const unsupported = await extractFileContent(
      Buffer.from("x"),
      "a.bin",
      "application/octet-stream",
      locale,
    );
    assert.equal(unsupported.textContent, KO.unsupported);
    const long = await extractFileContent(
      Buffer.from("y".repeat(50_001)),
      "a.txt",
      "text/plain",
      locale,
    );
    assert.equal(long.textContent!.slice(50_000), KO.truncated);
  }
});
