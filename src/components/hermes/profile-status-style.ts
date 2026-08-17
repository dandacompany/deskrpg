// Tone→CSS class mapping for the profile status badge. Split out from
// HermesProfileList so the only thing left inside JSX is a lookup, not a
// conditional chain — this file has no external dependency so it stays trivial,
// but keeping it separate avoids re-introducing branching logic into the component
// as tones grow (mirrors the profile-status.ts convention).

import type { ProfileStatusTone } from "./profile-status";

export const PROFILE_STATUS_BADGE_CLASS: Record<ProfileStatusTone, string> = {
  ok: "border-emerald-400/40 bg-emerald-400/10 text-emerald-300",
  warn: "border-amber-400/40 bg-amber-400/10 text-amber-300",
  error: "border-danger/40 bg-danger/10 text-danger",
  unknown: "border-border bg-surface-raised text-text-muted",
};
