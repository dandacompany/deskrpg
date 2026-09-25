/**
 * Pins the Korean LLM instruction templates byte-for-byte. Korean output must stay exactly as it
 * was before content i18n: user-written meeting protocols teach the "📋 [회의 알림:" markers, so the
 * ko variants are frozen here and only the other locales get the English templates.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { buildMeetingSummaryPrompt } from "./meeting-outcome";
import { getDefaultMeetingProtocol } from "./meeting-protocol";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const formatter = require("./meeting-formatter.js") as typeof import("./meeting-formatter.js");

const turns = [
  { displayName: "A", content: "hi" },
  { displayName: "B", content: "x".repeat(160) },
];
const participants = [
  { displayName: "A", role: "Lead" },
  { displayName: "B", role: "Dev" },
];

const POLL_KO =
  "📋 [회의 알림: Topic]\n현재 턴: 2/10 | 당신의 남은 발언: 3\n\n최근 대화:\n[A] hi\n[B] xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx...\n\n---\n발언하고 싶으면 → SPEAK: (한줄 이유)\n넘기려면 → PASS\n\n반드시 SPEAK: 또는 PASS 중 하나로만 첫 줄에 답해주세요.";
const POLL_POLICY_KO =
  "📋 [회의 알림: Topic]\n현재 턴: 2/10 | 당신의 남은 발언: 3\n\n최근 대화:\n[A] hi\n[B] xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx...\n\n---\n[발언 지침] Be brief\n\n발언하고 싶으면 → SPEAK: (한줄 이유)\n넘기려면 → PASS\n\n반드시 SPEAK: 또는 PASS 중 하나로만 첫 줄에 답해주세요.";
const SPEAK_KO =
  '📋 [회의: Topic]\n참석자: A(Lead), B(Dev)\n현재 턴: 2/10 | 당신의 남은 발언: 3\n\n---\n[A] hi\n\n[B] xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n\n---\nA님, 의견을 말씀해 주세요.\n⚠️ 규칙: 동료한테 말하듯이 구어체로, 이번 턴에 필요한 핵심만. 불릿(-)이나 번호(1. 2. 3.) 목록 절대 금지. 볼드(**) 금지. 헤더(##) 금지. 그냥 말로 해.\n💬 특정 참석자에게 답을 듣고 싶으면 첫 줄에 "TO: 이름"을 쓰거나 본문에서 "@[이름]"으로 부르세요. 그 사람이 다음에 답합니다. 이름은 위 참석자 목록의 괄호 앞부분(역할 제외)만 정확히 쓰고, 대괄호를 빼먹지 마세요. 예: 참석자가 "단비(팀장)"이면 "TO: 단비" 또는 "@[단비]"라고 쓰세요.';
const SUMMARY_KO =
  '다음 회의 내용을 분석하여 JSON으로 응답하세요.\n\n회의 주제: 주제\n참석 직원: A\n\n[A] hi\n\n응답 형식 (JSON만, 다른 텍스트 없이):\n{\n  "keyTopics": ["주제1", "주제2", "주제3"],\n  "conclusions": "결론 요약 2-3문장",\n  "decisions": ["회의에서 실제로 정해진 것 한 줄씩"],\n  "followUps": [\n    {\n      "title": "후속 업무 제목",\n      "summary": "무엇을 하는 일인지 1-2문장",\n      "acceptance": "무엇이 참이면 끝난 것인지",\n      "assignee": "참석 직원 이름 중 하나 또는 null",\n      "after": [먼저 끝나야 하는 followUps 항목의 0부터 시작하는 번호]\n    }\n  ],\n  "project": {\n    "recommended": true 또는 false,\n    "name": "묶어서 추적할 때의 프로젝트 이름",\n    "reason": "왜 여러 업무를 하나로 묶어 추적해야 하는지, 또는 왜 필요 없는지"\n  }\n}\n\n규칙:\n- 회의에서 합의되지 않은 업무를 지어내지 않는다. 후속 업무가 없으면 "followUps": [] 로 둔다.\n- "assignee" 는 위 참석 직원 이름만 쓴다. 회의에서 담당이 정해지지 않았으면 null.\n- "project.recommended" 는 후속 업무가 여럿이고 서로 이어질 때만 true.';
const SUMMARY_NO_PARTICIPANTS_KO =
  '다음 회의 내용을 분석하여 JSON으로 응답하세요.\n\n회의 주제: 주제\n참석 직원: (없음)\n\n[A] hi\n\n응답 형식 (JSON만, 다른 텍스트 없이):\n{\n  "keyTopics": ["주제1", "주제2", "주제3"],\n  "conclusions": "결론 요약 2-3문장",\n  "decisions": ["회의에서 실제로 정해진 것 한 줄씩"],\n  "followUps": [\n    {\n      "title": "후속 업무 제목",\n      "summary": "무엇을 하는 일인지 1-2문장",\n      "acceptance": "무엇이 참이면 끝난 것인지",\n      "assignee": "참석 직원 이름 중 하나 또는 null",\n      "after": [먼저 끝나야 하는 followUps 항목의 0부터 시작하는 번호]\n    }\n  ],\n  "project": {\n    "recommended": true 또는 false,\n    "name": "묶어서 추적할 때의 프로젝트 이름",\n    "reason": "왜 여러 업무를 하나로 묶어 추적해야 하는지, 또는 왜 필요 없는지"\n  }\n}\n\n규칙:\n- 회의에서 합의되지 않은 업무를 지어내지 않는다. 후속 업무가 없으면 "followUps": [] 로 둔다.\n- "assignee" 는 위 참석 직원 이름만 쓴다. 회의에서 담당이 정해지지 않았으면 null.\n- "project.recommended" 는 후속 업무가 여럿이고 서로 이어질 때만 true.';
const PROTOCOL_KO =
  "# AGENTS.md - Team Workspace\n\n\n## 응답 언어 계약\n\n- 모든 직접 대화, 회의 발언, 태스크 보고, 요약, 후속 질문은 반드시 한국어로 작성한다.\n- 인간이 페르소나 문서를 의도적으로 다른 언어로 다시 작성하지 않는 한 이 규칙을 고정 규칙으로 취급한다.\n\nYou work as an employee in a DeskRPG virtual office. Who you are comes from your profile; this document covers only how you work with the team.\n\n## Safety\n\n- Don't exfiltrate private data.\n- Ask before running destructive commands or doing anything that leaves the machine (emails, posts, external messages). Prefer recoverable actions: `trash` over `rm`.\n\n## Group Chats\n\nIn a room with several people you're a participant, not the user's voice or proxy. Contribute when you're addressed or asked, or when you can add something the conversation doesn't have yet. For casual banter or an already-answered question, a short reply is enough. Send one reply per message rather than several fragments.\n\n## 🤝 회의 프로토콜\n\n회의 브로커가 메시지를 중계할 때, 아래 포맷의 메시지를 받게 된다. 이 포맷을 인식하면 **회의 모드**로 행동한다.\n\n### 발언권 요청 (Raise Hand)\n\n메시지가 `📋 [회의 알림:` 으로 시작하면, 브로커가 발언 의사를 묻는 것이다.\n최근 대화 요약이 포함되어 있고, 마지막에 응답 형식이 안내된다.\n\n**반드시 첫 줄에 다음 중 하나로 답한다:**\n- `SPEAK: (한줄 이유)` — 할 말이 있을 때. 이유는 짧게.\n- `PASS` — 지금은 넘길 때. 이미 충분히 논의됐거나, 다른 사람 의견을 더 듣고 싶을 때.\n\n판단 기준:\n- 직전 발언에서 나를 직접 지목하거나 질문했다면 → SPEAK\n- 내 전문분야에 대한 논의가 진행 중이면 → SPEAK\n- 반대 의견이나 보충할 내용이 있으면 → SPEAK\n- 이미 내 의견을 충분히 말했고 새로운 관점이 없으면 → PASS\n- 다른 사람이 먼저 말해야 흐름이 자연스러우면 → PASS\n\n### 회의 메시지 식별 (본 발언)\n\n메시지가 `📋 [회의:` 로 시작하면 회의 세션이다. 헤더에서 다음 정보를 파악한다:\n- **회의 주제** — 무엇에 대한 논의인지\n- **참석자** — 누가 참여하고 있는지 (이름과 역할)\n- **턴 정보** — 현재 몇 번째 턴인지, 남은 발언 횟수\n\n### 대화 기록 읽기\n\n`---` 구분선 사이의 내용이 최근 대화 기록이다. 각 발언은 `[이름]` 프리픽스로 구분된다.\n마지막 줄에 **누구에게 발언을 요청하는지** 명시되어 있다. 그 사람이 나라면 응답한다.\n\n### 회의 행동 규칙\n\n1. **컨텍스트를 유지한다** — 이전 발언들을 모두 읽고, 대화의 흐름을 이어간다. 이미 나온 의견을 반복하지 않는다.\n2. **발화자를 구분한다** — `[이름]` 프리픽스로 누가 뭘 말했는지 구분하고, 응답할 때 적절히 언급한다.\n3. **직접 지칭한다** — 동의/반대할 때 상대 이름을 직접 부른다.\n4. **간결하게 말한다** — 한 턴에는 핵심만 담는다. 같은 내용을 다른 표현으로 반복하지 않는다.\n5. **질문한다** — 다른 참석자에게 질문을 던질 수 있다.\n6. **건설적으로 반대한다** — 동의하지 않을 때 대안을 함께 제시한다.\n7. **결론을 향해 수렴한다** — 턴이 제한되어 있으므로, 합의점을 찾으려 노력한다.\n\n### 회의 외 메시지\n\n`📋 [회의:` 로 시작하지 않는 일반 메시지는 평소대로 1:1 대화로 처리한다.\n\n### 회의록\n\n회의가 끝나면 브로커가 회의록을 정리한다. 요청받으면 핵심 결정사항과 액션 아이템을 정리해서 제출한다.\n\n## Make It Yours\n\nThis is a starting point. Add your own conventions, style, and rules as you figure out what works.";

test("the Korean poll message is unchanged", () => {
  assert.equal(
    formatter.formatPollMessage("Topic", turns, { displayName: "A" }, 2, 10, 3, null),
    POLL_KO,
  );
  assert.equal(
    formatter.formatPollMessage("Topic", turns, { displayName: "A" }, 2, 10, 3, "Be brief"),
    POLL_POLICY_KO,
  );
});

test("the Korean speak message is unchanged", () => {
  assert.equal(
    formatter.formatSpeakMessage("Topic", participants, turns, { displayName: "A" }, 2, 10, 3),
    SPEAK_KO,
  );
});

test("the Korean summary prompt is unchanged", () => {
  assert.equal(
    buildMeetingSummaryPrompt("주제", "[A] hi", [{ npcId: "n1", name: "A" }]),
    SUMMARY_KO,
  );
  assert.equal(buildMeetingSummaryPrompt("주제", "[A] hi", []), SUMMARY_NO_PARTICIPANTS_KO);
});

test("the Korean default meeting protocol is unchanged", () => {
  assert.equal(getDefaultMeetingProtocol("ko"), PROTOCOL_KO);
});

test("an empty SPEAK reason keeps the Korean filler", () => {
  assert.deepEqual(formatter.parseHandRaise("SPEAK"), {
    wantsToSpeak: true,
    reason: "(발언 희망)",
  });
});

const TRANSCRIPT_KO =
  "# 회의록: Topic\n\n- **일시**: <DATE>\n- **참석자**: A(Lead)\n- **총 턴**: 2\n\n---\n\n## 대화 기록\n\n### [1] A (<T0>)\n\nhi\n\n### [2] B (<T1>)\n\nyo\n";

test("the Korean meeting transcript is unchanged", () => {
  const transcript = formatter.generateTranscript(
    "Topic",
    [
      { seq: 1, displayName: "A", content: "hi", timestamp: 0 },
      { seq: 2, displayName: "B", content: "yo", timestamp: 60_000 },
    ],
    [{ displayName: "A", role: "Lead" }],
  );
  const expected = TRANSCRIPT_KO.replace("<DATE>", new Date().toISOString().split("T")[0])
    .replace("<T0>", new Date(0).toLocaleTimeString("ko-KR"))
    .replace("<T1>", new Date(60_000).toLocaleTimeString("ko-KR"));
  assert.equal(transcript, expected);
});
