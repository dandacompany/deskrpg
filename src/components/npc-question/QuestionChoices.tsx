"use client";
/**
 * The answer area of an NPC's question (`deskrpg_ask_user`) — the same buttons in the 1:1 chat card
 * and the attention inbox. It holds no question state of its own beyond what it just sent: the
 * caller answers through the server and reports the outcome back.
 */
import { useState } from "react";

import { useT } from "@/lib/i18n";

export type QuestionAnswerOutcome = "answered" | "not_found" | "invalid" | "failed";

export default function QuestionChoices({
  choices,
  allowOther,
  onAnswer,
  answered = null,
  closed = false,
}: {
  choices: readonly string[];
  allowOther: boolean;
  onAnswer: (response: string) => Promise<QuestionAnswerOutcome>;
  /** Already answered elsewhere (another tab, the inbox). */
  answered?: string | null;
  /** The run ended — nobody is waiting on this any more. */
  closed?: boolean;
}) {
  const t = useT();
  const [sent, setSent] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "busy" | "gone" | "invalid" | "failed">("idle");
  const [typing, setTyping] = useState(false);
  const [other, setOther] = useState("");

  const done = answered ?? sent;
  if (done !== null)
    return (
      <p className="text-caption text-text-muted" data-question-answered>
        {t("npcQuestion.answered", { response: done })}
      </p>
    );
  if (state === "gone" || closed)
    return (
      <p className="text-caption text-text-muted" data-question-closed>
        {state === "gone" ? t("npcQuestion.gone") : t("npcQuestion.closed")}
      </p>
    );

  const send = async (response: string) => {
    const value = response.trim();
    if (!value || state === "busy") return;
    setState("busy");
    const outcome = await onAnswer(value).catch(() => "failed" as const);
    if (outcome === "answered") {
      setSent(value);
      setState("idle");
    } else setState(outcome === "not_found" ? "gone" : outcome);
  };

  return (
    <div className="flex flex-col gap-1.5" data-question-choices>
      <div className="flex flex-wrap gap-1.5">
        {choices.map((choice) => (
          <button
            key={choice}
            type="button"
            disabled={state === "busy"}
            className="rounded-md border border-border bg-surface px-2.5 py-1 text-caption font-semibold text-text hover:bg-surface-raised disabled:opacity-50"
            onClick={() => void send(choice)}
          >
            {choice}
          </button>
        ))}
        {allowOther && !typing && (
          <button
            type="button"
            data-question-other
            className="px-1 text-caption font-semibold text-primary hover:underline"
            onClick={() => setTyping(true)}
          >
            {t("npcQuestion.other")}
          </button>
        )}
      </div>
      {allowOther && typing && (
        <div className="flex items-end gap-1.5">
          <textarea
            data-question-other-input
            rows={2}
            value={other}
            onChange={(e) => setOther(e.target.value)}
            className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1 text-caption text-text"
            aria-label={t("npcQuestion.other")}
          />
          <button
            type="button"
            data-question-send
            disabled={state === "busy" || !other.trim()}
            className="rounded-md bg-primary px-2.5 py-1 text-caption font-semibold text-white disabled:opacity-50"
            onClick={() => void send(other)}
          >
            {t("npcQuestion.send")}
          </button>
        </div>
      )}
      {state === "invalid" && (
        <p className="text-caption text-danger">{t("npcQuestion.invalid")}</p>
      )}
      {state === "failed" && <p className="text-caption text-danger">{t("npcQuestion.failed")}</p>}
    </div>
  );
}
