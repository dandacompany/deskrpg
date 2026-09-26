"use client";

import { useMemo } from "react";

import { useLocale, useT } from "@/lib/i18n";
import type { KanbanTimelineRun } from "@/lib/hermes/deskrpg-plugin-types";
import {
  axisLabelKind,
  axisTicks,
  barDurationMs,
  dependencyEdges,
  layoutTimeline,
  outcomeLegend,
  targetMarker,
  type OutcomeLegendEntry,
  type PositionedBar,
  type RunTone,
  type TimelineWindow,
  type WindowPreset,
} from "@/lib/timeline-layout";

import { formatElapsed } from "./kanban-view-model";

/**
 * Performance timeline — "who actually worked, and when."
 *
 * This is actuals, not a plan. Rows are workers, not cards, and each bar is one run record.
 * Drawn as inline SVG with no library.
 *
 * **A table fallback must always ship alongside it.** SVG doesn't get read as a whole by screen
 * readers and can't be scanned by keyboard. Reaching the same facts through a different path is
 * not optional.
 *
 * No zoom, minimap, or delegation connectors. Just fixed windows (today/this week) and hover
 * descriptions for now — those get added when the need arises.
 */

const ROW_LABEL_WIDTH = 96;
const LANE_HEIGHT = 14;
const LANE_GAP = 2;
const ROW_GAP = 8;
const AXIS_HEIGHT = 18;
const PLOT_WIDTH = 1000; // viewBox coordinates. CSS decides the actual width.

// `actionable` is a caution color, not a failure color — limits, blocks, and change requests are
// states where the user has something to do, and painting them red would read as "broken,"
// causing that task to be missed. `npc` (amber) is used **because there is no `warning` token** —
// `--color-warning` isn't defined in `tokens.css`, so `fill-warning` renders no color at all
// (confirmed empirically).
const TONE_CLASS: Record<RunTone, string> = {
  running: "fill-primary",
  done: "fill-success",
  failed: "fill-danger",
  actionable: "fill-npc",
  neutral: "fill-info",
  unknown: "fill-text-muted",
};

/** The legend dot must use **the same** color as the bar — otherwise the legend lies. */
const TONE_DOT: Record<RunTone, string> = {
  running: "bg-primary",
  done: "bg-success",
  failed: "bg-danger",
  actionable: "bg-npc",
  neutral: "bg-info",
  unknown: "bg-text-muted",
};

export interface KanbanTimelineProps {
  runs: readonly KanbanTimelineRun[];
  window: TimelineWindow;
  preset: WindowPreset;
  onPresetChange: (preset: WindowPreset) => void;
  now: number;
  /** Whether the plugin truncated at its cap. Drawing a truncated window as-is hides that fact. */
  truncated: boolean;
  loading: boolean;
  /** Fetch failure message. If present, shows this instead of the drawing. */
  error: string | null;
  onOpenTask: (taskId: string) => void;
  /** What sits above the drawing (the operational metrics summary). The timeline only reserves the slot without knowing its content. */
  header?: React.ReactNode;
  /**
   * The target date (`YYYY-MM-DD`) of the project this board belongs to. If `null`, the vertical
   * line is not drawn — there's no screen for creating a project yet, so having no value is the
   * default.
   *
   * **Not an optional prop.** It started with a `?`, and type checking stayed quiet even when the
   * modal only computed the value without passing it through — the actual screen showed neither
   * target date nor arrow, yet the component test passed green because it supplied the prop
   * directly. Kept required so the compiler catches an omission.
   */
  targetDate: string | null;
  /** Parent/child pairs. Only becomes an arrow when both sides are visible. Required for the same reason. */
  links: readonly { parent_id: string; child_id: string }[];
}

