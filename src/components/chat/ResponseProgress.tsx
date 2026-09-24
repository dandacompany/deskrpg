"use client";

import type { ChatResponse } from "@/lib/chat-response";
import { useT } from "@/lib/i18n";
import { isActiveChatResponse } from "@/app/game/chat-response-state";
import ChatBubble from "../ui/ChatBubble";

type Props = {
  responses: ChatResponse[];
  receipt?: boolean;
  receiptOnly?: boolean;
  /** Looks up the responding staff member's appearance — if present, an avatar attaches to the streaming bubble too. */
  avatarFor?: (who: { kind: "npc" | "user"; id?: string | null; name: string }) => unknown;
};

export default function ResponseProgress({
  responses,
  receipt = false,
  receiptOnly = false,
  avatarFor,
}: Props) {
  const t = useT();
  if (responses.length === 0) return null;
  const names = [...new Set(responses.map((response) => response.npcName))];

  return (
    <>
      {receipt && (
        <div className="mt-1 text-[11px] text-text-muted" aria-label={t("chat.responseAccepted")}>
          👌 {names.join(", ")}
        </div>
      )}
      {!receiptOnly &&
        responses.map((response) => {
          const active = isActiveChatResponse(response);
          const detail = t(`chat.responseStatus.${response.status}`);
          return (
            <div key={response.requestId} data-response-request-id={response.requestId}>
              {response.content && (
                <ChatBubble
                  sender="npc"
                  name={response.npcName}
                  streaming={active}
                  avatar={
                    avatarFor
                      ? avatarFor({ kind: "npc", id: response.npcId, name: response.npcName })
                      : undefined
                  }
                >
                  {response.content}
                </ChatBubble>
              )}
              {(active || response.status === "failed" || response.status === "cancelled") && (
                <div
                  className="flex items-center gap-2 px-1 py-0.5 text-xs text-text-muted"
                  role="status"
                >
                  {active && (
                    <span className="inline-block size-1.5 rounded-full bg-amber-400 animate-pulse" />
                  )}
                  <span>
                    {response.npcName}: {detail}
                  </span>
                </div>
              )}
            </div>
          );
        })}
    </>
  );
}
