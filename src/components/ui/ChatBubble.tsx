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
