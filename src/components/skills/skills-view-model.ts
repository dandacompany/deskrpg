import type { SkillRow } from "@/lib/hermes/plugin-client-types";

export type SkillGroupKey = "local" | "hub" | "bundled";
const ORDER: SkillGroupKey[] = ["local", "hub", "bundled"];

function groupOf(row: SkillRow): SkillGroupKey {
  if (row.source === "hub") return "hub";
  if (row.source === "bundled" || row.source === "external") return "bundled";
  return "local";
}

export function groupSkills(
  rows: SkillRow[],
  q: string,
): { key: SkillGroupKey; rows: SkillRow[] }[] {
  const needle = q.trim().toLowerCase();
  const hit = (r: SkillRow) =>
    !needle ||
    r.name.toLowerCase().includes(needle) ||
    r.description.toLowerCase().includes(needle);
  return ORDER.map((key) => ({
    key,
    rows: rows.filter((r) => groupOf(r) === key && hit(r)),
  })).filter((g) => g.rows.length > 0);
}

export function unusedSkillNames(rows: SkillRow[]): string[] {
  return rows
    .filter(
      (r) =>
        !r.disabled &&
        !r.essential &&
        !r.pinned &&
        (r.useCount ?? 0) === 0 &&
        (r.viewCount ?? 0) === 0,
    )
    .map((r) => r.name);
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const isValidSkillName = (name: string) => NAME_RE.test(name);

/** Section headings of a new SKILL.md, in the author's language. */
export type SkillTemplateHeadings = { whenToUse: string; steps: string; check: string };

export function skillTemplate(
  name: string,
  description: string,
  headings: SkillTemplateHeadings,
): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n## ${headings.whenToUse}\n\n## ${headings.steps}\n\n1. \n\n## ${headings.check}\n`;
}
