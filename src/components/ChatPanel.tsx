"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import { useT } from "@/lib/i18n";
import { Pencil, UserMinus, RotateCcw, MessageSquare, ClipboardList, Undo2 } from "lucide-react";
import type { NpcChatMessage } from "./NpcDialog";
import TaskPanel from "./TaskPanel";
import ChatInput from "./ChatInput";
import Tab from "./ui/Tab";
import ChatBubble from "./ui/ChatBubble";

export interface ChannelChatMessage {
  id: string;
  sender: string;
  senderId: string;
  content: string;
  timestamp: number;
}

interface ChatPanelProps {
  dialogNpc: { npcId: string; npcName: string } | null;
  npcMessages: NpcChatMessage[];
  isNpcStreaming: boolean;
  npcChatInputDisabled?: boolean;
  npcChatDisabledPlaceholder?: string;
  onSend: (message: string, files?: File[]) => void;
  onClose: () => void;
  npcSelectList: { npcId: string; npcName: string }[] | null;
  onSelectNpc: (npcId: string, npcName: string) => void;
  isOwner?: boolean;
  onEditNpc?: (npcId: string) => void;
  onFireNpc?: (npcId: string) => void;
  onResetNpcChat?: (npcId: string) => void;
  npcMoveState?: string;
  onReturnNpc?: (npcId: string) => void;
  socket?: Socket | null;
  onDeleteTask?: (taskId: string) => void;
  onRequestReportTask?: (taskId: string) => void;
  onResumeTask?: (taskId: string) => void;
  onCompleteTask?: (taskId: string) => void;
  // Channel chat
  channelMessages: ChannelChatMessage[];
  channelChatOpen?: boolean;
  channelChatInputDisabled?: boolean;
  onSendChannelChat: (message: string) => void;
  currentPlayerName?: string;
}

const MIN_WIDTH = 250;
const MAX_WIDTH = 600;
const DEFAULT_WIDTH = 320;

