/**
 * "who this person is," prepended to every conversation sent to an employee (spec 2026-09-18).
 *
 * Not a system prompt — it's a **message prefix**, so it doesn't override the SOUL in a Hermes
 * profile. This file holds only pure functions. Where to attach it is decided by the caller
 * (socket handler·open-chat runtime·kanban routes).
 */
import { BIO_MAX_LENGTH } from "@/lib/my-character-limits";

export type UserContext = { name: string; bio: string | null };

const HEADER = "[대화 상대]";

/**
 * Folds into one line. `\r`, U+2028, and U+2029 are also treated as newlines — a newline left
 * in a name or bio could forge a fake `[대화 상대]` header or an instruction-looking line.
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

export function formatUserContext(ctx: UserContext): string {
  const name = foldLine(ctx.name);
  const bio = foldBio(ctx.bio);
  return bio ? `${HEADER} 이름: ${name} · 소개: ${bio}` : `${HEADER} 이름: ${name}`;
}

export function prefixUserContext(prompt: string, ctx: UserContext | null | undefined): string {
  if (!ctx || !ctx.name) return prompt;
  return `${formatUserContext(ctx)}\n\n${prompt}`;
}

export function requesterLine(ctx: UserContext): string {
  const name = foldLine(ctx.name);
  const bio = foldBio(ctx.bio);
  return bio ? `요청자: ${name} — ${bio}` : `요청자: ${name}`;
}

/**
 * Appends a requester line to the **end** of a kanban card body — since a human reads the card,
 * the top isn't cluttered. If there's no context (no character), the body is returned as-is.
 */
export function appendRequesterLine(
  body: string | undefined,
  ctx: UserContext | null | undefined,
): string | undefined {
  if (!ctx || !ctx.name) return body;
  // Only trailing whitespace is trimmed — leading indentation in the body (e.g. code blocks) is left exactly as the user wrote it.
  const head = (body ?? "").trimEnd();
  const line = requesterLine(ctx);
  return head ? `${head}\n\n${line}` : line;
}
