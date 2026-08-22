// 회의 발언에서 "다음에 누가 말할지" 지목을 뽑는다. 순수 함수 — I/O 없음.
//
// 자유 텍스트를 파싱하지 않는 것이 핵심이다. 한국어 이름 뒤에는 조사가 붙고(@단비는,
// @단비님), 부분 일치는 비슷한 이름을 가로챈다(@단비 가 @단비수 를). 그래서 폴링이
// SPEAK:/PASS 를 강제하듯(meeting-formatter.js:113-126) 멘션도 형식을 강제한다.

export type MentionParticipant = { npcId: string; displayName: string };

export type MentionResult = {
  /** 지목된 참가자. 없으면 null. */
  npcId: string | null;
  /** TO: 라인을 걷어낸 발언 본문. 멘션이 없으면 원문 그대로. */
  text: string;
};

/** 첫 줄이 `TO: 이름` 이면 [이름, 나머지 본문], 아니면 null. */
function splitToLine(text: string): [string, string] | null {
  const newline = text.indexOf("\n");
  const firstLine = (newline === -1 ? text : text.slice(0, newline)).trim();

  const match = /^TO:\s*(.+)$/i.exec(firstLine);
  if (!match) return null;

  const rest = newline === -1 ? "" : text.slice(newline + 1);
  return [match[1].trim(), rest.trim()];
}

/** 본문에서 @[이름] 을 등장 순서대로 뽑는다. */
function bracketMentions(text: string): string[] {
  const names: string[] = [];
  for (const m of text.matchAll(/@\[([^\]]*)\]/g)) {
    names.push(m[1].trim());
  }
  return names;
}

/**
 * 발언에서 지목 대상을 뽑고, 화면에 보일 본문을 돌려준다.
 *
 * TO: 라인이 있으면 그것을 쓰고 본문에서 제거한다(이름이 참가자가 아니어도 제거한다 —
 * 사용자에게 제어 프리픽스를 보이지 않는 것이 우선이다). TO: 가 없으면 본문의 @[이름] 을
 * 등장 순서대로 보고 참가자와 일치하는 첫 번째를 쓴다.
 *
 * 자기 자신 지목은 무시한다. 무시하지 않으면 한 NPC 가 발언권을 계속 되가져간다.
 */
export function parseMention(
  text: string,
  participants: MentionParticipant[],
  speakerNpcId: string,
): MentionResult {
  if (typeof text !== "string") return { npcId: null, text: "" };

  const resolve = (name: string): string | null => {
    const hit = participants.find((p) => p.displayName === name);
    if (!hit || hit.npcId === speakerNpcId) return null;
    return hit.npcId;
  };

  const to = splitToLine(text);
  if (to) {
    const [name, body] = to;
    return { npcId: resolve(name), text: body };
  }

  for (const name of bracketMentions(text)) {
    const npcId = resolve(name);
    if (npcId) return { npcId, text };
  }

  return { npcId: null, text };
}

/**
 * 지목 대상을 **전부** 등장 순서대로 돌려준다. 자유채팅은 여럿이 동시에 대답하므로
 * parseMention 처럼 하나만 고를 수 없다.
 *
 * parseMention 과 갈라 둔 이유: 그쪽은 "다음 발언자 한 명"을 뜻하고 본문에서 TO: 라인을
 * 걷어낸 텍스트까지 돌려준다. 의미가 다른 두 질문에 한 함수가 답하면 호출부가 결과를
 * 잘못 읽는다.
 *
 * speakerNpcId 가 null 이면 사람이 말한 것이다 — 제외할 자기 자신이 없다.
 */
export function parseAllMentions(
  text: string,
  participants: MentionParticipant[],
  speakerNpcId: string | null,
): string[] {
  if (typeof text !== "string") return [];

  const names: string[] = [];
  const to = splitToLine(text);
  if (to) {
    names.push(to[0]);
    names.push(...bracketMentions(to[1]));
  } else {
    names.push(...bracketMentions(text));
  }

  const out: string[] = [];
  for (const name of names) {
    const hit = participants.find((p) => p.displayName === name);
    if (!hit) continue;
    if (hit.npcId === speakerNpcId) continue;
    if (out.includes(hit.npcId)) continue;
    out.push(hit.npcId);
  }
  return out;
}
