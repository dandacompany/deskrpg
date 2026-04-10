// src/lib/cron-parser.ts
// Minimal 5-field cron expression parser. No external dependencies.
// Fields: minute hour day-of-month month day-of-week
// Supports: *, numbers, ranges (1-5), lists (1,3,5), steps (*/15)

function parseField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    if (part === "*") {
      for (let i = min; i <= max; i++) values.add(i);
    } else if (part.includes("/")) {
      const [range, stepStr] = part.split("/");
      const step = parseInt(stepStr, 10);
      if (isNaN(step) || step <= 0) continue;
      let start = min;
      let end = max;
      if (range !== "*") {
        if (range.includes("-")) {
          [start, end] = range.split("-").map(Number);
        } else {
          start = parseInt(range, 10);
        }
      }
      for (let i = start; i <= end; i += step) values.add(i);
    } else if (part.includes("-")) {
      const [a, b] = part.split("-").map(Number);
      for (let i = a; i <= b; i++) values.add(i);
    } else {
      const n = parseInt(part, 10);
      if (!isNaN(n)) values.add(n);
    }
  }
  return values;
}

interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
}

function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Invalid cron expression: expected 5 fields, got ${parts.length}`);
  return {
    minutes: parseField(parts[0], 0, 59),
    hours: parseField(parts[1], 0, 23),
    daysOfMonth: parseField(parts[2], 1, 31),
    months: parseField(parts[3], 1, 12),
    daysOfWeek: parseField(parts[4], 0, 6), // 0 = Sunday
  };
}

/** Get local date parts in a specific timezone using Intl */
function getLocalParts(date: Date, timezone: string): { minute: number; hour: number; day: number; month: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).map((p) => [p.type, p.value]),
  );
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    minute: parseInt(parts.minute, 10),
    hour: parseInt(parts.hour, 10) % 24, // Intl may return 24 for midnight
    day: parseInt(parts.day, 10),
    month: parseInt(parts.month, 10),
    weekday: weekdayMap[parts.weekday] ?? 0,
  };
}

function cronMatchesParts(fields: CronFields, p: { minute: number; hour: number; day: number; month: number; weekday: number }): boolean {
  return (
    fields.minutes.has(p.minute) &&
    fields.hours.has(p.hour) &&
    fields.daysOfMonth.has(p.day) &&
    fields.months.has(p.month) &&
    fields.daysOfWeek.has(p.weekday)
  );
}

/** Check if the current minute matches the cron expression in the given timezone */
export function cronMatchesNow(cronExpr: string, timezone: string, now?: Date): boolean {
  const fields = parseCron(cronExpr);
  const p = getLocalParts(now ?? new Date(), timezone);
  return cronMatchesParts(fields, p);
}

/** Compute the next matching time after `after` (default: now). Scans up to 366 days. */
export function getNextCronRun(cronExpr: string, timezone: string, after?: Date): Date {
  const fields = parseCron(cronExpr);
  // Start from the next minute
  const start = new Date(after ?? new Date());
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);

  // Scan minute by minute, up to 366 days (527040 minutes)
  const maxMinutes = 366 * 24 * 60;
  const candidate = new Date(start);
  for (let i = 0; i < maxMinutes; i++) {
    const p = getLocalParts(candidate, timezone);
    if (cronMatchesParts(fields, p)) {
      return candidate;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  throw new Error(`No matching time found within 366 days for: ${cronExpr}`);
}

/** Validate a cron expression. Returns null if valid, error message if invalid. */
export function validateCronExpr(cronExpr: string): string | null {
  try {
    parseCron(cronExpr);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** Convert a cron expression to a human-readable description (Korean) */
export function cronToHumanKo(cronExpr: string): string {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return cronExpr;
  const [min, hour, dom, mon, dow] = parts;

  const dowNames = ["일", "월", "화", "수", "목", "금", "토"];

  // Common patterns
  if (dom === "*" && mon === "*" && dow === "*") {
    if (min === "0" && hour !== "*") return `매일 ${hour}시`;
    if (min !== "*" && hour !== "*") return `매일 ${hour}시 ${min}분`;
    if (min.startsWith("*/")) return `${min.split("/")[1]}분마다`;
    if (hour === "*" && min === "0") return "매시간";
  }
  if (dom === "*" && mon === "*" && dow !== "*") {
    const dayName = dowNames[parseInt(dow, 10)] || dow;
    if (min === "0" && hour !== "*") return `매주 ${dayName}요일 ${hour}시`;
    if (min !== "*" && hour !== "*") return `매주 ${dayName}요일 ${hour}시 ${min}분`;
  }
  if (dom !== "*" && mon === "*" && dow === "*") {
    if (min === "0" && hour !== "*") return `매월 ${dom}일 ${hour}시`;
  }

  return cronExpr;
}
