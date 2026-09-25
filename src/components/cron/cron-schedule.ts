/**
 * Pure rules for the cron screen — preset<->expression, delivery-target string, model string,
 * relative time, state color.
 *
 * No React, no fetch. Ported directly from the desktop app's (hermes-ko-macos
 * `apps/desktop/src/app/cron`) `scheduleOptionForExpr` rule — both clients must give the same
 * answer when mapping a stored expression back to a preset (R17).
 */

import type { CronJob, CronJobState } from "@/lib/hermes/deskrpg-plugin-types";

// ---------------------------------------------------------------------------
// Schedule presets (R17)
// ---------------------------------------------------------------------------

export const SCHEDULE_PRESET_VALUES = [
  "daily",
  "weekdays",
  "weekly",
  "monthly",
  "hourly",
  "every-15-minutes",
  "custom",
] as const;

export type SchedulePresetValue = (typeof SCHEDULE_PRESET_VALUES)[number];

export type SchedulePreset = { value: SchedulePresetValue; expr?: string };

export const SCHEDULE_PRESETS: ReadonlyArray<SchedulePreset> = [
  { value: "daily", expr: "0 9 * * *" },
  { value: "weekdays", expr: "0 9 * * 1-5" },
  { value: "weekly", expr: "0 9 * * 1" },
  { value: "monthly", expr: "0 9 1 * *" },
  { value: "hourly", expr: "0 * * * *" },
  { value: "every-15-minutes", expr: "*/15 * * * *" },
  { value: "custom" },
];

const CUSTOM_PRESET: SchedulePreset = SCHEDULE_PRESETS[SCHEDULE_PRESETS.length - 1];

function presetByValue(value: SchedulePresetValue): SchedulePreset {
  return SCHEDULE_PRESETS.find((p) => p.value === value) ?? CUSTOM_PRESET;
}

/** Preset value -> the expression to store. custom has no expression, so null. */
export function exprForPreset(value: SchedulePresetValue): string | null {
  return presetByValue(value).expr ?? null;
}

function normalizeExpr(expr: string): string {
  return expr.trim().replace(/\s+/g, " ");
}

function cronParts(expr: string): string[] | null {
  const parts = normalizeExpr(expr).split(" ");
  return parts.length === 5 ? parts : null;
}

function isIntegerToken(value: string): boolean {
  return /^\d+$/.test(value);
}

/**
 * Stored expression -> reverse-mapped preset. Even if the expression isn't an exact match,
 * a matching shape counts as the same preset (e.g. `30 8 * * *` is also daily). Anything that
 * isn't a 5-field cron (a Hermes schedule string like `every 10m`, etc.) is custom.
 */