export default function ChatPanel({
  dialogNpc, npcMessages, isNpcStreaming, npcChatInputDisabled, npcChatDisabledPlaceholder, onSend, onClose,
  npcSelectList, onSelectNpc, isOwner, onEditNpc, onFireNpc, onResetNpcChat,
  channelMessages, channelChatOpen, channelChatInputDisabled, onSendChannelChat, currentPlayerName,
  npcMoveState, onReturnNpc, socket, onDeleteTask, onRequestReportTask, onResumeTask, onCompleteTask,
}: ChatPanelProps) {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [manualOpen, setManualOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [showGearMenu, setShowGearMenu] = useState(false);
  const [activeTabState, setActiveTabState] = useState<{ npcId: string | null; tab: "chat" | "tasks" }>({
    npcId: null,
    tab: "chat",
  });
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const channelScrollRef = useRef<HTMLDivElement>(null);
  const activeNpcId = dialogNpc?.npcId ?? null;
  const activeTab = activeTabState.npcId === activeNpcId ? activeTabState.tab : "chat";
  const isOpen = manualOpen || !!dialogNpc || !!npcSelectList || !!channelChatOpen;

  // Auto-scroll NPC messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [npcMessages]);

  // Auto-scroll channel messages
  useEffect(() => {
    if (channelScrollRef.current) {
      channelScrollRef.current.scrollTop = channelScrollRef.current.scrollHeight;
    }
  }, [channelMessages]);

  // ESC to close NPC dialog (return to channel chat)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dialogNpc) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [dialogNpc, onClose]);

  // Drag handle
  const widthRef = useRef(width);
  useEffect(() => {
    widthRef.current = width;
  }, [width]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    const startX = e.clientX;
    const startWidth = widthRef.current;

    const handleMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - startX;
      setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + delta)));
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  }, []);

  if (!isOpen) {
    return (
      <button
        onClick={() => setManualOpen(true)}
        className="fixed left-0 top-1/2 -translate-y-1/2 z-20 bg-surface/80 hover:bg-surface-raised text-white px-1 py-4 rounded-r-lg"
        title={t("chat.openChat")}
      >
        &#9654;
      </button>
    );
  }

  const inNpcDialog = !!dialogNpc;
  const inNpcSelect = !!npcSelectList && !dialogNpc;

  return (
    <div
      ref={panelRef}
      className="fixed left-0 top-[40px] bottom-0 z-20 flex"
      style={{ width }}
    >
      {/* Panel content */}
      <div className="flex-1 flex flex-col bg-bg/95 backdrop-blur border-r border-border min-w-0">
        {/* Panel header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-surface/80">
          <button
            onClick={() => {
              if (inNpcDialog) {
                onClose(); // Return to channel chat
              } else {
                setManualOpen(false);
              }
            }}
            className="text-text-muted hover:text-text text-sm"
          >
            &#9664;
          </button>
          <span className="text-sm font-bold text-text-secondary">
            {inNpcDialog ? dialogNpc.npcName : t("chat.title")}
          </span>
          {inNpcDialog ? (
            <>
            {npcMoveState === "waiting" && onReturnNpc && (
              <button
                onClick={() => onReturnNpc(dialogNpc!.npcId)}
                className="text-xs px-2 py-1 rounded bg-surface-raised hover:brightness-125 text-npc font-medium"
                title={t("chat.returnNpcToOrigin")}
              >
                <Undo2 className="w-3.5 h-3.5 inline mr-1" />{t("npc.return")}
              </button>
            )}
            <div className="relative">
              <button
                onClick={() => setShowGearMenu(!showGearMenu)}
                className="text-text-muted hover:text-text text-sm px-1"
                title={t("chat.options")}
              >
                &#9881;
              </button>
              {showGearMenu && (
                <div className="absolute right-0 top-full mt-1 bg-surface border border-border rounded-lg shadow-xl py-1 min-w-[140px] z-50">
                  {isOwner && (
                    <>
                      <button
                        onClick={() => { setShowGearMenu(false); onEditNpc?.(dialogNpc!.npcId); }}
                        className="w-full text-left px-3 py-2 text-sm text-text hover:bg-surface-raised"
                      >
                        <Pencil className="w-3.5 h-3.5 inline mr-1" />{t("context.edit")}
                      </button>
                      <button
                        onClick={() => { setShowGearMenu(false); onFireNpc?.(dialogNpc!.npcId); }}
                        className="w-full text-left px-3 py-2 text-sm text-danger hover:bg-surface-raised"
                      >
                        <UserMinus className="w-3.5 h-3.5 inline mr-1" />{t("context.fire")}
                      </button>
                    </>
                  )}
                  <button
                    onClick={() => { setShowGearMenu(false); onResetNpcChat?.(dialogNpc!.npcId); }}
                    className="w-full text-left px-3 py-2 text-sm text-npc hover:bg-surface-raised"
                  >
                    <RotateCcw className="w-3.5 h-3.5 inline mr-1" />{t("context.resetChat")}
                  </button>
                </div>
              )}
            </div>
            </>
          ) : (
            <div className="w-4" />
          )}
        </div>

        {/* Chat content */}
        {inNpcSelect ? (
          <div className="flex-1 flex flex-col px-3 py-4 space-y-2">
            <p className="text-sm text-text-muted mb-2">{t("chat.placeholder")}</p>
            {npcSelectList!.map((npc) => (
              <button
                key={npc.npcId}
                onClick={() => onSelectNpc(npc.npcId, npc.npcName)}
                className="w-full text-left px-4 py-3 bg-surface hover:bg-surface-raised rounded-lg text-sm font-medium text-npc transition"
              >
                {npc.npcName}
              </button>
            ))}
          </div>
        ) : inNpcDialog ? (
          // NPC dialog mode
          <>
            {/* Tab Bar */}
            <Tab
              tabs={[
                { key: "chat", label: t("chat.title"), icon: <MessageSquare className="w-3.5 h-3.5" /> },
                { key: "tasks", label: t("task.title"), icon: <ClipboardList className="w-3.5 h-3.5" /> },
              ]}
              activeKey={activeTab}
              onChange={(key) => setActiveTabState({ npcId: activeNpcId, tab: key as "chat" | "tasks" })}
            />
            {activeTab === "chat" ? (
              <>
                <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
                  {npcMessages.length === 0 && (
                    <div className="text-text-dim text-sm italic py-4">
                      {t("chat.npcPlaceholder", { name: dialogNpc!.npcName })}
                    </div>
                  )}
                  {npcMessages.map((msg, i) => (
                    <ChatBubble
                      key={i}
                      sender={msg.role === "player" ? "player" : "npc"}
                      streaming={msg.role === "npc" && isNpcStreaming && i === npcMessages.length - 1}
                    >
                      {msg.content}
                    </ChatBubble>
                  ))}
                </div>
                <ChatInput
                  onSend={onSend}
                  placeholder={t("chat.npcPlaceholder", { name: dialogNpc!.npcName })}
                  disabled={!!npcChatInputDisabled || isNpcStreaming}
                  disabledPlaceholder={npcChatInputDisabled ? (npcChatDisabledPlaceholder ?? t("chat.disconnected")) : t("chat.responding")}
                  autoFocus
                  showFileUpload
                />
              </>
            ) : (
              <TaskPanel
                npcId={dialogNpc!.npcId}
                npcName={dialogNpc!.npcName}
                socket={socket ?? null}
                onDeleteTask={onDeleteTask}
                onRequestReportTask={onRequestReportTask}
                onResumeTask={onResumeTask}
                onCompleteTask={onCompleteTask}
              />
            )}
          </>
        ) : (
          // Channel chat mode
          <>
            <div ref={channelScrollRef} className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5">
              {channelMessages.length === 0 && (
                <div className="text-text-dim text-sm italic py-4 text-center">
                  {t("chat.noMessages")}
                </div>
              )}
              {channelMessages.map((msg) => {
                const isMe = msg.sender === currentPlayerName;
                return (
                  <ChatBubble key={msg.id} sender={isMe ? "player" : "npc"} name={!isMe ? msg.sender : undefined}>
                    {msg.content}
                  </ChatBubble>
                );
              })}
            </div>
            <ChatInput onSend={onSendChannelChat} placeholder={channelChatInputDisabled ? t("chat.moveCloser") : t("chat.placeholder")} disabled={!!channelChatInputDisabled} autoFocus />
          </>
        )}
      </div>

      {/* Drag handle */}
      <div
        onMouseDown={handleMouseDown}
        className={`w-2 cursor-col-resize flex items-center justify-center hover:bg-primary/30 transition ${
          isDragging ? "bg-primary/50" : "bg-surface-raised/50"
        }`}
      >
        <div className="w-0.5 h-8 bg-text-dim rounded" />
      </div>
    </div>
  );
}

// ChatInput is now imported from shared component
