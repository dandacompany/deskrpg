/**
 * Reads a meeting-summary response into a structured outcome.
 *
 * The result is a **draft** — not a card. Nothing is created in Hermes until the user
 * clicks register. The assignee the model wrote is resolved only among meeting
 * participants; if it can't be resolved, it's left unassigned. This blocks a profile
 * name that isn't in the channel from becoming a card's assignee.
 */
import { languageName, promptLocale } from "./i18n/prompt-locale";

export const MEETING_OUTCOME_LIMITS = {
  keyTopics: 10,
  decisions: 10,
  followUps: 12,
  title: 200,
  text: 1000,
} as const;

export type OutcomeParticipant = { npcId: string; name: string };

export type MeetingFollowUp = {
  title: string;
  summary: string | null;
  acceptance: string | null;
  assigneeNpcId: string | null;
  /** The name exactly as the model wrote it. Shown on the draft review screen even if it didn't resolve to a participant. */
  assigneeName: string | null;
  /** The index of an item that must finish first. Becomes a Hermes parent link on registration. */
  after: number[];
};

export type MeetingOutcome = {
  decisions: string[];
  followUps: MeetingFollowUp[];
  project: { recommended: boolean; name: string | null; reason: string | null } | null;
  /**
   * The registration result. Not a copy of the card content but a **link** — it only
   * records which cards were created on which board/subproject. If this is set, the
   * proposal has been resolved and the summary isn't regenerated.
   */
  registered?: MeetingOutcomeRegistered | null;
};

export type MeetingOutcomeRegistered = {
  boardSlug: string;
  tenant: string | null;
  taskIds: string[];
  by: string;
  at: string;
};

export type MeetingSummaryStatus = "ok" | "failed" | "skipped";

export type ParsedMeetingOutcome = {
  status: MeetingSummaryStatus;
  keyTopics: string[];
  conclusions: string | null;
  outcome: MeetingOutcome | null;
};

const FAILED: ParsedMeetingOutcome = {
  status: "failed",
  keyTopics: [],
  conclusions: null,
  outcome: null,
};

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function textList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  const items: string[] = [];
  for (const entry of value) {
    const item = text(entry, maxLength);
    if (item) items.push(item);
    if (items.length === maxItems) break;
  }
  return items;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Does following `after` from `from` reach `target`? */
function reaches(
  after: number[][],
  from: number,
  target: number,
  seen = new Set<number>(),
): boolean {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return after[from].some((next) => reaches(after, next, target, seen));
}

function readFollowUps(value: unknown, participants: OutcomeParticipant[]): MeetingFollowUp[] {
  if (!Array.isArray(value)) return [];
  const byName = new Map(participants.map((p) => [p.name.trim().toLowerCase(), p.npcId]));

  // Dropping items with no title shifts the indexes — first build a table mapping original numbers to new ones.
  const kept: Array<{ source: Record<string, unknown>; title: string }> = [];
  const renumber = new Map<number, number>();
  value.forEach((entry, index) => {
    if (kept.length === MEETING_OUTCOME_LIMITS.followUps || !isRecord(entry)) return;
    const title = text(entry.title, MEETING_OUTCOME_LIMITS.title);
    if (!title) return;
    renumber.set(index, kept.length);
    kept.push({ source: entry, title });
  });

  const after: number[][] = kept.map(() => []);
  kept.forEach(({ source }, index) => {
    if (!Array.isArray(source.after)) return;
    for (const raw of source.after) {
      const target = typeof raw === "number" ? renumber.get(raw) : undefined;
      if (target === undefined || target === index || after[index].includes(target)) continue;
      // Would adding this link create a cycle? Yes if target can already reach index.
      if (reaches(after, target, index)) continue;
      after[index].push(target);
    }
  });

  return kept.map(({ source, title }, index) => {
    const assigneeName = text(source.assignee, MEETING_OUTCOME_LIMITS.title);
    return {
      title,
      summary: text(source.summary, MEETING_OUTCOME_LIMITS.text),
      acceptance: text(source.acceptance, MEETING_OUTCOME_LIMITS.text),
      assigneeNpcId: (assigneeName && byName.get(assigneeName.toLowerCase())) || null,
      assigneeName,
      after: after[index],
    };
  });
}

