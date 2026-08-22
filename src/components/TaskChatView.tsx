"use client";

import { useEffect, useRef } from "react";
import ChatInput from "./ChatInput";
import MarkdownContent from "./ui/MarkdownContent";
import { useT } from "@/lib/i18n";

export interface TaskMessage {
  role: "player" | "npc";
  content: string;
}

interface TaskChatViewProps {
  taskId: string;
  taskTitle: string;
  taskStatus: string;
  messages: TaskMessage[];
  isStreaming: boolean;
  onSend: (message: string, files?: File[]) => void;
  onBack: () => void;
}

const STATUS_BADGE: Record<string, { bg: string; text: string }> = {
  pending: { bg: "bg-text-muted/20", text: "text-text-muted" },
  in_progress: { bg: "bg-warning/20", text: "text-warning" },
  stalled: { bg: "bg-danger/20", text: "text-danger" },
  complete: { bg: "bg-success/20", text: "text-success" },
  cancelled: { bg: "bg-text-dim/20", text: "text-text-dim" },
};

export default function TaskChatView({
  taskId,
  taskTitle,
  taskStatus,
  messages,
  isStreaming,
  onSend,
  onBack,
}: TaskChatViewProps) {
  const t = useT();
  const scrollRef = useRef<HTMLDivElement>(null);
  const badge = STATUS_BADGE[taskStatus] || STATUS_BADGE.pending;

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  return (
    <div className="flex flex-col h-full">
      {/* Header: back + task title + status */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-700 bg-gray-800/50">
        <button onClick={onBack} className="text-gray-400 hover:text-white text-sm">
          ←
        </button>
        <span className="text-sm font-semibold text-amber-400 truncate flex-1">{taskTitle}</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${badge.bg} ${badge.text}`}>
          {taskStatus}
        </span>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        {messages.length === 0 && (
          <div className="text-gray-500 text-sm italic text-center py-4">
            {t("task.chatPlaceholder")}
          </div>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === "player" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[80%] px-3 py-2 rounded-lg text-sm ${
                msg.role === "player" ? "bg-indigo-600 text-white" : "bg-gray-700 text-gray-100"
              }`}
            >
              {msg.role === "npc" ? <MarkdownContent content={msg.content} /> : msg.content}
              {msg.role === "npc" && isStreaming && i === messages.length - 1 && (
                <span className="inline-block w-1.5 h-4 bg-amber-400 ml-0.5 animate-pulse rounded-sm" />
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Input */}
      <ChatInput
        onSend={onSend}
        disabled={isStreaming}
        maxLength={500}
        autoFocus
        showFileUpload
        accentColor="amber"
      />
    </div>
  );
}
