import { SkillsApiError } from "./skills-api";

type T = (key: string, params?: Record<string, string | number>) => string;

/** Server/plugin error codes that have their own message. Any other code falls back to a generic failure message. */
const KNOWN = new Set([
  "skill_changed",
  "job_busy",
  "node_changed",
  "skill_pinned",
  "forbidden",
  "skill_write_rejected",
  "path_not_editable",
  "plugin_upgrade_required",
  "timeout",
  "unreachable",
]);

/** Turns a failure into on-screen text. Unknown codes collapse to `skills.error.action` so the raw code name never leaks to the screen. */
export function skillErrorText(t: T, error: unknown): string {
  if (error instanceof SkillsApiError && KNOWN.has(error.code)) {
    return t(`skills.error.${error.code}`, { detail: error.message });
  }
  return t("skills.error.action");
}
