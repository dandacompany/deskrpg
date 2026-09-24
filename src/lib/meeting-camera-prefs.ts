/**
 * Meeting camera direction settings — these differ **per viewer** (personal preference).
 * So they live in this browser's `localStorage` rather than the DB, and changes apply
 * immediately with no save button.
 *
 * Values that must be the same across a whole channel (NPC walk speed) do not belong
 * here — NPC movement is driven and broadcast by one browser, so if it varied per person,
 * the speed everyone sees would depend on whoever happens to be driving it.
 */

/**
 * How tight to frame the speaker. `face` is chest-up; `upperBody` is upper body, but pulls
 * in to chest-up if a neighbor would otherwise be in frame. `table` keeps the whole table
 * in frame and only rotates toward the speaker. */
export type MeetingSpeakerFraming = "face" | "upperBody" | "fullBody" | "table";
export const MEETING_SPEAKER_FRAMINGS: readonly MeetingSpeakerFraming[] = [
  "face",
  "upperBody",
  "fullBody",
  "table",
];

export type MeetingCameraPrefs = {
  speakerFraming: MeetingSpeakerFraming;
  /** If the next speaker follows immediately, skip the table shot and cut straight over. */
  directHandoff: boolean;
  /** Minimum time (seconds) to hold the speaker framing. Keeps the camera from jittering on short remarks. */
  minSpeakerDwellSeconds: number;
  /** Time (seconds) to wait for the next speaker after one finishes. Past this, it returns to the table shot. */
  holdAfterSpeechSeconds: number;
};

/** Dante's decision (2026-09-21): upper body · direct handoff · 2.0s dwell · 1.5s hold (raised after feeling out short remarks). */
export const DEFAULT_MEETING_CAMERA_PREFS: MeetingCameraPrefs = {
  speakerFraming: "upperBody",
  directHandoff: true,
  minSpeakerDwellSeconds: 2,
  holdAfterSpeechSeconds: 1.5,
};

/** The adjustable range. At 0, the camera follows every short remark and becomes nauseating; too long and it misses the conversation. */
export const MEETING_DWELL_RANGE = { min: 0, max: 5, step: 0.1 } as const;

export const MEETING_CAMERA_PREFS_KEY = "deskrpg.meetingCamera.v1";

function clampSeconds(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  const clamped = Math.min(MEETING_DWELL_RANGE.max, Math.max(MEETING_DWELL_RANGE.min, n));
  return Math.round(clamped * 10) / 10;
}

/**
 * Never trusts a stored value outright — it's coerced. Even with a stale schema,
 * hand-edited values, or leftovers from a different version mixed in, the UI never
 * breaks; each field just falls back to its default individually.
 */
export function normalizeMeetingCameraPrefs(value: unknown): MeetingCameraPrefs {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const d = DEFAULT_MEETING_CAMERA_PREFS;
  return {
    speakerFraming: MEETING_SPEAKER_FRAMINGS.includes(raw.speakerFraming as MeetingSpeakerFraming)
      ? (raw.speakerFraming as MeetingSpeakerFraming)
      : d.speakerFraming,
    directHandoff: typeof raw.directHandoff === "boolean" ? raw.directHandoff : d.directHandoff,
    minSpeakerDwellSeconds: clampSeconds(raw.minSpeakerDwellSeconds, d.minSpeakerDwellSeconds),
    holdAfterSpeechSeconds: clampSeconds(raw.holdAfterSpeechSeconds, d.holdAfterSpeechSeconds),
  };
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function storage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    // In private-browsing mode or with site data blocked, even accessing this throws.
    return null;
  }
}

export function loadMeetingCameraPrefs(store: StorageLike | null = storage()): MeetingCameraPrefs {
  if (!store) return DEFAULT_MEETING_CAMERA_PREFS;
  try {
    const raw = store.getItem(MEETING_CAMERA_PREFS_KEY);
    return normalizeMeetingCameraPrefs(raw ? JSON.parse(raw) : null);
  } catch {
    return DEFAULT_MEETING_CAMERA_PREFS;
  }
}

/** Does not throw on a save failure — it still applies for this session, and just falls back to defaults next time. */
export function saveMeetingCameraPrefs(
  prefs: MeetingCameraPrefs,
  store: StorageLike | null = storage(),
): MeetingCameraPrefs {
  const normalized = normalizeMeetingCameraPrefs(prefs);
  try {
    store?.setItem(MEETING_CAMERA_PREFS_KEY, JSON.stringify(normalized));
  } catch {
    // Storage is full or blocked.
  }
  return normalized;
}
