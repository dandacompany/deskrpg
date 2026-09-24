import { initialSurveyState, type SurveyState } from "./survey-schedule";

const KEYS = {
  seenVersion: "deskrpg.growth.seenVersion",
  starClicked: "deskrpg.growth.starClicked",
} as const;

export interface GrowthState {
  /** Whether storage is usable. If not, we don't show the red dot — it would turn back on every time. */
  ok: boolean;
  seenVersion: string | null;
  starClicked: boolean;
}

export function readGrowthState(storage: Storage | null): GrowthState {
  try {
    if (!storage) throw new Error("no storage");
    return {
      ok: true,
      seenVersion: storage.getItem(KEYS.seenVersion),
      starClicked: storage.getItem(KEYS.starClicked) === "1",
    };
  } catch {
    return { ok: false, seenVersion: null, starClicked: false };
  }
}

export function writeGrowthFlag(
  storage: Storage | null,
  key: keyof typeof KEYS,
  value: string,
): void {
  try {
    storage?.setItem(KEYS[key], value);
  } catch {
    // Private browsing mode, etc. — we just won't remember it, but behavior continues.
  }
}

export function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

const SURVEY_KEY = "deskrpg.feedback.survey";

/** Survey state. Returns null if storage is unusable — the caller then won't show the survey. */
export function readSurveyState(storage: Storage | null): SurveyState | null {
  let raw: string | null;
  try {
    if (!storage) return null;
    raw = storage.getItem(SURVEY_KEY);
  } catch {
    return null;
  }
  try {
    const v = (raw ? JSON.parse(raw) : {}) as Partial<SurveyState>;
    return {
      consent: v.consent === "granted" || v.consent === "denied" ? v.consent : "unknown",
      usageMs: typeof v.usageMs === "number" && v.usageMs >= 0 ? v.usageMs : 0,
      nextAt: typeof v.nextAt === "number" ? v.nextAt : null,
    };
  } catch {
    // A corrupted value gets counted from scratch.
    return initialSurveyState();
  }
}

export function writeSurveyState(storage: Storage | null, state: SurveyState): void {
  try {
    storage?.setItem(SURVEY_KEY, JSON.stringify(state));
  } catch {
    // We just won't remember it.
  }
}
