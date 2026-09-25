import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SCHEDULE_PRESETS,
  composeDeliver,
  describeSchedule,
  exprForPreset,
  formatModelSpec,
  jobScheduleDisplay,
  jobScheduleExpr,
  parseDeliver,
  parseModelSpec,
  readOnlyReason,
  relativeTime,
  scheduleOptionForExpr,
  stateDotClass,
} from "./cron-schedule";

describe("preset <-> expression (R17)", () => {
  it("preset expressions match the spec exactly", () => {
    assert.equal(exprForPreset("daily"), "0 9 * * *");
    assert.equal(exprForPreset("weekdays"), "0 9 * * 1-5");
    assert.equal(exprForPreset("weekly"), "0 9 * * 1");
    assert.equal(exprForPreset("monthly"), "0 9 1 * *");
    assert.equal(exprForPreset("hourly"), "0 * * * *");
    assert.equal(exprForPreset("every-15-minutes"), "*/15 * * * *");
    assert.equal(exprForPreset("custom"), null);
  });

  it("preset -> expression -> preset round-trips back to itself", () => {
    for (const preset of SCHEDULE_PRESETS) {
      if (!preset.expr) continue;
      assert.equal(scheduleOptionForExpr(preset.expr).value, preset.value, preset.value);
    }
  });

  it("maps back to the same preset when the shape matches even if the time differs (desktop rule)", () => {
    assert.equal(scheduleOptionForExpr("30 8 * * *").value, "daily");
    assert.equal(scheduleOptionForExpr("0 18 * * 1-5").value, "weekdays");
    assert.equal(scheduleOptionForExpr("15 7 * * 3").value, "weekly");
    assert.equal(scheduleOptionForExpr("0 9 15 * *").value, "monthly");
    assert.equal(scheduleOptionForExpr("45 * * * *").value, "hourly");
    // Normalizes even with multiple spaces.
    assert.equal(scheduleOptionForExpr("  0   9 * *   * ").value, "daily");
  });

  it("falls back to custom when no preset matches — Hermes schedule strings, other intervals, 6-field", () => {
    assert.equal(scheduleOptionForExpr("every 10m").value, "custom");
    assert.equal(scheduleOptionForExpr("*/5 * * * *").value, "custom");
    assert.equal(scheduleOptionForExpr("0 9 * * 1,3").value, "custom");
    assert.equal(scheduleOptionForExpr("0 0 9 * * *").value, "custom");
    assert.equal(scheduleOptionForExpr("").value, "custom");
  });

  it("a job's expression and display string fill in whichever is missing", () => {
    assert.equal(
      jobScheduleExpr({ schedule: { kind: "cron", expr: "0 9 * * *" }, schedule_display: "매일" }),
      "0 9 * * *",
    );
    assert.equal(
      jobScheduleExpr({ schedule: { kind: "every" }, schedule_display: "every 10m" }),
      "every 10m",
    );
    assert.equal(
      jobScheduleDisplay({ schedule: { kind: "cron", expr: "0 9 * * *" }, schedule_display: "" }),
      "0 9 * * *",
    );
    assert.equal(jobScheduleDisplay({ schedule: { kind: "cron" }, schedule_display: "" }), "—");
  });
});

describe("delivery-target string (R17)", () => {
  it("empty/null becomes local, duplicates collapse to one", () => {
    assert.deepEqual(parseDeliver(null), ["local"]);
    assert.deepEqual(parseDeliver(""), ["local"]);
    assert.deepEqual(parseDeliver("local, slack ,slack"), ["local", "slack"]);
    assert.equal(composeDeliver([]), "local");
    assert.equal(composeDeliver(["local", "slack", " ", "slack"]), "local,slack");
  });

  it("parse -> compose round-trips", () => {
    assert.equal(composeDeliver(parseDeliver("local,telegram")), "local,telegram");
  });
});

describe("model string (R17)", () => {
  it("provider:model splits only once — a ':' inside the model is preserved", () => {
    assert.deepEqual(parseModelSpec("openrouter:anthropic/claude-sonnet-4:beta"), {
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4:beta",
    });
    assert.deepEqual(parseModelSpec("gpt-5"), { provider: null, model: "gpt-5" });
    assert.deepEqual(parseModelSpec("   "), { provider: null, model: null });
  });

  it("format <-> parse round-trips", () => {
    assert.equal(formatModelSpec("openai", "gpt-5"), "openai:gpt-5");
    assert.equal(formatModelSpec(null, "gpt-5"), "gpt-5");
    assert.equal(formatModelSpec("openai", null), "");
    const spec = "openai:gpt-5";
    const parsed = parseModelSpec(spec);
    assert.equal(formatModelSpec(parsed.provider, parsed.model), spec);
  });
});

