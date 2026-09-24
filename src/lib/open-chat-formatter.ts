// Builds the script given to an NPC in free chat (map chat). Pure — no I/O.
//
// How it differs from the meeting script (meeting-formatter.js): no topic, no turn
// counter, and instead of a participant roster there's only "who called me" and the
// recent conversation. Map chat has no agenda and no ordering.
//
// The mention format is the **exact same** as in meetings, deliberately. If the format
// diverged, there'd be two parsers, and a mention that only works with one of them.

import { formatReportFormat } from "@/lib/report-format";
import { formatUserContext, type UserContext } from "@/lib/user-context";

export type ChatLine = { sender: string; content: string };

export function formatOpenChatMessage(
  self: { displayName: string },
  others: Array<{ displayName: string; role: string }>,
  recent: ChatLine[],
  calledBy: string,
  caller?: UserContext | null,
): string {
  const lines: string[] = [];

  lines.push(
    `당신은 ${self.displayName} 입니다. 사무실에서 오가는 대화 중 ${calledBy} 님이 당신을 불렀습니다.`,
  );
  // Who called (name·intro). If not passed, this is byte-identical to the old script.
  if (caller?.name) lines.push(formatUserContext(caller));
  lines.push("");

  if (others.length > 0) {
    lines.push("[같은 공간에 있는 동료]");
    for (const o of others) lines.push(`- ${o.displayName}(${o.role})`);
    lines.push("");
  }

  // The report format string is shared across all three conversation paths (DM · whole
  // office · meeting) — report-format.ts. Placed **before** the recent conversation: some
  // callers read the script by slicing from [최근 대화] to [답하는 법].
  lines.push(formatReportFormat());
  lines.push("");

  lines.push("[최근 대화]");
  if (recent.length === 0) {
    lines.push("(아직 오간 말이 없습니다)");
  } else {
    for (const line of recent) lines.push(`${line.sender}: ${line.content}`);
  }
  lines.push("");

  lines.push("[답하는 법]");
  lines.push("- 지금 이 자리에서 말하듯 짧게 답하세요.");
  lines.push("- 동료에게 넘기고 싶으면 첫 줄에 `TO: 이름` 을 쓰거나 본문에 `@[이름]` 을 쓰세요.");
  lines.push("- 이름은 위 목록의 괄호 앞부분(역할 제외)만 정확히 쓰고, 대괄호를 빼먹지 마세요.");
  lines.push(`  예: 동료가 "하늘(디자이너)"이면 "TO: 하늘" 또는 "@[하늘]" 이라고 씁니다.`);

  return lines.join("\n");
}
