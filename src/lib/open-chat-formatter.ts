// 자유채팅(맵 채팅)에서 NPC 에게 줄 대본을 만든다. 순수 — I/O 없음.
//
// 회의 대본(meeting-formatter.js)과 다른 것: 주제가 없고, 턴 카운터가 없고, 참석자 명단
// 대신 "누가 나를 불렀나"와 최근 대화만 있다. 맵 채팅에는 안건도 순서도 없기 때문이다.
//
// 지명 형식만은 회의와 **똑같이** 안내한다. 형식이 갈리면 파서가 둘이 되고, 그 순간
// 한쪽에서만 통하는 지목이 생긴다.

export type ChatLine = { sender: string; content: string };

export function formatOpenChatMessage(
  self: { displayName: string },
  others: Array<{ displayName: string; role: string }>,
  recent: ChatLine[],
  calledBy: string,
): string {
  const lines: string[] = [];

  lines.push(`당신은 ${self.displayName} 입니다. 사무실에서 오가는 대화 중 ${calledBy} 님이 당신을 불렀습니다.`);
  lines.push("");

  if (others.length > 0) {
    lines.push("[같은 공간에 있는 동료]");
    for (const o of others) lines.push(`- ${o.displayName}(${o.role})`);
    lines.push("");
  }

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