describe("relative-time countdown (R18)", () => {
  const now = Date.UTC(2026, 8, 14, 9, 0, 0);

  it("shows a single, coarsest unit", () => {
    assert.match(relativeTime(now + 30_000, now, "en"), /30 sec/);
    assert.match(relativeTime(now + 5 * 60_000, now, "en"), /5 min/);
    assert.match(relativeTime(now + 3 * 3_600_000, now, "en"), /3 hr/);
    assert.match(relativeTime(now + 2 * 86_400_000, now, "en"), /2 days/);
  });

  it("past times show 'ago', and the Korean locale also works", () => {
    assert.match(relativeTime(now - 10 * 60_000, now, "en"), /ago/);
    assert.match(relativeTime(now + 5 * 60_000, now, "ko"), /5분/);
  });

  it("the value decreases with every 1-second tick", () => {
    const target = now + 90_000;
    const a = relativeTime(target, now, "en");
    const b = relativeTime(target, now + 60_000, "en");
    assert.notEqual(a, b);
    assert.match(b, /30 sec/);
  });
});

describe("state dot / not-editable reason (R16)", () => {
  it("all six states have a color and an unknown state is gray", () => {
    for (const state of ["scheduled", "paused", "running", "error", "completed", "disabled"]) {
      assert.ok(stateDotClass(state).startsWith("bg-"), state);
    }
    assert.equal(stateDotClass("weird"), "bg-text-dim");
  });

  it("reason for editable=false: otherChannel when origin exists, otherwise outside DeskRPG", () => {
    assert.equal(readOnlyReason({ editable: true, origin: null }), null);
    assert.equal(
      readOnlyReason({ editable: false, origin: { channelId: "other" } }),
      "otherChannel",
    );
    assert.equal(readOnlyReason({ editable: false, origin: null }), "external");
  });
});

describe("describeSchedule — the list says when a job runs in words, not as a cron expression", () => {
  const TEXT: Record<string, string> = {
    "cron.every.daily": "매일 {time}",
    "cron.every.weekdays": "평일 {time}",
    "cron.every.weekly": "매주 {day} {time}",
    "cron.every.monthly": "매월 {date}일 {time}",
    "cron.every.hourly": "매시 {minute}분",
    "cron.every.minutes": "{n}분마다",
  };
  const t = (key: string, params: Record<string, string | number> = {}) =>
    (TEXT[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(params[name]));

  // The time text itself comes from Intl, whose Korean day-period wording differs across ICU
  // versions ("오후" in browsers, "PM" in some Node builds), so the expectation uses Intl too.
  const at = (locale: string, h: number, m: number) =>
    new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(
      new Date(2023, 0, 1, h, m),
    );

  it("names the time of day in the viewer's locale", () => {
    assert.equal(describeSchedule("0 14 * * *", "ko", t), `매일 ${at("ko", 14, 0)}`);
    assert.equal(describeSchedule("30 8 * * 1-5", "ko", t), `평일 ${at("ko", 8, 30)}`);
    assert.equal(describeSchedule("0 14 * * *", "en", t), "매일 2:00 PM");
  });

  it("names the weekday and the day of the month", () => {
    assert.equal(describeSchedule("0 9 * * 1", "ko", t), `매주 월요일 ${at("ko", 9, 0)}`);
    assert.equal(describeSchedule("0 9 * * 0", "ko", t), `매주 일요일 ${at("ko", 9, 0)}`);
    assert.equal(describeSchedule("0 9 * * 7", "ko", t), `매주 일요일 ${at("ko", 9, 0)}`);
    assert.equal(describeSchedule("0 9 15 * *", "ko", t), `매월 15일 ${at("ko", 9, 0)}`);
  });

  it("covers hourly and every-N-minutes", () => {
    assert.equal(describeSchedule("5 * * * *", "ko", t), "매시 5분");
    assert.equal(describeSchedule("*/15 * * * *", "ko", t), "15분마다");
  });

  it("returns null for anything it cannot say plainly, so the caller shows the original", () => {
    for (const expr of ["0 9-17 * * *", "every 10m", "0 9 1 1 *", "", "0 25 * * *", "0 9 * * 8"])
      assert.equal(describeSchedule(expr, "ko", t), null, expr);
  });
});