export function scheduleOptionForExpr(expr: string): SchedulePreset {
  const normalized = normalizeExpr(expr);
  const exact = SCHEDULE_PRESETS.find((p) => p.expr === normalized);
  if (exact) return exact;

  const parts = cronParts(normalized);
  if (!parts) return CUSTOM_PRESET;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const timed = isIntegerToken(minute) && isIntegerToken(hour);

  if (dayOfMonth === "*" && month === "*" && dayOfWeek === "*" && timed) {
    return presetByValue("daily");
  }
  if (dayOfMonth === "*" && month === "*" && dayOfWeek === "1-5" && timed) {
    return presetByValue("weekdays");
  }
  if (dayOfMonth === "*" && month === "*" && isIntegerToken(dayOfWeek) && timed) {
    return presetByValue("weekly");
  }
  if (month === "*" && dayOfWeek === "*" && isIntegerToken(dayOfMonth) && timed) {
    return presetByValue("monthly");
  }
  if (
    hour === "*" &&
    dayOfMonth === "*" &&
    month === "*" &&
    dayOfWeek === "*" &&
    isIntegerToken(minute)
  ) {
    return presetByValue("hourly");
  }
  return CUSTOM_PRESET;
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

function inRange(token: string, min: number, max: number): number | null {
  if (!isIntegerToken(token)) return null;
  const n = Number(token);
  return n >= min && n <= max ? n : null;
}

/**
 * The schedule in words — "매일 오후 2:00", "매주 월요일 오전 9:00" — for the shapes the preset
 * picker makes (daily, weekdays, weekly, monthly, hourly, every N minutes). Times and weekdays
 * follow the viewer's locale. Anything else returns null so the caller shows the original.
 */
export function describeSchedule(expr: string, locale: string, t: Translate): string | null {
  const parts = cronParts(expr);
  if (!parts) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  if (month !== "*") return null;
  const everyN = /^\*\/(\d+)$/.exec(minute);
  if (everyN && hour === "*" && dayOfMonth === "*" && dayOfWeek === "*") {
    const n = inRange(everyN[1], 1, 59);
    return n === null ? null : t("cron.every.minutes", { n });
  }
  const m = inRange(minute, 0, 59);
  if (m === null) return null;
  if (hour === "*" && dayOfMonth === "*" && dayOfWeek === "*")
    return t("cron.every.hourly", { minute: m });
  const h = inRange(hour, 0, 23);
  if (h === null) return null;
  // A fixed local date only carries the hour and minute into the formatter.
  const time = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(
    new Date(2023, 0, 1, h, m),
  );
  if (dayOfMonth === "*" && dayOfWeek === "*") return t("cron.every.daily", { time });
  if (dayOfMonth === "*" && dayOfWeek === "1-5") return t("cron.every.weekdays", { time });
  if (dayOfMonth === "*") {
    const dow = inRange(dayOfWeek, 0, 7);
    if (dow === null) return null;
    // 2023-01-01 was a Sunday, so day 0 (and 7) lands on Sunday.
    const day = new Intl.DateTimeFormat(locale, { weekday: "long" }).format(
      new Date(2023, 0, 1 + (dow % 7)),
    );
    return t("cron.every.weekly", { day, time });
  }
  if (dayOfWeek === "*") {
    const date = inRange(dayOfMonth, 1, 31);
    return date === null ? null : t("cron.every.monthly", { date, time });
  }
  return null;
}

/** The expression to put in the edit form from a job. Falls back to the display string when Hermes doesn't provide `expr`. */
export function jobScheduleExpr(job: Pick<CronJob, "schedule" | "schedule_display">): string {
  return job.schedule?.expr?.trim() || job.schedule_display?.trim() || "";
}

/** The schedule to show in the list. */
export function jobScheduleDisplay(job: Pick<CronJob, "schedule" | "schedule_display">): string {
  return (
    job.schedule_display?.trim() ||
    job.schedule?.display?.trim() ||
    job.schedule?.expr?.trim() ||
    "—"
  );
}

// ---------------------------------------------------------------------------
// Delivery targets (R17) — checkbox list <-> comma string
// ---------------------------------------------------------------------------

export const DEFAULT_DELIVER = "local";

export function parseDeliver(deliver: string | null | undefined): string[] {
  const ids = (deliver ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return ids.length > 0 ? Array.from(new Set(ids)) : [DEFAULT_DELIVER];
}

export function composeDeliver(ids: ReadonlyArray<string>): string {
  const clean = Array.from(new Set(ids.map((s) => s.trim()).filter((s) => s.length > 0)));
  return clean.length > 0 ? clean.join(",") : DEFAULT_DELIVER;
}

// ---------------------------------------------------------------------------
// Model (R17) — one `provider:model` string <-> the two body fields
// ---------------------------------------------------------------------------

/**
 * Splits `provider:model` only once — the model name can contain another `:`
 * (`openrouter:anthropic/claude-sonnet-4:beta`). If there's no `:`, it's model only.
 * If empty, both are null — "profile default".
 */
export function parseModelSpec(spec: string): { provider: string | null; model: string | null } {
  const trimmed = spec.trim();
  if (!trimmed) return { provider: null, model: null };
  const idx = trimmed.indexOf(":");
  if (idx < 0) return { provider: null, model: trimmed };
  const provider = trimmed.slice(0, idx).trim();
  const model = trimmed.slice(idx + 1).trim();
  return { provider: provider || null, model: model || null };
}

export function formatModelSpec(provider: string | null, model: string | null): string {
  if (!model) return "";
  return provider ? `${provider}:${model}` : model;
}

// ---------------------------------------------------------------------------
// Time (R18)
// ---------------------------------------------------------------------------

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "in 5 min" / "2 hr ago" — same rule as the desktop sidebar: a single, coarsest unit only.
 * Used together with a 1-second tick, it becomes a countdown.
 */
export function relativeTime(targetMs: number, nowMs: number, locale?: string): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  const diff = targetMs - nowMs;
  const abs = Math.abs(diff);
  const sign = diff < 0 ? -1 : 1;
  if (abs < MINUTE) return rtf.format(sign * Math.round(abs / SECOND), "second");
  if (abs < HOUR) return rtf.format(sign * Math.round(abs / MINUTE), "minute");
  if (abs < DAY) return rtf.format(sign * Math.round(abs / HOUR), "hour");
  return rtf.format(sign * Math.round(abs / DAY), "day");
}

/** ISO -> epoch ms. null if it can't be parsed. */
export function parseIsoMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** Converts the gateway's time to the browser's local time and displays it. */
export function formatLocalDateTime(iso: string | null | undefined, locale?: string): string {
  const ms = parseIsoMs(iso);
  if (ms === null) return "—";
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));
}

// ---------------------------------------------------------------------------
// State dot color
// ---------------------------------------------------------------------------

export const STATE_DOT_CLASS: Record<CronJobState, string> = {
  scheduled: "bg-success",
  running: "bg-info animate-pulse",
  paused: "bg-npc",
  error: "bg-danger",
  completed: "bg-text-dim/50",
  disabled: "bg-text-muted",
};

export function stateDotClass(state: string): string {
  return (STATE_DOT_CLASS as Record<string, string>)[state] ?? "bg-text-dim";
}

// ---------------------------------------------------------------------------
// Not-editable reason (R16)
// ---------------------------------------------------------------------------

export type ReadOnlyReason = "otherChannel" | "external";

/**
 * The reason for a job with `editable:false`. The server has already filtered the origin
 * against the gateway, so if an origin remains it's "other channel", otherwise "outside DeskRPG".
 */
export function readOnlyReason(job: {
  editable: boolean;
  origin: { channelId: string } | null;
}): ReadOnlyReason | null {
  if (job.editable) return null;
  return job.origin ? "otherChannel" : "external";
}
