"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import ChatInput from "./ChatInput";
import MarkdownContent from "./ui/MarkdownContent";

export interface NpcChatMessage {
  id?: string;
  responseRequestId?: string;
  responseTransient?: boolean;
  role: "player" | "npc";
  content: string;
}

interface NpcDialogProps {
  npcName: string;
  messages: NpcChatMessage[];
  isStreaming: boolean;
  onSend: (message: string, files?: File[]) => void;
  onClose: () => void;
  // Multi-adapter
  onResetChat?: () => void;
  adapterInfo?: { type: string; model?: string };
}

const COOLDOWN_MS = 2000;

export default function NpcDialog({
  npcName,
  messages,
  isStreaming,
  onSend,
  onClose,
  onResetChat,
  adapterInfo,
}: NpcDialogProps) {
  const t = useT();
  const [cooldown, setCooldown] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // ESC to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handleSend = useCallback(
    (message: string, files?: File[]) => {
      if (cooldown || isStreaming) return;
      onSend(message, files);
      setCooldown(true);
      setTimeout(() => setCooldown(false), COOLDOWN_MS);
    },
    [cooldown, isStreaming, onSend],
  );

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 flex justify-center pointer-events-none">
      <div className="w-full max-w-[800px] pointer-events-auto">
        <div className="bg-bg border-t-2 border-x-2 border-npc rounded-t-lg shadow-2xl">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-surface rounded-t-lg">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-npc-dark flex items-center justify-center text-white font-bold text-lg">
                {npcName[0]}
              </div>
              <span className="text-npc font-bold text-lg">{npcName}</span>
            </div>
            <button
              onClick={onClose}
              className="text-text-muted hover:text-text px-2 py-1 text-sm"
              title={t("common.closeEsc")}
            >
              ESC
            </button>
          </div>

          {/* Chat messages */}
          <div ref={scrollRef} className="h-48 overflow-y-auto px-4 py-3 space-y-2">
            {messages.length === 0 && (
              <div className="text-text-dim text-sm italic">
                {t("chat.npcPlaceholder", { name: npcName })}
              </div>
            )}
            {messages.map((msg, i) => (
              <div key={i}>
                {msg.content && (
                  <div
                    className={`flex ${msg.role === "player" ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`max-w-[80%] px-3 py-2 rounded-lg text-sm ${
                        msg.role === "player"
                          ? "bg-indigo-600 text-white"
                          : "bg-surface-raised text-text"
                      }`}
                    >
                      {msg.role === "npc" ? <MarkdownContent content={msg.content} /> : msg.content}
                      {msg.role === "npc" && isStreaming && i === messages.length - 1 && (
                        <span className="inline-block w-1.5 h-4 bg-npc ml-0.5 animate-pulse" />
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Input — reuses ChatInput with file upload */}
          <ChatInput
            onSend={handleSend}
            disabled={isStreaming}
            cooldown={cooldown}
            maxLength={500}
            autoFocus
            showFileUpload
            accent="npc"
            placeholder={t("chat.npcPlaceholder", { name: npcName })}
            disabledPlaceholder={t("chat.responding")}
          />
          {/* Footer info bar — new conversation + adapter info */}
          <div className="flex items-center justify-between px-3 py-1.5 border-t border-border text-[11px] text-text-dim">
            <button
              onClick={onResetChat}
              disabled={isStreaming || !onResetChat}
              className="flex items-center gap-1 text-text-muted hover:text-npc disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              title={t("chat.newConversation")}
            >
              <span>🔄</span>
              <span>{t("chat.newConversation")}</span>
            </button>
            {adapterInfo && (
              <span className="text-text-dim">
                {adapterInfo.type === "openclaw"
                  ? "OpenClaw"
                  : adapterInfo.type.charAt(0).toUpperCase() + adapterInfo.type.slice(1)}
                {adapterInfo.model && (
                  <span className="ml-1 text-text-muted">· {adapterInfo.model}</span>
                )}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