export default function KanbanTimeline({
  runs,
  window: win,
  preset,
  onPresetChange,
  now,
  truncated,
  loading,
  error,
  onOpenTask,
  header,
  targetDate,
  links,
}: KanbanTimelineProps) {
  const t = useT();
  const { locale } = useLocale();
  const layout = useMemo(() => layoutTimeline(runs, win, now), [runs, win, now]);
  const ticks = useMemo(() => axisTicks(win), [win]);
  const target = useMemo(() => targetMarker(targetDate, win, now), [targetDate, win, now]);
  const edges = useMemo(() => dependencyEdges(layout.rows, links ?? []), [layout.rows, links]);
  const legend = useMemo(() => outcomeLegend(layout.rows), [layout.rows]);

  // Once the window spans more than a day, hour:minute alone can't distinguish the ticks — this is
  // the bug we actually saw, where a week-long window showed all seven labels as "9:00 AM." Adding
  // the weekday to date labels is because, in a week-long window, "which one is Monday" is exactly
  // what the reader is looking for.
  const labelKind = axisLabelKind(win);
  const clock = (ms: number) =>
    labelKind === "time"
      ? new Date(ms).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
      : new Date(ms).toLocaleDateString(locale, {
          month: "numeric",
          day: "numeric",
          weekday: "short",
        });
  const stamp = (ms: number) => new Date(ms).toLocaleString(locale);

  const rowTops: number[] = [];
  let height = AXIS_HEIGHT;
  for (const row of layout.rows) {
    rowTops.push(height);
    height += row.lanes * LANE_HEIGHT + (row.lanes - 1) * LANE_GAP + ROW_GAP;
  }

  return (
    <div className="flex flex-1 flex-col overflow-auto p-2 sm:p-4">
      {header}
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <div
          className="flex overflow-hidden rounded-md border border-border"
          role="group"
          aria-label={t("kanban.timeline.range")}
        >
          {(["today", "week"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => onPresetChange(option)}
              aria-pressed={preset === option}
              className={`px-2 py-1 ${
                preset === option
                  ? "bg-primary text-white"
                  : "bg-surface-raised text-text-secondary"
              }`}
            >
              {t(`kanban.timeline.range.${option}`)}
            </button>
          ))}
        </div>
        <span className="text-text-muted">
          {stamp(win.fromMs)} — {stamp(win.toMs)}
        </span>
        {loading && <span className="text-text-dim">{t("common.loading")}</span>}
        <TargetChip target={target} />
      </div>

      <OutcomeLegend entries={legend} t={t} />

      {truncated && (
        <p className="mb-2 rounded-md bg-surface-raised px-2 py-1 text-[11px] text-text-secondary">
          {t("kanban.timeline.truncated")}
        </p>
      )}
      {layout.omitted > 0 && (
        <p className="mb-2 text-[11px] text-text-muted">
          {t("kanban.timeline.omitted", { count: layout.omitted })}
        </p>
      )}

      {error ? (
        <p className="p-4 text-sm text-danger">{error}</p>
      ) : layout.rows.length === 0 ? (
        <p className="p-8 text-center text-sm text-text-muted">{t("kanban.timeline.empty")}</p>
      ) : (
        <>
          <svg
            viewBox={`0 0 ${ROW_LABEL_WIDTH + PLOT_WIDTH} ${height}`}
            className="w-full"
            style={{ minHeight: height }}
            role="presentation"
          >
            {ticks.map((tick) => {
              const x =
                ROW_LABEL_WIDTH + ((tick - win.fromMs) / (win.toMs - win.fromMs)) * PLOT_WIDTH;
              return (
                <g key={tick}>
                  <line
                    x1={x}
                    y1={AXIS_HEIGHT - 4}
                    x2={x}
                    y2={height}
                    className="stroke-border-subtle"
                    strokeWidth={1}
                  />
                  <text x={x + 2} y={10} className="fill-text-dim" fontSize={9}>
                    {clock(tick)}
                  </text>
                </g>
              );
            })}

            {target.kind === "inWindow" && (
              <g>
                <line
                  x1={ROW_LABEL_WIDTH + target.x * PLOT_WIDTH}
                  y1={AXIS_HEIGHT - 6}
                  x2={ROW_LABEL_WIDTH + target.x * PLOT_WIDTH}
                  y2={height}
                  className="stroke-danger"
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                  data-timeline-target={new Date(target.atMs).toISOString()}
                />
                <title>{t("kanban.timeline.targetLine", { date: stamp(target.atMs) })}</title>
              </g>
            )}

            {edges.map((edge) => (
              <Arrow
                key={`${edge.parentTaskId}->${edge.childTaskId}`}
                edge={edge}
                rowTops={rowTops}
              />
            ))}

            {layout.rows.map((row, rowIndex) => (
              <g key={row.profile ?? "__unknown__"}>
                <text
                  x={0}
                  y={rowTops[rowIndex] + LANE_HEIGHT - 3}
                  className="fill-text-secondary"
                  fontSize={10}
                >
                  {row.profile ?? t("kanban.timeline.unknownActor")}
                </text>
                {row.bars.map((bar) => (
                  <Bar
                    key={bar.run.id}
                    bar={bar}
                    top={rowTops[rowIndex] + bar.lane * (LANE_HEIGHT + LANE_GAP)}
                    title={barTitle(bar, { t, stamp })}
                    onOpen={() => onOpenTask(bar.run.task_id)}
                  />
                ))}
              </g>
            ))}
          </svg>

          {/*
            Table fallback. SVG doesn't get read as a whole by screen readers and can't be
            scanned by keyboard. Emits the same data in the same order — a substitute, not a summary.
          */}
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-text-secondary">
              {t("kanban.timeline.tableToggle")}
            </summary>
            <table className="mt-2 w-full text-left text-[11px]">
              <thead className="text-text-muted">
                <tr>
                  <th scope="col" className="py-1 pr-2">
                    {t("kanban.timeline.col.actor")}
                  </th>
                  <th scope="col" className="py-1 pr-2">
                    {t("kanban.timeline.col.task")}
                  </th>
                  <th scope="col" className="py-1 pr-2">
                    {t("kanban.timeline.col.start")}
                  </th>
                  <th scope="col" className="py-1 pr-2">
                    {t("kanban.timeline.col.duration")}
                  </th>
                  <th scope="col" className="py-1">
                    {t("kanban.timeline.col.outcome")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {layout.rows.flatMap((row) =>
                  row.bars.map((bar) => (
                    <tr key={bar.run.id} className="border-t border-border-subtle">
                      <td className="py-1 pr-2 text-text-secondary">
                        {row.profile ?? t("kanban.timeline.unknownActor")}
                      </td>
                      <td className="py-1 pr-2">
                        <button
                          type="button"
                          onClick={() => onOpenTask(bar.run.task_id)}
                          className="text-text underline"
                        >
                          {bar.run.task_title ?? bar.run.task_id}
                        </button>
                      </td>
                      <td className="py-1 pr-2 text-text-muted">{stamp(bar.startMs)}</td>
                      <td className="py-1 pr-2 text-text-muted">
                        {formatElapsed(Math.round(barDurationMs(bar) / 1000))}
                        {bar.open ? ` (${t("kanban.timeline.stillRunning")})` : ""}
                      </td>
                      <td className="py-1 text-text-muted">
                        {bar.run.outcome ?? t(`kanban.timeline.tone.${bar.tone}`)}
                      </td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </details>
        </>
      )}
    </div>
  );
}

/**
 * Target-date chip. If it's inside the window, just the date, since the vertical line already
 * shows it; if outside the window, shows **days remaining and direction** instead — pinning the
 * line to the window edge would make the target date look like it falls at that instant.
 */
function TargetChip({ target }: { target: ReturnType<typeof targetMarker> }) {
  const t = useT();
  const { locale } = useLocale();
  if (target.kind === "none") {
    // There's no screen for creating a project yet, so an empty target date is the default. State it quietly.
    return <span className="text-text-dim">{t("kanban.timeline.noTarget")}</span>;
  }
  const date = new Date(target.atMs).toLocaleDateString(locale);
  if (target.kind === "inWindow") {
    return <span className="text-danger">{t("kanban.timeline.target", { date })}</span>;
  }
  // Calendar days: 0 is due today (still open), negative is overdue.
  const days = target.daysFromNow;
  return (
    <span className={days <= 0 ? "text-danger" : "text-text-secondary"}>
      {days < 0
        ? t("kanban.timeline.targetPast", { date, days: -days })
        : days === 0
          ? t("kanban.timeline.targetToday", { date })
          : t("kanban.timeline.targetAhead", { date, days })}
    </span>
  );
}

/**
 * Dependency arrow. Since a parent link is also execution order (Hermes only picks up a child
 * after its parent is done), this is drawn from the parent's end to the child's start. A reversed
 * order is shown with a dashed line — it shouldn't normally happen.
 */
function Arrow({
  edge,
  rowTops,
}: {
  edge: ReturnType<typeof dependencyEdges>[number];
  rowTops: readonly number[];
}) {
  const y1 = rowTops[edge.from.row] + edge.from.lane * (LANE_HEIGHT + LANE_GAP) + LANE_HEIGHT / 2;
  const y2 = rowTops[edge.to.row] + edge.to.lane * (LANE_HEIGHT + LANE_GAP) + LANE_HEIGHT / 2;
  const x1 = ROW_LABEL_WIDTH + edge.from.x * PLOT_WIDTH;
  const x2 = ROW_LABEL_WIDTH + edge.to.x * PLOT_WIDTH;
  return (
    <line
      x1={x1}
      y1={y1}
      x2={x2}
      y2={y2}
      className={edge.outOfOrder ? "stroke-danger" : "stroke-text-dim"}
      data-timeline-edge={`${edge.parentTaskId}->${edge.childTaskId}`}
      strokeWidth={1}
      strokeDasharray={edge.outOfOrder ? "3 2" : undefined}
      opacity={0.6}
    />
  );
}

/**
 * Legend — only outcomes that **actually appear** on screen. Entry names are the raw `outcome`
 * string.
 *
 * Using a fixed tone list would flatten unknown values into a single "other" cell and lose the
 * name. In one observed case, 177 of 178 runs were `rate_limited`, which wasn't in the color
 * mapping, so it rendered gray with nowhere on screen to explain that name. Using the value itself
 * as the entry means the name is never lost even as the core adds new vocabulary.
 */
function OutcomeLegend({
  entries,
  t,
}: {
  entries: readonly OutcomeLegendEntry[];
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  if (entries.length === 0) return null;
  return (
    <ul
      className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-secondary"
      aria-label={t("kanban.timeline.legend")}
    >
      {entries.map((entry) => (
        <li key={`${entry.tone}:${entry.outcome ?? ""}`} className="flex items-center gap-1">
          <span
            aria-hidden="true"
            className={`inline-block h-2 w-2 rounded-sm ${TONE_DOT[entry.tone]}`}
          />
          <span data-timeline-legend={entry.outcome ?? entry.tone}>
            {entry.outcome ?? t(`kanban.timeline.tone.${entry.tone}`)}
          </span>
          <span className="text-text-muted">{entry.count}</span>
        </li>
      ))}
    </ul>
  );
}

function Bar({
  bar,
  top,
  title,
  onOpen,
}: {
  bar: PositionedBar;
  top: number;
  title: string;
  onOpen: () => void;
}) {
  // A run with near-zero width still needs to be visible — an invisible one-second failure is as good as not existing.
  const width = Math.max(bar.width * PLOT_WIDTH, 2);
  return (
    <g onClick={onOpen} className="cursor-pointer">
      <title>{title}</title>
      <rect
        x={ROW_LABEL_WIDTH + bar.x * PLOT_WIDTH}
        y={top}
        width={width}
        height={LANE_HEIGHT - 2}
        rx={2}
        className={TONE_CLASS[bar.tone]}
        opacity={bar.open ? 0.55 : 1}
      />
    </g>
  );
}

function barTitle(
  bar: PositionedBar,
  fmt: {
    t: (key: string, params?: Record<string, string | number>) => string;
    stamp: (ms: number) => string;
  },
): string {
  const parts = [
    bar.run.task_title ?? bar.run.task_id,
    bar.run.profile ?? fmt.t("kanban.timeline.unknownActor"),
    `${fmt.stamp(bar.startMs)} → ${bar.open ? fmt.t("kanban.timeline.stillRunning") : fmt.stamp(bar.endMs)}`,
    formatElapsed(Math.round(barDurationMs(bar) / 1000)),
  ];
  if (bar.run.outcome) parts.push(bar.run.outcome);
  if (bar.run.tenant) parts.push(bar.run.tenant);
  return parts.join(" · ");
}
