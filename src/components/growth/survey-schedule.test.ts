import assert from "node:assert/strict";
import test from "node:test";

import {
  afterSurvey,
  DAY,
  FIRST_SURVEY_AFTER_MS,
  initialSurveyState,
  shouldShowSurvey,
} from "./survey-schedule";

test("the first survey only shows up after 30 minutes of cumulative map usage", () => {
  const s = initialSurveyState();
  assert.equal(shouldShowSurvey({ ...s, usageMs: FIRST_SURVEY_AFTER_MS - 1 }, 0), false);
  assert.equal(shouldShowSurvey({ ...s, usageMs: FIRST_SURVEY_AFTER_MS }, 0), true);
});

test("sending waits for the survey set's interval, later waits 7 days, and never-ask-again never shows again", () => {
  const base = { ...initialSurveyState(), usageMs: FIRST_SURVEY_AFTER_MS };
  const sent = afterSurvey(base, "sent", 1000, 30);
  assert.equal(sent.consent, "granted");
  assert.equal(shouldShowSurvey(sent, 1000 + 30 * DAY - 1), false);
  assert.equal(shouldShowSurvey(sent, 1000 + 30 * DAY), true);

  const later = afterSurvey(base, "later", 1000, 30);
  assert.equal(later.consent, "unknown");
  assert.equal(shouldShowSurvey(later, 1000 + 7 * DAY), true);

  const never = afterSurvey(base, "never", 1000, 30);
  assert.equal(never.consent, "denied");
  assert.equal(shouldShowSurvey({ ...never, usageMs: 10 * FIRST_SURVEY_AFTER_MS }, 1e15), false);
});

test("choosing later after already granting consent keeps the consent", () => {
  const granted = {
    ...initialSurveyState(),
    consent: "granted" as const,
    usageMs: FIRST_SURVEY_AFTER_MS,
  };
  assert.equal(afterSurvey(granted, "later", 0, 30).consent, "granted");
});
