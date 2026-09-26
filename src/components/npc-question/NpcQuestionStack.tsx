"use client";
/**
 * The questions an NPC is waiting on in 1:1 chat (`deskrpg_ask_user`), as cards under the chat.
 *
 * The server sends `npc:question` to the asking user's sockets, `npc:question-answered` when any of
 * them (or the inbox) answered, and `npc:questions-closed` when the run ended. Answers go back over
 * the socket as `npc:answer`; the server checks the question is this user's.
 */
import { useEffect, useState } from "react";

import type { UserQuestion } from "@/lib/npc-question-types";
import { useT } from "@/lib/i18n";

import QuestionChoices, { type QuestionAnswerOutcome } from "./QuestionChoices";

/** The part of a socket.io client this uses — a real `Socket` fits it as-is. */
export type NpcQuestionSocket = {
  on(event: string, handler: (payload: unknown) => void): unknown;
  off(event: string, handler: (payload: unknown) => void): unknown;
  emit(event: string, payload: unknown, ack?: (reply: unknown) => void): unknown;
};

type Card = { question: UserQuestion; answered: string | null; closed: boolean };

const OUTCOMES: readonly QuestionAnswerOutcome[] = ["answered", "not_found", "invalid", "failed"];

export default function NpcQuestionStack({
  socket,
  npcId,
}: {
  socket: NpcQuestionSocket | null | undefined;
  npcId: string;
}) {
  const t = useT();
  const [cards, setCards] = useState<Card[]>([]);

  useEffect(() => {
    if (!socket) return;
    const onQuestion = (payload: unknown) => {
      const { question } = (payload ?? {}) as { question?: UserQuestion };
      if (!question?.id) return;
      setCards((prev) =>
        prev.some((c) => c.question.id === question.id)
          ? prev
          : [...prev, { question, answered: null, closed: false }],
      );
    };
    const onAnswered = (payload: unknown) => {
      const { questionId, response } = (payload ?? {}) as {
        questionId?: string;
        response?: string;
      };
      setCards((prev) =>
        prev.map((c) =>
          c.question.id === questionId ? { ...c, answered: response ?? c.answered ?? "" } : c,
        ),
      );
    };
    const onClosed = (payload: unknown) => {
      const { questionIds } = (payload ?? {}) as { questionIds?: string[] };
      const ids = new Set(questionIds ?? []);
      setCards((prev) => prev.map((c) => (ids.has(c.question.id) ? { ...c, closed: true } : c)));
    };
    socket.on("npc:question", onQuestion);
    socket.on("npc:question-answered", onAnswered);
    socket.on("npc:questions-closed", onClosed);
    return () => {
      socket.off("npc:question", onQuestion);
      socket.off("npc:question-answered", onAnswered);
      socket.off("npc:questions-closed", onClosed);
    };
  }, [socket]);

  const shown = cards.filter((c) => c.question.npcId === npcId);
  if (shown.length === 0) return null;

  const answer = (card: Card, response: string) =>
    new Promise<QuestionAnswerOutcome>((resolve) => {
      if (!socket) return resolve("failed");
      socket.emit(
        "npc:answer",
        { npcId: card.question.npcId, questionId: card.question.id, response },
        (reply) => {
          const result = (reply as { result?: string } | null)?.result;
          resolve(
            OUTCOMES.includes(result as QuestionAnswerOutcome)
              ? (result as QuestionAnswerOutcome)
              : "failed",
          );
        },
      );
    });

  return (
    <div className="flex flex-col gap-2 px-3 pb-2" data-testid="npc-questions">
      {shown.map((card) => (
        <div
          key={card.question.id}
          data-npc-question={card.question.id}
          className="rounded-lg border border-primary/40 bg-surface-raised px-3 py-2"
        >
          <div className="text-caption font-semibold text-text-muted">
            {card.question.npcName
              ? t("npcQuestion.from", { name: card.question.npcName })
              : t("attention.kind.question")}
          </div>
          <div className="mt-0.5 mb-1.5 break-words text-body text-text">
            {card.question.question}
          </div>
          <QuestionChoices
            choices={card.question.choices}
            allowOther={card.question.allowOther}
            answered={card.answered}
            closed={card.closed}
            onAnswer={(response) => answer(card, response)}
          />
        </div>
      ))}
    </div>
  );
}
