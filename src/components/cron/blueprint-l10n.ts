/**
 * Display overlay for Hermes automation blueprints. Hermes owns the catalog
 * (`cron/blueprint_catalog.py`) and serves it in English; DeskRPG never changes it. Only the text
 * the user reads is looked up by blueprint key in the locale files (`cronBlueprint.*`), and every
 * missing entry falls back to Hermes' own text — a blueprint added upstream shows up in English
 * until it is translated. English entries are left empty on purpose so English always shows the
 * catalog as it is — except the time help, whose upstream "24h local time" contradicts the
 * browser's time picker, which may show AM/PM.
 *
 * What goes back to Hermes never changes: the key, enum options, times. A text field's default is
 * the exception — it is a starting sentence the user edits and it becomes part of the job prompt,
 * so it is shown (and sent) in the user's language.
 */
import type { AutomationBlueprint, BlueprintField } from "@/lib/hermes/deskrpg-plugin-types";

/** Translated text for a key, or null when the locale has none (missing or empty). */
export type Translate = (key: string) => string | null;

export type LocalizedBlueprintField = BlueprintField & {
  /** Display label per option value. The values themselves are what Hermes receives. */
  optionLabels: Record<string, string>;
};

export type LocalizedBlueprint = Omit<AutomationBlueprint, "fields"> & {
  categoryLabel: string;
  tagLabels: string[];
  fields: LocalizedBlueprintField[];
};

/** Option values such as "no restrictions" become key-safe slugs: `no-restrictions`. */
export function optionSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function localizeField(key: string, field: BlueprintField, tr: Translate): LocalizedBlueprintField {
  // A blueprint-specific entry first, then the entry shared by every blueprint with that slot.
  const pick = (part: string) =>
    tr(`cronBlueprint.${key}.${field.name}.${part}`) ??
    tr(`cronBlueprint.field.${field.name}.${part}`);
  const optionLabels: Record<string, string> = {};
  for (const option of field.options ?? []) {
    optionLabels[option] = tr(`cronBlueprint.option.${optionSlug(option)}`) ?? option;
  }
  const localizedDefault =
    field.type === "text" ? tr(`cronBlueprint.${key}.${field.name}.default`) : null;
  return {
    ...field,
    label: pick("label") ?? field.label,
    ...(field.help !== undefined || pick("help") ? { help: pick("help") ?? field.help } : {}),
    ...(localizedDefault ? { default: localizedDefault } : {}),
    optionLabels,
  };
}

export function localizeBlueprint(
  blueprint: AutomationBlueprint,
  tr: Translate,
): LocalizedBlueprint {
  const { key } = blueprint;
  return {
    ...blueprint,
    title: tr(`cronBlueprint.${key}.title`) ?? blueprint.title,
    description: tr(`cronBlueprint.${key}.description`) ?? blueprint.description,
    categoryLabel:
      tr(`cronBlueprint.category.${optionSlug(blueprint.category)}`) ?? blueprint.category,
    tagLabels: blueprint.tags.map((tag) => tr(`cronBlueprint.tag.${optionSlug(tag)}`) ?? tag),
    fields: blueprint.fields.map((field) => localizeField(key, field, tr)),
  };
}
