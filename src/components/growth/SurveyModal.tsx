"use client";

import { useState } from "react";

import { APP_VERSION } from "@/lib/app-meta";
import { useT } from "@/lib/i18n";

import { getInstallId, postFeedback, promptFor, type SurveySet } from "./feedback-client";
import { browserStorage } from "./growth-storage";
import type { SurveyOutcome } from "./survey-schedule";
import { useEscapeClose } from "./use-escape-close";

export function SurveyModal({
  survey,
  locale,
  feedbackUrl,
  consentNeeded,
  onDone,
}: {
  survey: SurveySet;
  locale: string;
  feedbackUrl: string;
  consentNeeded: boolean;
  onDone: (outcome: SurveyOutcome) => void;
}) {
  const t = useT();
  // Esc counts as "later". The user can only choose "never ask again" via the button.
  useEscapeClose(() => onDone("later"));
  // The modal only renders after the user opens it, so creating the install ID here does not conflict with server rendering.
  const [installId] = useState(() => getInstallId(browserStorage()));
  const [answers, setAnswers] = useState<Record<string, number | string>>({});
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);

  const send = async () => {
    const filled = Object.fromEntries(Object.entries(answers).filter(([, v]) => v !== ""));
    setSending(true);
    setFailed(false);
    const ok =
      installId !== null &&
      (await postFeedback(feedbackUrl, "/v1/survey-responses", {
        installId,
        setVersion: survey.version,
        locale,
        appVersion: APP_VERSION,
        answers: filled,
      }));
    setSending(false);
    if (ok) onDone("sent");
    else setFailed(true);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-lg rounded-xl border border-border bg-surface shadow-2xl">
        <div className="px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-text">{t("growth.surveyTitle")}</h2>
          <p className="mt-1 text-sm text-text-secondary">{t("growth.surveyIntro")}</p>
        </div>
        <div className="px-6 py-5 space-y-5 text-sm">
          {survey.questions.map((q) => (
            <fieldset key={q.id} className="space-y-2">
              <legend className="text-text">{promptFor(q, locale)}</legend>
              {q.type === "nps" ? (
                <div className="flex flex-wrap gap-1" role="radiogroup">
                  {Array.from({ length: 11 }, (_, n) => (
                    <button
                      key={n}
                      type="button"
                      role="radio"
                      aria-checked={answers[q.id] === n}
                      onClick={() => setAnswers((a) => ({ ...a, [q.id]: n }))}
                      className={`w-8 h-8 rounded-md border text-caption ${
                        answers[q.id] === n
                          ? "bg-primary border-primary text-white"
                          : "bg-surface-raised border-border text-text-secondary hover:text-text"
                      }`}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              ) : (
                <textarea
                  rows={2}
                  maxLength={2000}
                  value={typeof answers[q.id] === "string" ? (answers[q.id] as string) : ""}
                  onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
                  className="w-full rounded-md border border-border bg-surface-raised px-2 py-1 text-text"
                />
              )}
            </fieldset>
          ))}
          {consentNeeded && (
            <p className="text-caption text-text-secondary">{t("growth.surveyConsent")}</p>
          )}
          {failed && (
            <p className="text-caption text-danger" role="alert">
              {t("growth.sendFailed")}
            </p>
          )}
        </div>
        <div className="flex flex-wrap justify-end gap-2 px-6 py-4 border-t border-border">
          <button
            onClick={() => onDone("never")}
            className="px-3 py-1.5 text-caption text-text-secondary hover:text-text"
          >
            {t("growth.surveyNever")}
          </button>
          <button
            onClick={() => onDone("later")}
            className="px-3 py-1.5 rounded-md border border-border text-caption text-text-secondary hover:text-text"
          >
            {t("growth.surveyLater")}
          </button>
          <button
            onClick={send}
            disabled={sending}
            className="px-3 py-1.5 rounded-md bg-primary hover:bg-primary-light text-white text-caption font-semibold disabled:opacity-60"
          >
            {t("growth.surveySend")}
          </button>
        </div>
      </div>
    </div>
  );
}
