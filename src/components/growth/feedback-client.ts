import { BUG_REPORT_BASE_URL } from "@/lib/app-meta";

export const DEFAULT_FEEDBACK_URL = "https://feedback.deskrpg.com";
const INSTALL_ID_KEY = "deskrpg.feedback.installId";

/** Resolves `DESKRPG_FEEDBACK_URL`. Falls back to the default server when unset; an empty value disables both the survey and private sending. */
export function resolveFeedbackUrl(raw: string | undefined): string | null {
  if (raw === undefined) return DEFAULT_FEEDBACK_URL;
  const trimmed = raw.trim().replace(/\/+$/, "");
  return trimmed === "" ? null : trimmed;
}

/** A random install ID unrelated to any account. Used only to filter out duplicate responses from the same install. */
export function getInstallId(storage: Storage | null): string | null {
  try {
    if (!storage) return null;
    let id = storage.getItem(INSTALL_ID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      storage.setItem(INSTALL_ID_KEY, id);
    }
    return id;
  } catch {
    return null;
  }
}

const recentErrors: string[] = [];

export function recordClientError(message: string): void {
  const line = message.split("\n")[0].slice(0, 300);
  if (!line) return;
  recentErrors.push(line);
  if (recentErrors.length > 5) recentErrors.shift();
}

export function recentErrorDigest(): string {
  return recentErrors.join("\n");
}

let captureInstalled = false;
export function installErrorCapture(): void {
  if (captureInstalled || typeof window === "undefined") return;
  captureInstalled = true;
  window.addEventListener("error", (e) => recordClientError(e.message || String(e.error)));
  window.addEventListener("unhandledrejection", (e) =>
    recordClientError(e.reason instanceof Error ? e.reason.message : String(e.reason)),
  );
}

export type AttachmentKey = "version" | "userAgent" | "viewport" | "errorDigest";
export interface Attachment {
  key: AttachmentKey;
  value: string;
}

export function collectAttachments(values: Record<AttachmentKey, string>): Attachment[] {
  return (["version", "userAgent", "viewport", "errorDigest"] as const)
    .filter((key) => values[key].trim() !== "")
    .map((key) => ({ key, value: values[key] }));
}

export interface BugDraft {
  title: string;
  body: string;
  repro: string;
  attachments: Attachment[];
}

/** Issue headings in the reporter's language. The issue tracker reads Korean and English; other languages get English. */
const ISSUE_HEADINGS = {
  ko: { problem: "## 문제 설명", repro: "## 재현 방법", debug: "## 디버그 정보" },
  en: { problem: "## Problem", repro: "## Steps to reproduce", debug: "## Debug info" },
} as const;

export function buildGithubIssueUrl(draft: BugDraft, locale: string): string {
  const headings = ISSUE_HEADINGS[locale === "ko" ? "ko" : "en"];
  const lines = [headings.problem, "", draft.body, "", headings.repro, "", draft.repro, ""];
  if (draft.attachments.length > 0) {
    lines.push(
      headings.debug,
      "",
      ...draft.attachments.map((a) => `- ${a.key}: ${a.value.replace(/\n/g, " / ")}`),
    );
  }
  const params = new URLSearchParams({
    labels: "bug-report",
    title: draft.title,
    body: lines.join("\n"),
  });
  return `${BUG_REPORT_BASE_URL}?${params.toString()}`;
}

export interface SurveyQuestion {
  id: string;
  type: "nps" | "text";
  prompt: Record<string, string>;
}
export interface SurveySet {
  version: number;
  intervalDays: number;
  questions: SurveyQuestion[];
}

/** Matches the server's default set (version 1) — the server always accepts this version. */
export const FALLBACK_SURVEY: SurveySet = {
  version: 1,
  intervalDays: 30,
  questions: [
    {
      id: "nps",
      type: "nps",
      prompt: {
        ko: "DeskRPG를 동료에게 추천할 가능성은 얼마나 되나요?",
        en: "How likely are you to recommend DeskRPG to a colleague?",
        ja: "DeskRPG を同僚に勧める可能性はどのくらいですか？",
        zh: "您有多大可能向同事推荐 DeskRPG？",
      },
    },
    {
      id: "best",
      type: "text",
      prompt: {
        ko: "가장 좋은 점은 무엇인가요?",
        en: "What do you like most?",
        ja: "一番良い点は？",
        zh: "您最喜欢哪一点？",
      },
    },
    {
      id: "worst",
      type: "text",
      prompt: {
        ko: "가장 아쉬운 점은 무엇인가요?",
        en: "What is most disappointing?",
        ja: "一番残念な点は？",
        zh: "您最不满意的是什么？",
      },
    },
  ],
};

function isSurveySet(v: unknown): v is SurveySet {
  if (!v || typeof v !== "object") return false;
  const s = v as Partial<SurveySet>;
  return (
    Number.isInteger(s.version) &&
    Number.isInteger(s.intervalDays) &&
    Array.isArray(s.questions) &&
    s.questions.length > 0 &&
    s.questions.every(
      (q) =>
        typeof q?.id === "string" &&
        (q.type === "nps" || q.type === "text") &&
        q.prompt &&
        typeof q.prompt === "object",
    )
  );
}

export async function fetchSurvey(
  feedbackUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SurveySet> {
  try {
    const res = await fetchImpl(`${feedbackUrl}/v1/survey`, { signal: AbortSignal.timeout(5000) });
    const data: unknown = res.ok ? await res.json() : null;
    return isSurveySet(data) ? data : FALLBACK_SURVEY;
  } catch {
    return FALLBACK_SURVEY;
  }
}

export async function postFeedback(
  feedbackUrl: string,
  path: string,
  payload: unknown,
): Promise<boolean> {
  try {
    const res = await fetch(`${feedbackUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function promptFor(question: SurveyQuestion, locale: string): string {
  return (
    question.prompt[locale] ??
    question.prompt.en ??
    Object.values(question.prompt)[0] ??
    question.id
  );
}
