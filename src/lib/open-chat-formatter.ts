// Builds the script given to an NPC in free chat (map chat). Pure — no I/O.
//
// How it differs from the meeting script (meeting-formatter.js): no topic, no turn
// counter, and instead of a participant roster there's only "who called me" and the
// recent conversation. Map chat has no agenda and no ordering.
//
// The mention format is the **exact same** as in meetings, deliberately. If the format
// diverged, there'd be two parsers, and a mention that only works with one of them.

import { promptLocale, type PromptLocale } from "@/lib/i18n/prompt-locale";
import { formatReportFormat } from "@/lib/report-format";
import { formatUserContext, type UserContext } from "@/lib/user-context";

export type ChatLine = { sender: string; content: string };

type Words = {
  intro: (self: string, calledBy: string) => string;
  colleagues: string;
  /** Shown in place of an empty role. */
  defaultRole: string;
  recent: string;
  nothingYet: string;
  howToReply: string;
  replyRules: readonly string[];
};

/**
 * Two variants: `ko` is the original script byte-for-byte, `en` serves every other language
 * (the NPC's language-policy section decides the language it actually answers in).
 * Header markers are read back by some callers (slicing from `recent` to `howToReply`), so
 * readers must recognize both variants.
 */
const WORDS: Record<PromptLocale, Words> = {
  ko: {
    intro: (self, calledBy) =>
      `당신은 ${self} 입니다. 사무실에서 오가는 대화 중 ${calledBy} 님이 당신을 불렀습니다.`,
    colleagues: "[같은 공간에 있는 동료]",
    defaultRole: "동료",
    recent: "[최근 대화]",
    nothingYet: "(아직 오간 말이 없습니다)",
    howToReply: "[답하는 법]",
    replyRules: [
      "- 지금 이 자리에서 말하듯 짧게 답하세요.",
      "- 동료에게 넘기고 싶으면 첫 줄에 `TO: 이름` 을 쓰거나 본문에 `@[이름]` 을 쓰세요.",
      "- 이름은 위 목록의 괄호 앞부분(역할 제외)만 정확히 쓰고, 대괄호를 빼먹지 마세요.",
      `  예: 동료가 "하늘(디자이너)"이면 "TO: 하늘" 또는 "@[하늘]" 이라고 씁니다.`,
    ],
  },
  en: {
    intro: (self, calledBy) =>
      `You are ${self}. During a conversation in the office, ${calledBy} called on you.`,
    colleagues: "[Colleagues in the same space]",
    defaultRole: "Colleague",
    recent: "[Recent conversation]",
    nothingYet: "(Nothing has been said yet)",
    howToReply: "[How to reply]",
    replyRules: [
      "- Reply briefly, as if speaking right here and now.",
      "- To hand off to a colleague, write `TO: Name` on the first line or `@[Name]` in the body.",
      "- Write only the part of the name before the parentheses in the list above (no role), exactly, and do not drop the brackets.",
      `  Example: if the colleague is "Haneul(Designer)", write "TO: Haneul" or "@[Haneul]".`,
    ],
  },
};

/** Omitting `locale` keeps the original Korean script. */
export function formatOpenChatMessage(
  self: { displayName: string },
  others: Array<{ displayName: string; role: string }>,
  recent: ChatLine[],
  calledBy: string,
  caller?: UserContext | null,
  locale: string | null | undefined = "ko",
): string {
  const w = WORDS[promptLocale(locale)];
  const lines: string[] = [];

  lines.push(w.intro(self.displayName, calledBy));
  // Who called (name·intro). If not passed, this is byte-identical to the old script.
  if (caller?.name) lines.push(formatUserContext(caller, locale));
  lines.push("");

  if (others.length > 0) {
    lines.push(w.colleagues);
    for (const o of others) lines.push(`- ${o.displayName}(${o.role || w.defaultRole})`);
    lines.push("");
  }

  // The report format string is shared across all three conversation paths (DM · whole
  // office · meeting) — report-format.ts. Placed **before** the recent conversation: some
  // callers read the script by slicing from the `recent` marker to the `howToReply` marker.
  lines.push(formatReportFormat(locale));
  lines.push("");

  lines.push(w.recent);
  if (recent.length === 0) {
    lines.push(w.nothingYet);
  } else {
    for (const line of recent) lines.push(`${line.sender}: ${line.content}`);
  }
  lines.push("");

  lines.push(w.howToReply);
  lines.push(...w.replyRules);

  return lines.join("\n");
}
