/** Pure logic for `ToolsetSkillPicker` — pinned down without a screen. */
import type { SkillRow, ToolsetRow } from "@/lib/hermes/plugin-client-types";

export function initialSelection(toolsets: ToolsetRow[], skills: SkillRow[]) {
  return {
    enabledToolsets: toolsets
      .filter((t) => t.enabled)
      .map((t) => t.name)
      .sort(),
    disabledSkills: skills
      .filter((s) => s.disabled && !s.essential)
      .map((s) => s.name)
      .sort(),
  };
}

export function toggle(list: string[], name: string, on: boolean): string[] {
  const next = new Set(list);
  if (on) next.add(name);
  else next.delete(name);
  return [...next].sort();
}

/**
 * The list after a toolset checkbox changes — carries **only names within the loaded rows**.
 * This keeps the plugin PUT from returning a 400 for `unknown toolsets` even when the parent
 * seeds from config GET's `enabledToolsets` (which can mix in MCP server names). MCP entries
 * are preserved when the plugin writes, so excluding them here doesn't make them disappear.
 */
export function toggleToolset(
  list: string[],
  name: string,
  on: boolean,
  rows: ToolsetRow[],
): string[] {
  const known = new Set(rows.map((r) => r.name));
  return toggle(list, name, on).filter((n) => known.has(n));
}

/**
 * The **disabled** list after a skill checkbox (`enabled` = on) changes — names within the
 * loaded skills, excluding essential ones. The plugin PUT rejects unknown or essential
 * skills with a 400.
 */
export function toggleSkill(
  disabled: string[],
  name: string,
  enabled: boolean,
  rows: SkillRow[],
): string[] {
  const allowed = new Set(rows.filter((r) => !r.essential).map((r) => r.name));
  return toggle(disabled, name, !enabled).filter((n) => allowed.has(n));
}

export function groupSkills(skills: SkillRow[], query: string) {
  const q = query.trim().toLowerCase();
  const hit = (s: SkillRow) => !q || `${s.name} ${s.description}`.toLowerCase().includes(q);
  const groups = new Map<string, SkillRow[]>();
  for (const skill of skills.filter(hit)) {
    const bucket = groups.get(skill.category) ?? [];
    bucket.push(skill);
    groups.set(skill.category, bucket);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, rows]) => ({ category, skills: rows }));
}

export function classifyLoad(
  bodies: Array<Record<string, unknown>>,
): "unsupported" | "error" | "ok" {
  const codes = bodies.map((b) => (typeof b.errorCode === "string" ? b.errorCode : null));
  if (codes.includes("plugin_upgrade_required")) return "unsupported";
  return codes.some((c) => c !== null) ? "error" : "ok";
}
