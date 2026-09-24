/**
 * "who this person is," prepended to every conversation sent to an employee (spec 2026-09-18).
 *
 * Not a system prompt — it's a **message prefix**, so it doesn't override the SOUL in a Hermes
 * profile. This file holds only pure functions. Where to attach it is decided by the caller
 * (socket handler·open-chat runtime·kanban routes).
 */
import { promptLocale, type PromptLocale } from "@/lib/i18n/prompt-locale";
import { BIO_MAX_LENGTH } from "@/lib/my-character-limits";

export type UserContext = { name: string; bio: string | null };

/** Omitting `locale` keeps the original Korean wording; any other language gets the English one. */
type Locale = string | null | undefined;

const WORDS: Record<
  PromptLocale,
  { header: string; name: string; bio: string; requester: string }
> = {
  ko: { header: "[대화 상대]", name: "이름", bio: "소개", requester: "요청자" },
  en: { header: "[Conversation partner]", name: "Name", bio: "About", requester: "Requested by" },
};

/**
 * Folds into one line. `\r`, U+2028, and U+2029 are also treated as newlines — a newline left
 * in a name or bio could forge a fake conversation-partner header or an instruction-looking line.
 */
function foldLine(text: string): string {
  return text.replace(/\s*[\r\n\u2028\u2029]+\s*/g, " ").trim();
}

function foldBio(bio: string | null): string | null {
  if (!bio) return null;
  const folded = foldLine(bio);
  if (!folded) return null;
  return folded.length > BIO_MAX_LENGTH ? `${folded.slice(0, BIO_MAX_LENGTH)}…` : folded;
}

export function formatUserContext(ctx: UserContext, locale: Locale = "ko"): string {
  const w = WORDS[promptLocale(locale)];
  const name = foldLine(ctx.name);
  const bio = foldBio(ctx.bio);
  const head = `${w.header} ${w.name}: ${name}`;
  return bio ? `${head} · ${w.bio}: ${bio}` : head;
}

export function prefixUserContext(
  prompt: string,
  ctx: UserContext | null | undefined,
  locale: Locale = "ko",
): string {
  if (!ctx || !ctx.name) return prompt;
  return `${formatUserContext(ctx, locale)}\n\n${prompt}`;
}

export function requesterLine(ctx: UserContext, locale: Locale = "ko"): string {
  const label = WORDS[promptLocale(locale)].requester;
  const name = foldLine(ctx.name);
  const bio = foldBio(ctx.bio);
  return bio ? `${label}: ${name} — ${bio}` : `${label}: ${name}`;
}

/**
 * Appends a requester line to the **end** of a kanban card body — since a human reads the card,
 * the top isn't cluttered. If there's no context (no character), the body is returned as-is.
 */
export function appendRequesterLine(
  body: string | undefined,
  ctx: UserContext | null | undefined,
  locale: Locale = "ko",
): string | undefined {
  if (!ctx || !ctx.name) return body;
  // Only trailing whitespace is trimmed — leading indentation in the body (e.g. code blocks) is left exactly as the user wrote it.
  const head = (body ?? "").trimEnd();
  const line = requesterLine(ctx, locale);
  return head ? `${head}\n\n${line}` : line;
}
