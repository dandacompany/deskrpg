"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { fetchSurvey, type SurveySet } from "./feedback-client";
import { browserStorage, readSurveyState, writeSurveyState } from "./growth-storage";
import { afterSurvey, shouldShowSurvey, type SurveyOutcome } from "./survey-schedule";

const TICK_MS = 60_000;

/**
 * Accumulates usage time in 1-minute increments while the map screen is visible, and surfaces the survey when it's time.
 * Does nothing if the collection server is off or storage is unusable.
 */
export function useSurveyPrompt(feedbackUrl: string | null) {
  const [survey, setSurvey] = useState<SurveySet | null>(null);
  const [consentNeeded, setConsentNeeded] = useState(true);
  // Don't surface it again while the survey is already open.
  const openRef = useRef(false);

  useEffect(() => {
    if (!feedbackUrl) return;
    let cancelled = false;
    let fetching = false;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible" || fetching || openRef.current) return;
      const storage = browserStorage();
      const state = readSurveyState(storage);
      if (!state) return;
      const next = { ...state, usageMs: state.usageMs + TICK_MS };
      writeSurveyState(storage, next);
      if (!shouldShowSurvey(next, Date.now())) return;
      fetching = true;
      void fetchSurvey(feedbackUrl).then((set) => {
        fetching = false;
        if (cancelled) return;
        openRef.current = true;
        setConsentNeeded(next.consent !== "granted");
        setSurvey(set);
      });
    }, TICK_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [feedbackUrl]);

  const finish = useCallback(
    (outcome: SurveyOutcome) => {
      const storage = browserStorage();
      const state = readSurveyState(storage);
      if (state)
        writeSurveyState(
          storage,
          afterSurvey(state, outcome, Date.now(), survey?.intervalDays ?? 30),
        );
      openRef.current = false;
      setSurvey(null);
    },
    [survey],
  );

  return { survey, consentNeeded, finish };
}