export function parseMeetingOutcome(
  response: string,
  participants: OutcomeParticipant[],
): ParsedMeetingOutcome {
  const match = (response || "").match(/\{[\s\S]*\}/);
  if (!match) return FAILED;

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return FAILED;
  }
  if (!isRecord(parsed)) return FAILED;

  const project = isRecord(parsed.project)
    ? {
        recommended: parsed.project.recommended === true,
        name: text(parsed.project.name, MEETING_OUTCOME_LIMITS.title),
        reason: text(parsed.project.reason, MEETING_OUTCOME_LIMITS.text),
      }
    : null;

  return {
    status: "ok",
    keyTopics: textList(
      parsed.keyTopics,
      MEETING_OUTCOME_LIMITS.keyTopics,
      MEETING_OUTCOME_LIMITS.title,
    ),
    conclusions: text(parsed.conclusions, MEETING_OUTCOME_LIMITS.text * 2),
    outcome: {
      decisions: textList(
        parsed.decisions,
        MEETING_OUTCOME_LIMITS.decisions,
        MEETING_OUTCOME_LIMITS.text,
      ),
      followUps: readFollowUps(parsed.followUps, participants),
      project,
    },
  };
}

/**
 * The summary prompt. Pins down assignee candidates to attending employee names — if
 * the model isn't told which names it can choose from, it invents names that weren't in the meeting.
 */
export function buildMeetingSummaryPrompt(
  topic: string,
  transcript: string,
  participants: OutcomeParticipant[],
  locale: string | null = "ko",
): string {
  if (promptLocale(locale) !== "ko")
    return buildEnglishSummaryPrompt(topic, transcript, participants, locale);
  const names = participants.map((p) => p.name).join(", ") || "(없음)";
  return `다음 회의 내용을 분석하여 JSON으로 응답하세요.

회의 주제: ${topic}
참석 직원: ${names}

${transcript}

응답 형식 (JSON만, 다른 텍스트 없이):
{
  "keyTopics": ["주제1", "주제2", "주제3"],
  "conclusions": "결론 요약 2-3문장",
  "decisions": ["회의에서 실제로 정해진 것 한 줄씩"],
  "followUps": [
    {
      "title": "후속 업무 제목",
      "summary": "무엇을 하는 일인지 1-2문장",
      "acceptance": "무엇이 참이면 끝난 것인지",
      "assignee": "참석 직원 이름 중 하나 또는 null",
      "after": [먼저 끝나야 하는 followUps 항목의 0부터 시작하는 번호]
    }
  ],
  "project": {
    "recommended": true 또는 false,
    "name": "묶어서 추적할 때의 프로젝트 이름",
    "reason": "왜 여러 업무를 하나로 묶어 추적해야 하는지, 또는 왜 필요 없는지"
  }
}

규칙:
- 회의에서 합의되지 않은 업무를 지어내지 않는다. 후속 업무가 없으면 "followUps": [] 로 둔다.
- "assignee" 는 위 참석 직원 이름만 쓴다. 회의에서 담당이 정해지지 않았으면 null.
- "project.recommended" 는 후속 업무가 여럿이고 서로 이어질 때만 true.`;
}

/** The same prompt for every non-Korean locale: English instructions, the same JSON keys, and the output language named at the end. */
function buildEnglishSummaryPrompt(
  topic: string,
  transcript: string,
  participants: OutcomeParticipant[],
  locale: string | null,
): string {
  const names = participants.map((p) => p.name).join(", ") || "(none)";
  return `Analyze the following meeting and respond in JSON.

Meeting topic: ${topic}
Attending employees: ${names}

${transcript}

Response format (JSON only, no other text):
{
  "keyTopics": ["Topic 1", "Topic 2", "Topic 3"],
  "conclusions": "A 2-3 sentence summary of the conclusions",
  "decisions": ["One line per thing actually decided in the meeting"],
  "followUps": [
    {
      "title": "Follow-up task title",
      "summary": "1-2 sentences on what the task is",
      "acceptance": "What must be true for it to be done",
      "assignee": "One of the attending employee names, or null",
      "after": [0-based indexes of the followUps items that must finish first]
    }
  ],
  "project": {
    "recommended": true or false,
    "name": "Project name for tracking the tasks together",
    "reason": "Why the tasks should be tracked together as one project, or why that isn't needed"
  }
}

Rules:
- Don't invent tasks the meeting didn't agree on. If there are no follow-up tasks, use "followUps": [].
- Use only the attending employee names above for "assignee". If the meeting didn't settle an owner, use null.
- "project.recommended" is true only when there are several follow-up tasks that build on each other.
Write every string value in ${languageName(locale)}.`;
}
