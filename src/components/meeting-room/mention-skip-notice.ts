// Table that picks which message to show the user for a skipped mention, by reason.
//
// This file exists not to replace a single ternary, but so that **the compiler catches it
// when a reason is added**. The original code looked like this:
//
//   const key = reason === "backend_failing" ? "...backendFailing" : "...quotaExhausted";
//
// This shape silently passes even if a third reason (e.g. "seat_vacated") is added to the
// union, and displays it as "ran out of speaking quota" — flattening, at the last step, a
// distinction the engine went to the trouble of sending. `satisfies Record<MentionSkipReason, string>`
// raises a type error the moment that happens.
//
// The message text itself isn't here. Neither the engine nor the server produces the text —
// they only carry (npcId, reason); displaying it is the job of the i18n locales (ko/ja/zh/en).

import type { MentionSkipReason } from "@/lib/conversation/floor-controller";

export const MENTION_SKIP_I18N_KEY = {
  quota_exhausted: "meeting.mentionSkipped.quotaExhausted",
  backend_failing: "meeting.mentionSkipped.backendFailing",
} as const satisfies Record<MentionSkipReason, string>;

export function mentionSkipI18nKey(reason: MentionSkipReason): string {
  return MENTION_SKIP_I18N_KEY[reason];
}
