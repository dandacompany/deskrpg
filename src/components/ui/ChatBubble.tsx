"use client";

import type { ReactNode } from "react";
import MarkdownContent from "./MarkdownContent";

export interface ChatBubbleProps {
  sender: "player" | "npc" | "system";
  name?: string;
  streaming?: boolean;
  children: ReactNode;
}

export default function ChatBubble({ sender, name, streaming, children }: ChatBubbleProps) {
  if (sender === "system") {
    return (
      <div className="text-center text-text-muted text-caption italic py-1">
        {children}
      </div>
    );
  }

  const isPlayer = sender === "player";
  const isNpc = sender === "npc";

  return (
    <div className={`flex ${isPlayer ? "justify-end" : "justify-start"}`}>
      <div
        // e2e 훅. 말풍선은 클래스명만으로는 발신자를 구분할 수 없고(색상 유틸리티는
        // 리팩터 한 번에 바뀐다), 스트리밍 중인지도 밖에서 알 수 없다.
        data-chat-bubble={sender}
        data-streaming={streaming ? "true" : "false"}
        className={`
          max-w-[85%] px-3 py-2 rounded-lg text-body
          ${isPlayer ? "bg-primary text-white" : "bg-surface-raised text-text-secondary"}
        `.trim().replace(/\s+/g, " ")}
      >
        {!isPlayer && name && (
          <div className="text-caption font-semibold text-npc mb-0.5">{name}</div>
        )}
        {isNpc && typeof children === "string" ? (
          <MarkdownContent content={children} />
        ) : (
          children
        )}
        {streaming && (
          <span className="inline-block w-1.5 h-4 bg-npc ml-0.5 animate-pulse rounded-sm" />
        )}
      </div>
    </div>
  );
}
