"use client";

import type { ReactNode } from "react";
import RosterAvatar from "../RosterAvatar";
import MarkdownContent from "./MarkdownContent";

/** Diameter (px) of the avatar next to a bubble. A continued bubble's empty slot uses the same width. */
export const CHAT_AVATAR_SIZE = 28;

export interface ChatBubbleProps {
  sender: "player" | "npc" | "system";
  name?: string;
  streaming?: boolean;
  /**
   * The speaker's appearance. **If passed**, a circular avatar is attached to the left of the
   * other party's bubble — if the appearance is unknown (`null`), it renders a default. If not
   * passed at all (`undefined`), there is no avatar slot in the first place.
   * My own bubble (`player`) never has an avatar either way.
   */
  avatar?: unknown;
  /** Same speaker as the immediately preceding bubble — don't repeat the avatar/name, just keep the spacing aligned. */
  continued?: boolean;
  children: ReactNode;
}

export default function ChatBubble({
  sender,
  name,
  streaming,
  avatar,
  continued = false,
  children,
}: ChatBubbleProps) {
  if (sender === "system") {
    return <div className="text-center text-text-muted text-caption italic py-1">{children}</div>;
  }

  const isPlayer = sender === "player";
  const isNpc = sender === "npc";

  const withAvatar = !isPlayer && avatar !== undefined;

  return (
    <div
      className={`flex ${isPlayer ? "justify-end" : "justify-start"} ${withAvatar ? "gap-2" : ""}`}
    >
      {withAvatar &&
        (continued ? (
          <div
            data-chat-avatar="spacer"
            aria-hidden="true"
            className="shrink-0"
            style={{ width: CHAT_AVATAR_SIZE }}
          />
        ) : (
          <div data-chat-avatar="shown" className="shrink-0 self-start">
            <RosterAvatar appearance={avatar} size={CHAT_AVATAR_SIZE} />
          </div>
        ))}
      <div
        // e2e hook. The bubble's class name alone can't identify the sender (the color utility
        // may change with a single refactor), and streaming state isn't visible from outside either.
        data-chat-bubble={sender}
        data-streaming={streaming ? "true" : "false"}
        className={`
          max-w-[85%] px-3 py-2 rounded-lg text-body
          ${isPlayer ? "bg-primary text-white" : "bg-surface-raised text-text-secondary"}
        `
          .trim()
          .replace(/\s+/g, " ")}
      >
        {!isPlayer && name && !(withAvatar && continued) && (
          <div className="text-caption font-semibold text-npc mb-0.5">{name}</div>
        )}
        {isNpc && typeof children === "string" ? <MarkdownContent content={children} /> : children}
        {streaming && (
          <span className="inline-block w-1.5 h-4 bg-npc ml-0.5 animate-pulse rounded-sm" />
        )}
      </div>
    </div>
  );
}
