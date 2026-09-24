/**
 * NPC walk speed — **shared by the whole channel** (the owner changes it in channel settings).
 *
 * Why it's not per-viewer: NPC movement isn't driven by the server but by a single browser
 * connected to the channel, which broadcasts it to the rest. If it varied per person, the
 * speed everyone sees would change depending on who happened to be driving it.
 *
 * Unit is px/s (one tile = 32px). The four kinds each map to one movement path in the code:
 * - `summon`        a call (`npc:come-to-player` → `moveTo`)
 * - `meetingSummon` a meeting call (`spatialTarget` path). Used to walk at stroll speed (55).
 * - `walk`          normal movement (returning, approaching to talk)
 * - `stroll`        wandering nearby
 */
export type NpcMotionConfig = {
  walk: number;
  stroll: number;
  summon: number;
  meetingSummon: number;
};

export const NPC_MOTION_KINDS: readonly (keyof NpcMotionConfig)[] = [
  "summon",
  "meetingSummon",
  "walk",
  "stroll",
];

/** Dante's decision (2026-09-21): summon and meeting-summon are 2x normal walk speed — they run over. */
export const DEFAULT_NPC_MOTION: NpcMotionConfig = {
  walk: 150,
  stroll: 55,
  summon: 300,
  meetingSummon: 300,
};

/**
 * Adjustable range. The floor is 1.6s per tile (any slower looks like it stopped); the
 * ceiling is 0.067s per tile — near the limit where path recalculation and collision
 * detection can still keep up without skipping a tile between frames.
 */
export const NPC_SPEED_RANGE = { min: 20, max: 480, step: 5 } as const;

/**
 * At or above this speed, the sprite is drawn running (px/s). Roughly midway between the
 * default walk speed (150) and default summon speed (300). It's split on **actual speed**
 * rather than movement kind, so if the owner lowers summon to normal walk speed, it goes
 * back to a walking sprite — a slow NPC never looks like it's running.
 */
export const RUN_SPEED_THRESHOLD = 225;

function clampSpeed(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  const clamped = Math.min(NPC_SPEED_RANGE.max, Math.max(NPC_SPEED_RANGE.min, n));
  return Math.round(clamped / NPC_SPEED_RANGE.step) * NPC_SPEED_RANGE.step;
}

/**
 * Doesn't trust a stored value (DB, socket, request body) and clamps it. If the column is
 * empty (`null`), the default is used; only the invalid entries fall back to default.
 * Unknown keys are dropped.
 */
export function normalizeNpcMotionConfig(value: unknown): NpcMotionConfig {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const d = DEFAULT_NPC_MOTION;
  return {
    walk: clampSpeed(raw.walk, d.walk),
    stroll: clampSpeed(raw.stroll, d.stroll),
    summon: clampSpeed(raw.summon, d.summon),
    meetingSummon: clampSpeed(raw.meetingSummon, d.meetingSummon),
  };
}

/** In tiles/second — easier to read on screen than px/s. */
export function tilesPerSecond(pxPerSecond: number): number {
  return Math.round((pxPerSecond / 32) * 10) / 10;
}
