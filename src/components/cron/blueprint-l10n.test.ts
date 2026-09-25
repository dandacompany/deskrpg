import assert from "node:assert/strict";
import test from "node:test";

import type { AutomationBlueprint } from "@/lib/hermes/deskrpg-plugin-types";
import en from "@/lib/i18n/locales/en";
import ko from "@/lib/i18n/locales/ko";

import { localizeBlueprint, type Translate } from "./blueprint-l10n";

// Hermes owns the blueprint catalog (cron/blueprint_catalog.py) and serves it in English. DeskRPG
// only overlays display text by blueprint key; values sent back to Hermes (enum options, times,
// the key) never change, and a key the overlay does not know shows Hermes' own text.

const REMINDER: AutomationBlueprint = {
  key: "custom-reminder",
  title: "Custom reminder",
  description: "A recurring reminder in your own words, on your schedule.",
  category: "general",
  tags: ["reminder"],
  fields: [
    { name: "what", type: "text", label: "Remind me to…", default: "take a break and stretch" },
    {
      name: "time",
      type: "time",
      label: "What time?",
      default: "14:00",
      help: "24h local time, e.g. 08:00",
    },
    {
      name: "recurrence",
      type: "weekdays",
      label: "Repeat on",
      default: "everyday",
      options: ["everyday", "weekdays", "weekends"],
    },
    { name: "deliver", type: "enum", label: "Where to deliver?", default: "origin" },
  ],
  command: "",
  appUrl: "",
};

const translator =
  (locale: Record<string, string>): Translate =>
  (key) =>
    locale[key] || null;

test("Korean shows translated text while every value Hermes reads stays as it was", () => {
  const view = localizeBlueprint(REMINDER, translator(ko));

  assert.equal(view.key, "custom-reminder");
  assert.notEqual(view.title, REMINDER.title);
  assert.notEqual(view.description, REMINDER.description);
  assert.notEqual(view.categoryLabel, "general");
  const [what, time, recurrence, deliver] = view.fields;
  assert.notEqual(what.label, "Remind me to…");
  assert.notEqual(
    what.default,
    "take a break and stretch",
    "a text default is a prompt the user edits",
  );
  assert.equal(time.default, "14:00", "times are values, not text");
  assert.notEqual(time.help, "24h local time, e.g. 08:00");
  assert.deepEqual(recurrence.options, ["everyday", "weekdays", "weekends"]);
  assert.equal(recurrence.default, "everyday");
  assert.notEqual(recurrence.optionLabels.weekdays, "weekdays");
  assert.notEqual(deliver.label, "Where to deliver?");
  for (const text of [view.title, view.description, what.label, recurrence.optionLabels.everyday]) {
    assert.match(text, /[가-힣]/, text);
  }
});

test("English keeps Hermes' own text, so it never drifts from the catalog", () => {
  const view = localizeBlueprint(REMINDER, translator(en));

  assert.equal(view.title, REMINDER.title);
  assert.equal(view.description, REMINDER.description);
  assert.equal(view.fields[0].label, "Remind me to…");
  assert.equal(view.fields[0].default, "take a break and stretch");
  assert.equal(view.fields[2].optionLabels.weekdays, "weekdays");
});

test("a blueprint the overlay does not know falls back to Hermes' text field by field", () => {
  const unknown: AutomationBlueprint = {
    ...REMINDER,
    key: "brand-new-upstream",
    title: "Brand new",
    fields: [
      { name: "mystery", type: "text", label: "Mystery?", default: "keep me" },
      REMINDER.fields[1],
    ],
  };
  const view = localizeBlueprint(unknown, translator(ko));

  assert.equal(view.title, "Brand new");
  assert.equal(view.fields[0].label, "Mystery?");
  assert.equal(view.fields[0].default, "keep me");
  // Shared slots such as the time field are still translated.
  assert.match(view.fields[1].label, /[가-힣]/);
});

test("every blueprint of the Hermes catalog has Korean title and description", () => {
  const keys = [
    "morning-brief",
    "important-mail",
    "weekly-review",
    "workday-start",
    "custom-reminder",
    "evening-winddown",
    "news-digest",
    "bill-renewal-watch",
    "price-watch",
    "competitor-watch",
    "habit-checkin",
    "hydration-move",
    "meal-plan",
    "learn-daily",
    "gratitude-journal",
    "on-this-day",
  ];
  for (const key of keys) {
    for (const part of ["title", "description"]) {
      assert.match(
        ko[`cronBlueprint.${key}.${part}` as keyof typeof ko] ?? "",
        /[가-힣]/,
        `${key}.${part}`,
      );
      assert.equal(
        en[`cronBlueprint.${key}.${part}` as keyof typeof en],
        "",
        `en ${key}.${part} falls back`,
      );
    }
  }
});

test("the time help never promises a 24-hour input — the browser decides how times are shown", () => {
  for (const locale of [ko, en]) {
    const view = localizeBlueprint(REMINDER, translator(locale));
    const help = view.fields[1].help ?? "";
    assert.ok(help.length > 0);
    assert.doesNotMatch(help, /24/, help);
  }
});
