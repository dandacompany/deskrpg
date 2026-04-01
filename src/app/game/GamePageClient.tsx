"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useT, useLocale, LOCALES } from "@/lib/i18n";
import { ClipboardList, MessageSquare, Undo2, Clock, Footprints, PhoneCall, Bell, ChevronDown, UserPlus, UserMinus, Settings, Share2, LogOut, Pencil, Users, Globe, RotateCcw, Bug, Info } from "lucide-react";
import type { Socket } from "socket.io-client";
import {
  CharacterAppearance,
  LegacyCharacterAppearance,
} from "@/lib/lpc-registry";
import { compositeCharacter } from "@/lib/sprite-compositor";
import { EventBus, setPendingChannelData, type PendingChannelData } from "@/game/EventBus";
import ChatPanel, { type ChannelChatMessage } from "@/components/ChatPanel";
import MeetingRoom from "@/components/MeetingRoom";
import NpcHireModal from "@/components/NpcHireModal";
import type { NpcChatMessage } from "@/components/NpcDialog";
import PasswordModal from "@/components/PasswordModal";
import ChannelSettingsModal from "@/components/ChannelSettingsModal";
import TaskBoard from "@/components/TaskBoard";
import type { Task } from "@/components/TaskCard";
import { getLocalizedErrorMessage, getLocalizedMessage } from "@/lib/i18n/error-codes";
import { resolveNpcResponseChunk, type NpcResponsePayload } from "@/lib/npc-response-messages";
import { sanitizeNpcResponseText } from "@/lib/task-block-utils.js";

const APP_VERSION = "0.1.6";
const BUG_REPORT_BASE_URL = "https://github.com/dandacompany/deskrpg/issues/new";
const SOURCE_CODE_URL = "https://github.com/dandacompany/deskrpg";
const LICENSE_URL = `${SOURCE_CODE_URL}/blob/main/LICENSE.md`;
const THIRD_PARTY_LICENSES_URL = "/third-party-licenses.html";
const AVATAR_ASSET_CREDITS_URL = "/assets/spritesheets/CREDITS.md";
const AVATAR_ASSET_LICENSE_URL = "/assets/spritesheets/LICENSE-assets.md";
const INSTANCE_ID_STORAGE_KEY = "deskrpg.instanceId";

function GameEngineLoading() {
  const t = useT();

  return (
    <div className="fixed inset-0 bg-gray-800 flex items-center justify-center text-gray-400">
      {t("game.loadingEngine")}
    </div>
  );
}

// Import PhaserGame with SSR disabled — Phaser requires browser APIs
const PhaserGame = dynamic(() => import("@/components/PhaserGame"), {
  ssr: false,
  loading: () => <GameEngineLoading />,
});

interface Character {
  id: string;
  name: string;
  appearance: CharacterAppearance | LegacyCharacterAppearance;
}

interface GameNotification {
  id: string;
  message: string;
  timestamp: number;
  read: boolean;
}

interface ChannelInfo {
  id: string;
  name: string;
  description: string | null;
  inviteCode: string | null;
  mapData: unknown;
  mapConfig: unknown;
  isPublic: boolean;
  isMember?: boolean;
  isOwner?: boolean;
  hasGateway: boolean;
  gatewayConfig?: {
    gatewayId?: string | null;
    url?: string | null;
    token?: string | null;
    taskAutomation?: {
      autoProgressNudgeEnabled?: boolean;
      autoProgressNudgeMinutes?: number;
      reportWaitSeconds?: number;
    };
  } | null;
}

interface PendingNpcReport {
  reportId: string;
  npcId: string;
  npcName?: string;
  message: string;
  kind: string;
}

interface ChannelPlayerSummary {
  id: string;
  name: string;
  appearance: CharacterAppearance | LegacyCharacterAppearance | null;
}

type RosterActionMenu =
  | {
      type: "player";
      playerId: string;
      playerName: string;
      x: number;
      y: number;
    }
  | {
      type: "npc";
      npcId: string;
      npcName: string;
      x: number;
      y: number;
    };

type RosterActionMenuInput =
  | {
      type: "player";
      playerId: string;
      playerName: string;
    }
  | {
      type: "npc";
      npcId: string;
      npcName: string;
    };

function RosterAvatar({
  appearance,
  size = 28,
}: {
  appearance: CharacterAppearance | LegacyCharacterAppearance | null;
  size?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current || !appearance) return;

    const canvas = canvasRef.current;
    const offscreen = document.createElement("canvas");

    compositeCharacter(offscreen, appearance)
      .then(() => {
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        canvas.width = size;
        canvas.height = size;
        ctx.clearRect(0, 0, size, size);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(offscreen, 0, 128, 64, 64, 0, 0, size, size);
      })
      .catch(() => {});
  }, [appearance, size]);

  if (!appearance) {
    return (
      <div
        className="rounded-full bg-surface-raised flex items-center justify-center text-text-secondary text-micro font-bold shrink-0"
        style={{ width: size, height: size }}
      >
        ?
      </div>
    );
  }

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      className="rounded-full bg-surface-raised shrink-0"
      style={{ width: size, height: size, imageRendering: "pixelated" }}
    />
  );
}

function getSocketServerUrl(): string | undefined {
  if (typeof window === "undefined") return undefined;

  const explicitUrl = process.env.NEXT_PUBLIC_SOCKET_URL;
  if (explicitUrl) return explicitUrl;

  if (process.env.NODE_ENV !== "production") return undefined;

  const { protocol, hostname, port } = window.location;
  const currentPort = Number.parseInt(port, 10);
  if (!Number.isFinite(currentPort)) return undefined;

  return `${protocol}//${hostname}:${currentPort + 1}`;
}

export default function GamePage() {
  const t = useT();
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-gray-900 text-white">
        {t("common.loading")}
      </div>
    }>
      <GamePageInner />
    </Suspense>
  );
}

function GamePageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const t = useT();
  const { locale, setLocale } = useLocale();
  const characterId = searchParams.get("characterId");
  const channelId = searchParams.get("channelId");

  const [character, setCharacter] = useState<Character | null>(null);
  const [channel, setChannel] = useState<ChannelInfo | null>(null);
  const [spritesheetDataUrl, setSpritesheetDataUrl] = useState<string | null>(null);
  const [gameChannelData, setGameChannelData] = useState<PendingChannelData>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // playerCount is derived from channelPlayers array length
  const [socket, setSocket] = useState<Socket | null>(null);
  const [socketConnected, setSocketConnected] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [showSharePopup, setShowSharePopup] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showRosterMenu, setShowRosterMenu] = useState<"players" | "npcs" | null>(null);
  const [rosterActionMenu, setRosterActionMenu] = useState<RosterActionMenu | null>(null);
  const [mode, setMode] = useState<"office" | "meeting">("office");
  const [channelNpcs, setChannelNpcs] = useState<{ id: string; name: string; appearance: unknown }[]>([]);
  const [channelPlayers, setChannelPlayers] = useState<ChannelPlayerSummary[]>([]);

  // Ref to track current dialogNpc for use inside socket listeners (must be declared before sync effect)
  const dialogNpcRef = useRef<{ npcId: string; npcName: string } | null>(null);

  // NPC dialog state — all managed here, ChatPanel is pure display
  const [dialogNpc, setDialogNpc] = useState<{ npcId: string; npcName: string } | null>(null);
  // Keep ref in sync so socket listeners can read current value without stale closure
  useEffect(() => { dialogNpcRef.current = dialogNpc; }, [dialogNpc]);
  const [npcMessages, setNpcMessages] = useState<NpcChatMessage[]>([]);
  const [isNpcStreaming, setIsNpcStreaming] = useState(false);
  const [npcSelectList, setNpcSelectList] = useState<{ npcId: string; npcName: string }[] | null>(null);
  const [interactSelectList, setInteractSelectList] = useState<{ id: string; name: string; type: "npc" | "player" }[] | null>(null);

  // Channel chat state
  const [channelMessages, setChannelMessages] = useState<ChannelChatMessage[]>([]);
  const [channelChatOpen, setChannelChatOpen] = useState(false);
  const [channelChatInputDisabled, setChannelChatInputDisabled] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Notification state
  const [notifications, setNotifications] = useState<GameNotification[]>([]);
  const [notificationsExpanded, setNotificationsExpanded] = useState(false);
  const characterNameRef = useRef<string>("");

  // NPC greeting messages (stored until dialog opens)
  const npcGreetings = useRef<Map<string, string>>(new Map());
  const npcMessagesRef = useRef<NpcChatMessage[]>([]);
  const pendingNpcReportsRef = useRef<Map<string, PendingNpcReport>>(new Map());
  const consumedNpcReportIdsRef = useRef<Set<string>>(new Set());

  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [showChannelSettings, setShowChannelSettings] = useState(false);
  const [channelSettingsInitialTab, setChannelSettingsInitialTab] = useState<"settings" | "members" | "gateway">("settings");
  const [showTaskBoard, setShowTaskBoard] = useState(false);
  const [showAboutModal, setShowAboutModal] = useState(false);
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  const [meetingMinutesCount, setMeetingMinutesCount] = useState(0);

  // Owner & NPC management state
  const [isOwner, setIsOwner] = useState(false);
  const [showHireModal, setShowHireModal] = useState(false);
  const [placementMode, setPlacementMode] = useState(false);
  const [spawnSetMode, setSpawnSetMode] = useState(false);
  const [pendingNpc, setPendingNpc] = useState<{ presetId?: string; name: string; persona: string; appearance: unknown; direction: string; agentId?: string; agentAction?: "select" | "create"; identity?: string; soul?: string; locale?: string } | null>(null);
  const [editingNpc, setEditingNpc] = useState<{ id: string; name: string; persona: string; appearance: unknown; direction?: string; agentId?: string | null } | null>(null);
  // npcMenu removed — Edit/Fire now in ChatPanel gear menu

  // NPC context menu (right-click) state
  const [contextMenu, setContextMenu] = useState<{
    npcId: string;
    npcName: string;
    x: number;
    y: number;
    moveState: string;
  } | null>(null);

  const [npcMoveStates, setNpcMoveStates] = useState<Record<string, string>>({});
  const [npcCallers, setNpcCallers] = useState<Record<string, string>>({}); // npcId → callerSocketId

  // Ref to accumulate streaming text (avoids setState-in-effect issues)
  const streamBufferRef = useRef("");
  const socketRef = useRef<Socket | null>(null);
  // Current player position — updated from GameScene for beforeunload save
  const playerPositionRef = useRef<{ x: number; y: number } | null>(null);
  const [instanceId, setInstanceId] = useState("");
  const [debugCopied, setDebugCopied] = useState(false);

  const openChannelSettings = useCallback((initialTab: "settings" | "members" | "gateway" = "settings") => {
    setChannelSettingsInitialTab(initialTab);
    setShowChannelSettings(true);
  }, []);

  const openBugReport = useCallback(() => {
    const userAgent = typeof window !== "undefined" ? window.navigator.userAgent : "unknown";
    const body = [
      "## 문제 설명",
      "",
      "",
      "## 재현 방법",
      "",
      "",
      "## 기대 결과",
      "",
      "",
      "## 실제 결과",
      "",
      "",
      "## 디버그 정보",
      "",
      `- version: v${APP_VERSION}`,
      `- browser: ${userAgent}`,
    ].join("\n");

    const params = new URLSearchParams({
      labels: "bug-report",
      body,
    });

    window.open(`${BUG_REPORT_BASE_URL}?${params.toString()}`, "_blank", "noopener,noreferrer");
  }, []);

  const copyDebugInformation = useCallback(async () => {
    const debugInfo = [
      `version: v${APP_VERSION}`,
      `browser: ${typeof window !== "undefined" ? window.navigator.userAgent : "unknown"}`,
      `url: ${typeof window !== "undefined" ? window.location.href : "unknown"}`,
      `instanceId: ${instanceId || "unknown"}`,
      `locale: ${locale}`,
    ].join("\n");

    await navigator.clipboard.writeText(debugInfo);
    setDebugCopied(true);
    setTimeout(() => setDebugCopied(false), 2000);
  }, [instanceId, locale]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let nextId = window.localStorage.getItem(INSTANCE_ID_STORAGE_KEY);
    if (!nextId) {
      nextId = window.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      window.localStorage.setItem(INSTANCE_ID_STORAGE_KEY, nextId);
    }
    setInstanceId(nextId);
  }, []);

  // Redirect to channel select if no channelId
  useEffect(() => {
    if (!channelId && characterId) {
      router.replace(`/channels?characterId=${characterId}`);
    } else if (!channelId && !characterId) {
      router.replace("/characters");
    }
  }, [channelId, characterId, router]);

  // Track player position for beforeunload save
  useEffect(() => {
    if (!channelId) return;
    // Poll position every 15s and update ref
    const interval = setInterval(() => {
      let resolved = false;
      const handler = (data: { x: number; y: number }) => {
        resolved = true;
        EventBus.off("player-position-response", handler);
        playerPositionRef.current = data;
      };
      EventBus.on("player-position-response", handler);
      EventBus.emit("request-player-position");
      setTimeout(() => { if (!resolved) EventBus.off("player-position-response", handler); }, 500);
    }, 15000);

    // Save position on page unload (refresh, tab close)
    const handleUnload = () => {
      // EventBus is synchronous — get fresh position immediately
      let freshPos: { x: number; y: number } | null = null;
      const syncHandler = (data: { x: number; y: number }) => { freshPos = data; };
      EventBus.on("player-position-response", syncHandler);
      EventBus.emit("request-player-position");
      EventBus.off("player-position-response", syncHandler);

      const pos = freshPos ?? playerPositionRef.current;
      if (!pos) return;
      // fetch with keepalive continues after page navigation
      fetch(`/api/channels/${channelId}/save-position`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ x: Math.round(pos.x), y: Math.round(pos.y) }),
        keepalive: true,
      }).catch(() => {});
    };
    window.addEventListener("beforeunload", handleUnload);

    return () => {
      clearInterval(interval);
      window.removeEventListener("beforeunload", handleUnload);
    };
  }, [channelId]);

  const showToastNotification = useCallback((id: string, message: string) => {
    setToastMessage(message);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToastMessage(null), 4000);
    setNotifications((prev) =>
      [{ id, message, timestamp: Date.now(), read: false }, ...prev].slice(0, 20),
    );
  }, []);

  const deleteTask = useCallback((taskId: string) => {
    if (!socketRef.current?.connected) {
      showToastNotification(`task-delete-disconnected-${taskId}`, t("chat.disconnected"));
      return;
    }
    socketRef.current.emit("task:delete", { taskId });
  }, [showToastNotification, t]);

  const requestTaskReport = useCallback((taskId: string) => {
    if (!socketRef.current?.connected) {
      showToastNotification(`task-request-disconnected-${taskId}`, t("chat.disconnected"));
      return;
    }
    socketRef.current.emit("task:request-report", { taskId });
    showToastNotification(`task-request-${taskId}`, t("task.requestReportQueued"));
  }, [showToastNotification, t]);

  const resumeTask = useCallback((taskId: string) => {
    if (!socketRef.current?.connected) {
      showToastNotification(`task-resume-disconnected-${taskId}`, t("chat.disconnected"));
      return;
    }
    socketRef.current.emit("task:resume", { taskId });
    showToastNotification(`task-resume-${taskId}`, t("task.resumeQueued"));
  }, [showToastNotification, t]);

  const completeTask = useCallback((taskId: string) => {
    if (!socketRef.current?.connected) {
      showToastNotification(`task-complete-disconnected-${taskId}`, t("chat.disconnected"));
      return;
    }
    socketRef.current.emit("task:complete", { taskId });
    showToastNotification(`task-complete-${taskId}`, t("task.completeQueued"));
  }, [showToastNotification, t]);

  const refreshChannelTasks = useCallback(() => {
    if (!channelId || !socketRef.current?.connected) return;
    socketRef.current.emit("task:list", { channelId });
  }, [channelId]);

  const appendPendingReportToDialog = useCallback((npcId: string, baseMessages: NpcChatMessage[]): NpcChatMessage[] => {
    const pendingReport = pendingNpcReportsRef.current.get(npcId);
    if (!pendingReport) return baseMessages;
    const alreadyInHistory = baseMessages.some((message) =>
      message.role === "npc" && message.content === pendingReport.message,
    );
    if (consumedNpcReportIdsRef.current.has(pendingReport.reportId)) {
      pendingNpcReportsRef.current.delete(npcId);
      return baseMessages;
    }

    consumedNpcReportIdsRef.current.add(pendingReport.reportId);
    pendingNpcReportsRef.current.delete(npcId);
    socketRef.current?.emit("npc:report-consumed", { reportId: pendingReport.reportId });

    if (alreadyInHistory) {
      return baseMessages;
    }

    return [...baseMessages, { role: "npc", content: pendingReport.message } as NpcChatMessage];
  }, []);

  // Socket.io connection (dynamic import to avoid SSR window access)
  useEffect(() => {
    let socketInstance: Socket | null = null;
    let cancelled = false;

    import("socket.io-client").then(({ io }) => {
      if (cancelled) return;
      socketInstance = io(getSocketServerUrl(), {
        path: "/socket.io",
        transports: ["websocket"],
        upgrade: false,
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 500,
        reconnectionDelayMax: 3000,
        timeout: 10000,
      });
      setSocket(socketInstance);
      socketRef.current = socketInstance;
      setSocketConnected(socketInstance.connected);

      socketInstance.on("connect", () => {
        setSocketConnected(true);
        setIsNpcStreaming(false);
        if (channelId) {
          socketInstance?.emit("task:list", { channelId });
        }
      });
      socketInstance.on("disconnect", (reason: string) => {
        setSocketConnected(false);
        setIsNpcStreaming(false);
        showToastNotification("socket-disconnected", t("game.socketDisconnected", { reason }));
      });
      socketInstance.on("connect_error", (error: Error) => {
        setSocketConnected(false);
        setIsNpcStreaming(false);
        console.error("[page] socket connect_error", {
          message: error.message,
          description: "description" in error ? (error as Error & { description?: unknown }).description : undefined,
          context: "context" in error ? (error as Error & { context?: unknown }).context : undefined,
          type: "type" in error ? (error as Error & { type?: unknown }).type : undefined,
        });
        showToastNotification("socket-connect-error", t("game.socketConnectFailed"));
      });

      socketInstance.on("players:state", (data: { players: unknown[] }) => {
        setChannelPlayers([
          {
            id: "__self__",
            name: characterNameRef.current || character?.name || t("game.you"),
            appearance: character?.appearance ?? null,
          },
          ...((data.players || []) as { id: string; characterName: string; appearance?: CharacterAppearance | LegacyCharacterAppearance | null }[]).map((player) => ({
            id: player.id,
            name: player.characterName,
            appearance: player.appearance ?? null,
          })),
        ]);
      });
      socketInstance.on("player:joined", (player: { id: string; characterName: string; appearance?: CharacterAppearance | LegacyCharacterAppearance | null }) => {
        setChannelPlayers((prev) => {
          if (prev.some((existing) => existing.id === player.id)) return prev;
          return [...prev, { id: player.id, name: player.characterName, appearance: player.appearance ?? null }];
        });
      });
      socketInstance.on("player:left", ({ id }: { id: string }) => {
        setChannelPlayers((prev) => prev.filter((player) => player.id !== id));
      });

      // Channel chat history (sent on join)
      socketInstance.on("chat:history", (data: { messages: ChannelChatMessage[] }) => {
        setChannelMessages(data.messages || []);
      });

      // NPC chat history (sent on demand) — only apply if it matches the current dialog
      socketInstance.on("npc:history", (data: { npcId: string; messages: { role: string; content: string }[] }) => {
        if (!dialogNpcRef.current || dialogNpcRef.current.npcId !== data.npcId) return;
        const historyMessages = (data.messages || []).map<NpcChatMessage>((m) => ({
          role: m.role === "npc" ? "npc" : "player",
          content: m.role === "npc" ? sanitizeNpcResponseText(m.content) : m.content,
        }));
        setNpcMessages(appendPendingReportToDialog(data.npcId, historyMessages));
      });

      socketInstance.on("npc:history-append", (data: { npcId: string; message: string }) => {
        const cleaned = sanitizeNpcResponseText(data.message);
        if (!cleaned.trim()) return;
        if (dialogNpcRef.current?.npcId !== data.npcId) return;

        setNpcMessages((prev) => {
          if (prev.some((message) => message.role === "npc" && message.content === cleaned)) {
            return prev;
          }
          return [...prev, { role: "npc", content: cleaned }];
        });
      });

      // Channel chat messages
      socketInstance.on("chat:message", (msg: ChannelChatMessage) => {
        setChannelMessages((prev) => {
          const next = [...prev, msg];
          return next;
        });
        // Show speech bubble on map
        EventBus.emit("chat:bubble", { senderId: msg.senderId });
        // Add notification + toast if not from self
        if (msg.sender !== characterNameRef.current) {
          const preview = msg.content.length > 30 ? msg.content.slice(0, 30) + "..." : msg.content;
          showToastNotification(msg.id, `${msg.sender}: ${preview}`);
        }
      });

      socketInstance.on("member:kicked", () => {
        alert(t("game.removedFromChannel"));
        router.push(`/channels?characterId=${characterId}`);
      });

      socketInstance.on("channel:updated", (data: { name?: string; isPublic?: boolean }) => {
        setChannel((prev) => prev ? { ...prev, ...data } : prev);
      });

      socketInstance.on("channel:deleted", () => {
        alert(t("game.channelDeleted"));
        router.push(`/channels?characterId=${characterId}`);
      });

      socketInstance.on("channel:access-denied", (data: {
        channelId?: string;
        action?: string;
        reason?: string;
        errorCode?: string;
      }) => {
        setIsNpcStreaming(false);
        showToastNotification(
          `channel-access-denied-${data.action ?? "unknown"}-${data.reason ?? "unknown"}`,
          getLocalizedErrorMessage(t, data, "errors.forbidden"),
        );
      });

      socketInstance.on("session:kicked", (data: { reason: string }) => {
        setIsNpcStreaming(false);
        alert(getLocalizedMessage(t, data.reason, "game.sessionKicked"));
        router.push(`/channels?characterId=${characterId}`);
      });

      socketInstance.on("join-error", () => {
        setIsNpcStreaming(false);
        router.push(`/channels?characterId=${characterId}`);
      });

      // NPC movement socket events — relay to GameScene via EventBus
      socketInstance.on("npc:come-to-player", (data: { npcId: string; targetPlayerId: string }) => {
        setNpcCallers(prev => ({ ...prev, [data.npcId]: data.targetPlayerId }));
        // Only the caller runs local A* pathfinding; other clients follow npc:position-sync
        if (socketInstance && data.targetPlayerId === socketInstance.id) {
          EventBus.emit("npc:call-to-player", { npcId: data.npcId });
        }
      });

      socketInstance.on("npc:report-ready", (data: PendingNpcReport) => {
        pendingNpcReportsRef.current.set(data.npcId, data);
        if (dialogNpcRef.current?.npcId === data.npcId) {
          setNpcMessages((prev) => appendPendingReportToDialog(data.npcId, prev));
          return;
        }
        EventBus.emit("npc:call-to-player", {
          npcId: data.npcId,
          message: data.message,
          reportId: data.reportId,
          reportKind: data.kind,
          npcName: data.npcName,
          bubbleText: t("game.reportReadyBubble"),
        });
      });

      // Generic NPC chat responses should stay in the dialog.
      // Only explicit report-ready events should pull an NPC over to the player.
      socketInstance.on("npc:response-complete", () => {});

      socketInstance.on("npc:returning", (data: { npcId: string }) => {
        EventBus.emit("npc:start-return", { npcId: data.npcId });
      });

      // NPC response streaming — only process for the NPC currently in dialog
      socketInstance.on("npc:response", (data: NpcResponsePayload) => {
        const chunk = resolveNpcResponseChunk(data, t);
        // Ignore responses for NPCs not in the current dialog
        if (dialogNpcRef.current && dialogNpcRef.current.npcId !== data.npcId) return;
        if (chunk) {
          streamBufferRef.current += chunk;
          const buffered = sanitizeNpcResponseText(streamBufferRef.current, {
            stripIncompleteTail: true,
          });
          setIsNpcStreaming(true);
          setNpcMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.role === "npc") {
              const updated = [...prev];
              updated[updated.length - 1] = { role: "npc", content: buffered };
              return updated;
            }
            return [...prev, { role: "npc", content: buffered }];
          });
        }
        if (data.done) {
          setIsNpcStreaming(false);
          const cleaned = sanitizeNpcResponseText(streamBufferRef.current, {
            stripIncompleteTail: true,
          });
          setNpcMessages((prev) => {
            const lastIdx = prev.length - 1;
            if (lastIdx >= 0 && prev[lastIdx].role === "npc") {
              const updated = [...prev];
              updated[lastIdx] = { role: "npc", content: cleaned };
              return updated;
            }
            return prev;
          });
          streamBufferRef.current = "";
        }
      });

      // Task: delete
      socketInstance.on("task:deleted", ({ taskId }: { taskId: string }) => {
        setAllTasks((prev) => prev.filter((t) => t.id !== taskId));
      });

      // Task: real-time updates
      socketInstance.on("task:updated", ({ task, action }: { task: Task; action?: string }) => {
        setAllTasks((prev) => {
          const idx = prev.findIndex((t) => t.id === task.id);
          if (idx >= 0) {
            const updated = [...prev];
            updated[idx] = task;
            return updated;
          }
          return [task, ...prev];
        });

        if (action === "stalled") {
          showToastNotification(`task-stalled-${task.id}`, t("task.stalledToast", { title: task.title }));
        }
        if (action === "resume") {
          showToastNotification(`task-resume-toast-${task.id}`, t("task.resumeToast", { title: task.title }));
        }
        if (action === "complete_manual") {
          showToastNotification(`task-complete-toast-${task.id}`, t("task.completeToast", { title: task.title }));
        }
      });

      // Task: initial load — channel tasks (npcId null = channel-wide response)
      socketInstance.on("task:list-response", ({ tasks: taskList, npcId: responseNpcId }: { tasks: Task[]; npcId: string | null }) => {
        if (responseNpcId !== null) return;
        setAllTasks(taskList);
      });

      // Task: NPC broadcast remove — clean up tasks for deleted NPC
      socketInstance.on("npc:broadcast-remove", ({ npcId: removedNpcId }: { npcId: string }) => {
        setAllTasks((prev) => prev.filter((t) => t.npcId !== removedNpcId));
      });

      // Request initial task list for this channel
      if (channelId) {
        socketInstance.emit("task:list", { channelId });
      }
    });

    return () => {
      cancelled = true;
      if (socketInstance) {
        socketInstance.off("task:updated");
        socketInstance.off("task:deleted");
        socketInstance.off("task:list-response");
        socketInstance.off("npc:broadcast-remove");
        socketInstance.removeAllListeners();
        socketInstance.disconnect();
      }
      setSocket(null);
      setSocketConnected(false);
      setChannelPlayers([]);
      socketRef.current = null;
    };
  }, [appendPendingReportToDialog, channelId, character?.appearance, character?.name, characterId, router, showToastNotification, t]);

  useEffect(() => {
    if (!showTaskBoard) return;
    refreshChannelTasks();
  }, [showTaskBoard, refreshChannelTasks]);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest("[data-roster-menu-root]") && !target?.closest("[data-roster-action-menu-root]")) {
        setShowRosterMenu(null);
        setRosterActionMenu(null);
      }
    };

    window.addEventListener("mousedown", handlePointerDown);
    return () => window.removeEventListener("mousedown", handlePointerDown);
  }, []);

  // Shared dialog state reset
  const resetDialog = useCallback(() => {
    setDialogNpc(null);
    dialogNpcRef.current = null;
    setNpcMessages([]);
    npcMessagesRef.current = [];
    setIsNpcStreaming(false);
    setNpcSelectList(null);
    streamBufferRef.current = "";
  }, []);

  // Keep refs in sync with state for use in socket handlers
  useEffect(() => { npcMessagesRef.current = npcMessages; }, [npcMessages]);

  // Listen for NPC interact event from GameScene
  useEffect(() => {
    const handleNpcInteract = (data: { npcId: string; npcName: string }) => {
      resetDialog();
      // If NPC has a stored greeting, show it as the first message
      const greeting = npcGreetings.current.get(data.npcId);
      if (greeting) {
        setNpcMessages([{ role: "npc", content: greeting }]);
        npcGreetings.current.delete(data.npcId);
      }
      dialogNpcRef.current = data;
      setDialogNpc(data);
      EventBus.emit("dialog:open");
      EventBus.emit("npc:bubble-clear", { npcId: data.npcId });
      // Request NPC chat history from server
      if (socketRef.current) {
        socketRef.current.emit("npc:history", { npcId: data.npcId });
      }
    };

    const handleNpcSelect = (data: { npcs: { npcId: string; npcName: string }[] }) => {
      setNpcSelectList(data.npcs);
    };

    const handleInteractSelect = (data: { targets: { id: string; name: string; type: "npc" | "player" }[] }) => {
      setInteractSelectList(data.targets);
    };

    // NPC dialog auto-close (when walking away from NPC)
    const handleNpcDialogAutoClose = () => {
      resetDialog();
      setInteractSelectList(null);
      EventBus.emit("dialog:close");
    };

    // Channel chat input enable/disable based on player proximity
    const handleChatInputEnabled = (enabled: boolean) => {
      setChannelChatInputDisabled(!enabled);
    };

    const handlePlayerChatOpen = () => {
      resetDialog();
      setChannelChatOpen(true);
      setChannelChatInputDisabled(false);
      EventBus.emit("dialog:open");
    };

    const handleNpcAutoGreet = (data: { npcId: string; npcName: string }) => {
      const greeting = t("game.npcGreeting", { name: data.npcName });
      npcGreetings.current.set(data.npcId, greeting);
      EventBus.emit("npc:bubble", { npcId: data.npcId });
      showToastNotification(`greet-${data.npcId}-${Date.now()}`, t("game.npcGreeting", { name: data.npcName }));
    };

    const handleToastShow = (data: { message: string }) => {
      // Cancel any auto-clear timer so proximity toast persists until toast:hide
      if (toastTimerRef.current) { clearTimeout(toastTimerRef.current); toastTimerRef.current = null; }
      setToastMessage(data.message);
    };
    const handleToastHide = () => {
      if (toastTimerRef.current) { clearTimeout(toastTimerRef.current); toastTimerRef.current = null; }
      setToastMessage(null);
    };

    const handleContextMenu = (data: { npcId: string; npcName: string; screenX: number; screenY: number; moveState: string }) => {
      setContextMenu({
        npcId: data.npcId,
        npcName: data.npcName,
        x: data.screenX,
        y: data.screenY,
        moveState: data.moveState,
      });
    };

    const handleMovementStarted = (data: { npcId: string }) => {
      setNpcMoveStates(prev => ({ ...prev, [data.npcId]: "moving-to-player" }));
    };
    const handleMovementArrived = (data: {
      npcId: string;
      npcName?: string;
      reportId?: string;
      reportKind?: string;
    }) => {
      setNpcMoveStates(prev => ({ ...prev, [data.npcId]: "waiting" }));
      if (data.reportId) {
        return;
      }
      // Auto-open dialog when NPC arrives — preserve existing messages (don't resetDialog)
      if (data.npcName) {
        const nextDialogNpc = { npcId: data.npcId, npcName: data.npcName };
        dialogNpcRef.current = nextDialogNpc;
        setDialogNpc(nextDialogNpc);
        EventBus.emit("dialog:open");
        EventBus.emit("npc:bubble-clear", { npcId: data.npcId });
        // Always request history to ensure conversation is complete
        // (dialog might have been auto-closed during NPC approach, losing partial messages)
        if (socketRef.current) {
          socketRef.current.emit("npc:history", { npcId: data.npcId });
        }
      }
    };
    const handleMovementReturned = (data: { npcId: string }) => {
      setNpcMoveStates(prev => ({ ...prev, [data.npcId]: "idle" }));
      setNpcCallers(prev => { const next = { ...prev }; delete next[data.npcId]; return next; });
    };

    EventBus.on("npc:interact", handleNpcInteract);
    EventBus.on("npc:select", handleNpcSelect);
    EventBus.on("interact:select", handleInteractSelect);
    EventBus.on("npc:dialog-auto-close", handleNpcDialogAutoClose);
    EventBus.on("chat:input-enabled", handleChatInputEnabled);
    EventBus.on("player:chat-open", handlePlayerChatOpen);
    EventBus.on("npc:auto-greet", handleNpcAutoGreet);
    EventBus.on("toast:show", handleToastShow);
    EventBus.on("toast:hide", handleToastHide);
    EventBus.on("npc:context-menu", handleContextMenu);
    EventBus.on("npc:call-to-player", handleMovementStarted);
    EventBus.on("npc:movement-arrived", handleMovementArrived);
    EventBus.on("npc:movement-returned", handleMovementReturned);
    return () => {
      EventBus.off("npc:interact", handleNpcInteract);
      EventBus.off("npc:select", handleNpcSelect);
      EventBus.off("interact:select", handleInteractSelect);
      EventBus.off("npc:dialog-auto-close", handleNpcDialogAutoClose);
      EventBus.off("chat:input-enabled", handleChatInputEnabled);
      EventBus.off("player:chat-open", handlePlayerChatOpen);
      EventBus.off("npc:auto-greet", handleNpcAutoGreet);
      EventBus.off("toast:show", handleToastShow);
      EventBus.off("toast:hide", handleToastHide);
      EventBus.off("npc:context-menu", handleContextMenu);
      EventBus.off("npc:call-to-player", handleMovementStarted);
      EventBus.off("npc:movement-arrived", handleMovementArrived);
      EventBus.off("npc:movement-returned", handleMovementReturned);
    };
  }, [resetDialog, showToastNotification, t]);

  const handleDialogClose = useCallback(() => {
    resetDialog();
    EventBus.emit("dialog:close");
  }, [resetDialog]);

  const openRosterActionMenu = useCallback((
    anchorEl: HTMLElement,
    menu: RosterActionMenuInput,
  ) => {
    const rect = anchorEl.getBoundingClientRect();
    const menuWidth = 180;
    const menuHeight = 220;
    const x = Math.max(12, Math.min(rect.right + 8, window.innerWidth - menuWidth - 12));
    const y = Math.max(12, Math.min(rect.top, window.innerHeight - menuHeight - 12));
    setContextMenu(null);
    if (menu.type === "player") {
      setRosterActionMenu({ type: "player", playerId: menu.playerId, playerName: menu.playerName, x, y });
      return;
    }

    setRosterActionMenu({ type: "npc", npcId: menu.npcId, npcName: menu.npcName, x, y });
  }, []);

  const closeRosterMenus = useCallback(() => {
    setShowRosterMenu(null);
    setRosterActionMenu(null);
  }, []);

  const handleCallNpcById = useCallback((npcId: string) => {
    if (!socket) return;
    socket.emit("npc:call", { channelId, npcId });
    setContextMenu(null);
    closeRosterMenus();
  }, [socket, channelId, closeRosterMenus]);

  const handleTalkNpcById = useCallback((npcId: string, npcName: string) => {
    EventBus.emit("npc:approach-and-interact", { npcId, npcName });
    setContextMenu(null);
    closeRosterMenus();
  }, [closeRosterMenus]);

  const handleEditNpcById = useCallback((npcId: string) => {
    EventBus.emit("npc:edit", { npcId });
    setContextMenu(null);
    closeRosterMenus();
  }, [closeRosterMenus]);

  const handleResetNpcChatById = useCallback((npcId: string) => {
    if (socketRef.current) {
      socketRef.current.emit("npc:reset-chat", { npcId });
    }
    if (dialogNpcRef.current?.npcId === npcId) {
      setNpcMessages([]);
      npcMessagesRef.current = [];
    }
    setContextMenu(null);
    closeRosterMenus();
  }, [closeRosterMenus]);

  const handleFireNpcById = useCallback((npcId: string) => {
    EventBus.emit("npc:fire", { npcId });
    setContextMenu(null);
    closeRosterMenus();
  }, [closeRosterMenus]);

  const handleOpenPlayerChat = useCallback(() => {
    EventBus.emit("player:chat-open");
    closeRosterMenus();
  }, [closeRosterMenus]);

  const handleEditCharacter = useCallback(() => {
    closeRosterMenus();
    router.push(`/characters/create?editId=${characterId}`);
  }, [characterId, closeRosterMenus, router]);

  const handleStartPositionSetting = useCallback(() => {
    if (!isOwner || mode !== "office") return;
    setSpawnSetMode(true);
    closeRosterMenus();
  }, [closeRosterMenus, isOwner, mode]);

  const handleSelectNpc = useCallback((npcId: string, npcName: string) => {
    resetDialog();
    const nextDialogNpc = { npcId, npcName };
    dialogNpcRef.current = nextDialogNpc;
    setDialogNpc(nextDialogNpc);
    EventBus.emit("dialog:open");
    EventBus.emit("npc:bubble-clear", { npcId });
    if (socketRef.current) {
      socketRef.current.emit("npc:history", { npcId });
    }
  }, [resetDialog]);

  const handleDialogSend = useCallback(
    (message: string) => {
      if (!socket || !dialogNpc) return;
      if (!socket.connected) {
        showToastNotification(
          `npc-chat-disconnected-${dialogNpc.npcId}`,
          t("game.npcChatDisconnected"),
        );
        return;
      }
      // Add player message immediately
      setNpcMessages((prev) => [...prev, { role: "player", content: message }]);
      streamBufferRef.current = "";
      socket.emit("npc:chat", { npcId: dialogNpc.npcId, message });
    },
    [socket, dialogNpc, showToastNotification, t],
  );

  const handleChannelChatSend = useCallback((message: string) => {
    if (!socket || !socket.connected) {
      showToastNotification(
        "channel-chat-disconnected",
        t("game.channelChatDisconnected"),
      );
      return;
    }
    socket.emit("chat:send", { message });
  }, [socket, showToastNotification, t]);

  const handleGamePasswordSubmit = useCallback(async (password: string): Promise<string | null> => {
    if (!channelId) return t("errors.failedToJoinChannel");
    try {
      const res = await fetch(`/api/channels/${channelId}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        return getLocalizedErrorMessage(t, data, "password.wrong");
      }
      setShowPasswordModal(false);
      setLoading(true);
      // Reload channel data
      const channelRes = await fetch(`/api/channels/${channelId}`);
      if (channelRes.ok) {
        const channelData = await channelRes.json();
        setChannel(channelData.channel);
        setIsOwner(channelData.channel.isOwner || false);
      }
      setLoading(false);
      return null;
    } catch {
      return t("errors.failedToJoinChannel");
    }
  }, [channelId, t]);

  const handleCopyInvite = () => {
    if (!channel?.inviteCode) return;
    const url = `${window.location.origin}/channels/join/${channel.inviteCode}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  // Fetch character data and channel data
  useEffect(() => {
    if (!characterId) {
      setError(t("errors.noCharacterSelected"));
      setLoading(false);
      return;
    }
    if (!channelId) {
      return; // will redirect above
    }

    (async () => {
    // Fetch channel first to handle password-protected channels
    const channelRes = await fetch(`/api/channels/${channelId}`).catch(() => null);
    if (channelRes && channelRes.status === 403) {
      const data = await channelRes.json();
      if (data.errorCode === "password_required" || data.error === "password_required") {
        setShowPasswordModal(true);
        setLoading(false);
        return;
      }
    }

    Promise.all([
      fetch("/api/characters").then((res) => res.json()),
      channelRes ? channelRes.json() : fetch(`/api/channels/${channelId}`).then((res) => res.json()),
    ])
      .then(async ([charData, channelData]) => {
        // Character
        const chars: Character[] = charData.characters || [];
        const found = chars.find((c) => c.id === characterId);
        if (!found) {
          setError(t("errors.characterNotFound"));
          setLoading(false);
          return;
        }
        setCharacter(found);
        characterNameRef.current = found.name;

        // Channel
        if (channelData.error) {
          setError(t("game.channelNotFound"));
          setLoading(false);
          return;
        }
        let nextChannel = channelData.channel as ChannelInfo;

        // Auto-join public channels before downstream effects start fetching
        if (nextChannel?.isPublic && !nextChannel?.isMember && !nextChannel?.isOwner) {
          const joinRes = await fetch(`/api/channels/${channelId}/join`, { method: "POST" });
          if (!joinRes.ok) {
            const errorData = await joinRes.json().catch(() => ({}));
            throw new Error(getLocalizedErrorMessage(t, errorData, "errors.failedToLoadGameData"));
          }
          nextChannel = {
            ...nextChannel,
            isMember: true,
          };
        }

        setChannel(nextChannel);
        if (nextChannel?.isOwner) setIsOwner(true);

        // Set pending channel data for GameScene to read during create()
        // Parse mapData if it's a JSON string (SQLite stores as text)
        let rawMapData = channelData.channel.mapData;
        if (typeof rawMapData === "string") {
          try { rawMapData = JSON.parse(rawMapData); } catch { /* keep as string */ }
        }
        // Detect if mapData is actually Tiled JSON (has tiledversion field)
        const isTiledJson = rawMapData && typeof rawMapData === "object" && "tiledversion" in rawMapData;

        const nextPendingChannelData: PendingChannelData = {
          channelId: channelData.channel.id,
          mapData: isTiledJson ? null : (rawMapData || null),
          tiledJson: isTiledJson ? rawMapData : null,
          mapConfig: typeof channelData.channel.mapConfig === "string"
            ? JSON.parse(channelData.channel.mapConfig)
            : (channelData.channel.mapConfig || null),
          savedPosition: channelData.channel.lastX != null && channelData.channel.lastY != null
            ? { x: channelData.channel.lastX, y: channelData.channel.lastY }
            : null,
          reportWaitSeconds: channelData.channel.gatewayConfig?.taskAutomation?.reportWaitSeconds ?? 20,
        };
        setPendingChannelData(nextPendingChannelData);
        setGameChannelData(nextPendingChannelData);

        // Composite character sprite
        const canvas = document.createElement("canvas");
        canvasRef.current = canvas;

        try {
          await compositeCharacter(canvas, found.appearance);
          const dataUrl = canvas.toDataURL("image/png");
          setSpritesheetDataUrl(dataUrl);
        } catch (err) {
          console.error("Failed to composite character:", err);
          setError(t("errors.failedToLoadCharacterSprite"));
        }

        setLoading(false);
      })
      .catch(() => {
        setError(t("errors.failedToLoadGameData"));
        setLoading(false);
      });
    })();
  }, [characterId, channelId, t]);

  // Fetch NPCs for this channel (for meeting room)
  useEffect(() => {
    if (!channelId || (!channel?.isMember && !channel?.isOwner)) return;
    fetch(`/api/npcs?channelId=${channelId}`)
      .then(async (res) => {
        if (!res.ok) {
          const errorData = await res.json().catch(() => ({}));
          throw new Error(getLocalizedErrorMessage(t, errorData, "errors.failedToFetchNpcs"));
        }
        return res.json();
      })
      .then((data) => {
        if (data.npcs) setChannelNpcs(data.npcs);
      })
      .catch((err) => {
        console.error("Failed to fetch channel NPCs:", err);
      });
  }, [channelId, channel?.isMember, channel?.isOwner, t]);

  useEffect(() => {
    if (!channelId || (!channel?.isMember && !channel?.isOwner)) return;
    fetch(`/api/meetings?channelId=${channelId}`)
      .then(async (res) => {
        if (!res.ok) {
          const errorData = await res.json().catch(() => ({}));
          throw new Error(getLocalizedErrorMessage(t, errorData, "errors.failedToFetchMeetings"));
        }
        return res.json();
      })
      .then((data) => {
        setMeetingMinutesCount(Array.isArray(data.minutes) ? data.minutes.length : 0);
      })
      .catch((err) => {
        console.error("Failed to fetch meeting minutes:", err);
      });
  }, [channelId, channel?.isMember, channel?.isOwner, mode, t]);

  // Emit owner status when scene is ready
  useEffect(() => {
    const onSceneReady = () => {
      EventBus.emit("owner-status", { isOwner });
    };
    EventBus.on("scene-ready", onSceneReady);
    return () => { EventBus.off("scene-ready", onSceneReady); };
  }, [isOwner]);

  useEffect(() => {
    EventBus.emit("task-automation-updated", {
      reportWaitSeconds: channel?.gatewayConfig?.taskAutomation?.reportWaitSeconds ?? 20,
    });
  }, [channel?.gatewayConfig?.taskAutomation?.reportWaitSeconds]);

  // Placement mode coordination
  useEffect(() => {
    if (placementMode && pendingNpc) {
      EventBus.emit("placement-mode-start", pendingNpc);
    }
    const onPlacementComplete = async (data: { col: number; row: number }) => {
      if (!pendingNpc) return;
      try {
        const res = await fetch("/api/npcs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            channelId, name: pendingNpc.name, persona: pendingNpc.persona,
            appearance: pendingNpc.appearance, direction: pendingNpc.direction,
            positionX: data.col, positionY: data.row,
            presetId: pendingNpc.presetId,
            agentId: pendingNpc.agentId, agentAction: pendingNpc.agentAction,
            identity: pendingNpc.identity, soul: pendingNpc.soul,
            locale: pendingNpc.locale,
          }),
        });
        if (res.status === 409) return; // tile occupied, stay in placement mode
        if (!res.ok) {
          const errorData = await res.json().catch(() => ({}));
          throw new Error(getLocalizedErrorMessage(t, errorData, "errors.failedToCreateNpc"));
        }
        if (res.ok) {
          const result = await res.json();
          const npcsRes = await fetch(`/api/npcs?channelId=${channelId}`);
          const npcsData = await npcsRes.json();
          setChannelNpcs(npcsData.npcs || []);
          // Spawn NPC locally in GameScene
          EventBus.emit("npc:spawn-local", result.npc);
          // Broadcast to other players
          if (socket) socket.emit("npc:broadcast-add", result.npc);
        }
      } catch (err) {
        console.error("Failed to place NPC:", err);
        showToastNotification(
          "npc-place-error",
          err instanceof Error ? err.message : t("errors.failedToCreateNpc"),
        );
      }
      finally { setPlacementMode(false); setPendingNpc(null); EventBus.emit("placement-mode-end"); }
    };
    const onPlacementCancel = () => { setPlacementMode(false); setPendingNpc(null); };
    EventBus.on("placement-complete", onPlacementComplete);
    EventBus.on("placement-cancel", onPlacementCancel);
    return () => { EventBus.off("placement-complete", onPlacementComplete); EventBus.off("placement-cancel", onPlacementCancel); };
  }, [placementMode, pendingNpc, channelId, showToastNotification, socket, t]);

  // Spawn set mode coordination
  useEffect(() => {
    if (spawnSetMode) {
      EventBus.emit("spawn-set-mode-start");
    }
    const onSpawnSelected = async (data: { col: number; row: number }) => {
      if (!channelId) return;
      try {
        const existingConfig = typeof channel?.mapConfig === "string"
          ? JSON.parse(channel.mapConfig as string)
          : (channel?.mapConfig || {});
        await fetch(`/api/channels/${channelId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mapConfig: { ...existingConfig, spawnCol: data.col, spawnRow: data.row } }),
        });
        setChannel((prev) => prev ? { ...prev, mapConfig: { ...(typeof prev.mapConfig === "object" ? prev.mapConfig as Record<string, unknown> : {}), spawnCol: data.col, spawnRow: data.row } } : prev);
        showToastNotification("spawn-set", t("game.spawnSetSuccess", { col: data.col, row: data.row }));
      } catch (err) {
        console.error("Failed to save spawn position:", err);
      } finally {
        setSpawnSetMode(false);
        EventBus.emit("spawn-set-mode-end");
      }
    };
    const onSpawnCancel = () => {
      setSpawnSetMode(false);
      EventBus.emit("spawn-set-mode-end");
    };
    EventBus.on("spawn:selected", onSpawnSelected);
    EventBus.on("spawn-set-cancel", onSpawnCancel);
    return () => {
      EventBus.off("spawn:selected", onSpawnSelected);
      EventBus.off("spawn-set-cancel", onSpawnCancel);
    };
  }, [spawnSetMode, channelId, channel, showToastNotification, t]);

  // NPC management listeners (edit / fire)
  useEffect(() => {
    const onNpcEdit = (data: { npcId: string }) => {
      const npc = channelNpcs.find(n => n.id === data.npcId);
      if (!npc) return;
      setEditingNpc({
        id: npc.id, name: npc.name,
        persona: (npc as Record<string, unknown>).persona as string || "",
        appearance: npc.appearance,
        direction: typeof (npc as Record<string, unknown>).direction === "string" ? (npc as Record<string, unknown>).direction as string : "down",
        agentId: (npc as Record<string, unknown>).agentId as string | null || null,
      });
      setShowHireModal(true);
    };
    const onNpcFire = async (data: { npcId: string }) => {
      if (!confirm(t("game.fireNpcConfirm"))) return;
      const firedNpcId = data.npcId;
      try {
        const deleteRes = await fetch(`/api/npcs/${firedNpcId}`, { method: "DELETE" });
        if (!deleteRes.ok) {
          const errorData = await deleteRes.json().catch(() => ({}));
          throw new Error(getLocalizedErrorMessage(t, errorData, "errors.failedToDeleteNpc"));
        }
        const res = await fetch(`/api/npcs?channelId=${channelId}`);
        const npcsData = await res.json();
        setChannelNpcs(npcsData.npcs || []);
        // Remove NPC locally in GameScene
        EventBus.emit("npc:remove-local", { npcId: firedNpcId });
        // Broadcast to other players
        if (socket) socket.emit("npc:broadcast-remove", { npcId: firedNpcId });
        // Clean up tasks for the fired NPC
        setAllTasks((prev) => prev.filter((t) => t.npcId !== firedNpcId));
      } catch (err) {
        console.error("Failed to fire NPC:", err);
        showToastNotification(
          `npc-fire-error-${firedNpcId}`,
          err instanceof Error ? err.message : t("errors.failedToDeleteNpc"),
        );
      }
    };
    EventBus.on("npc:edit", onNpcEdit);
    EventBus.on("npc:fire", onNpcFire);
    return () => { EventBus.off("npc:edit", onNpcEdit); EventBus.off("npc:fire", onNpcFire); };
  }, [channelNpcs, channelId, showToastNotification, socket, t]);

  // NPC context menu handlers
  const handleCallNpc = useCallback(() => {
    if (!contextMenu) return;
    handleCallNpcById(contextMenu.npcId);
  }, [contextMenu, handleCallNpcById]);

  const handleContextTalk = useCallback(() => {
    if (!contextMenu) return;
    handleTalkNpcById(contextMenu.npcId, contextMenu.npcName);
  }, [contextMenu, handleTalkNpcById]);

  const handleReturnNpc = useCallback((npcId: string) => {
    if (!socket) return;
    socket.emit("npc:return-home", { channelId, npcId });
    setContextMenu(null);
    closeRosterMenus();
  }, [socket, channelId, closeRosterMenus]);

  // ESC key to close context menu
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (contextMenu) setContextMenu(null);
        if (rosterActionMenu) setRosterActionMenu(null);
      }
    };
    const preventContextMenu = (e: MouseEvent) => e.preventDefault();
    window.addEventListener("keydown", handleEsc);
    window.addEventListener("contextmenu", preventContextMenu);
    return () => {
      window.removeEventListener("keydown", handleEsc);
      window.removeEventListener("contextmenu", preventContextMenu);
    };
  }, [contextMenu, rosterActionMenu]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900 text-white">
        <div className="text-center">
          <div className="text-xl mb-2">{t("common.loadingGame")}</div>
          <div className="text-gray-400">{t("common.preparingCharacter")}</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900 text-white">
        <div className="text-center">
          <div className="text-xl mb-4 text-red-400">{error}</div>
          <Link
            href="/characters"
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 rounded font-semibold"
          >
            {t("common.backToCharacters")}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen overflow-hidden bg-gray-900 text-white">
      {/* Game canvas — full screen background (hidden when in meeting mode) */}
      <div style={{ visibility: mode === "office" ? "visible" : "hidden", position: mode === "office" ? "relative" : "absolute", pointerEvents: mode === "office" ? "auto" : "none" }}>
        {spritesheetDataUrl && character && gameChannelData && (
          <PhaserGame
            spritesheetDataUrl={spritesheetDataUrl}
            socket={socket}
            characterId={character.id}
            characterName={character.name}
            appearance={character.appearance}
            channelInitData={gameChannelData}
          />
        )}
      </div>

      {/* Spawn set mode banner */}
      {spawnSetMode && (
        <div className="fixed top-12 left-1/2 -translate-x-1/2 z-20 flex items-center gap-3 px-4 py-2 bg-green-900/90 border border-green-500 rounded-lg text-green-100 text-sm shadow-lg">
          <Footprints className="w-4 h-4 text-green-400" />
          <span>{t("game.spawnSetMode")}</span>
          <button
            onClick={() => { setSpawnSetMode(false); EventBus.emit("spawn-set-mode-end"); }}
            className="ml-2 px-2 py-0.5 bg-green-700 hover:bg-green-600 rounded text-xs"
          >
            {t("common.closeEsc")}
          </button>
        </div>
      )}

      {/* Top bar — floating over game */}
      <div className="fixed top-0 left-0 right-0 z-10 flex items-center justify-between px-4 py-2 bg-black/50 backdrop-blur-sm">
        {/* Left: Channel name — Character name */}
        <h1 className="text-lg font-bold">
          {channel?.name || "DeskRPG"} &mdash; {character?.name}
        </h1>

        {/* Right: grouped controls */}
        <div className="flex items-center gap-1.5">
          {/* Gateway status */}
          {channel?.hasGateway ? (
            <button
              onClick={() => openChannelSettings("gateway")}
              className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-sky-500/10 border border-sky-400/20 text-caption text-sky-200 hover:bg-sky-500/20"
            >
              <span className="w-2 h-2 rounded-full bg-sky-300" />
              <span>{t("game.aiGateway")}</span>
            </button>
          ) : (
            <button
              onClick={() => openChannelSettings("gateway")}
              className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-amber-500/10 border border-amber-400/20 text-caption text-amber-200 hover:bg-amber-500/20"
            >
              <span className="w-2 h-2 rounded-full bg-amber-300" />
              <span>{t("game.gatewayConnect")}</span>
            </button>
          )}

          {/* Roster buttons */}
          <div className="relative" data-roster-menu-root>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => {
                  setRosterActionMenu(null);
                  setShowRosterMenu((prev) => prev === "players" ? null : "players");
                }}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white/5 hover:bg-white/10 border border-white/10 text-caption text-text-secondary"
              >
                <span className="w-2 h-2 rounded-full bg-sky-400" />
                <span>{t("game.playersOnlineCount", { count: channelPlayers.length })}</span>
              </button>
              <button
                onClick={() => {
                  setRosterActionMenu(null);
                  setShowRosterMenu((prev) => prev === "npcs" ? null : "npcs");
                }}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white/5 hover:bg-white/10 border border-white/10 text-caption text-text-secondary"
              >
                <span className="w-2 h-2 rounded-full bg-violet-400" />
                <span>{t("game.npcsAtWorkCount", { count: channelNpcs.length })}</span>
              </button>
            </div>

            {showRosterMenu && (
              <div className="absolute top-full left-0 mt-2 w-64 bg-surface border border-border rounded-lg shadow-xl z-50 overflow-hidden">
                <div className="px-3 py-2 border-b border-border text-caption text-text-dim flex items-center justify-between gap-2">
                  <span>
                    {showRosterMenu === "players" ? t("game.playersOnlineCount", { count: channelPlayers.length }) : t("game.npcsAtWorkCount", { count: channelNpcs.length })}
                  </span>
                  {showRosterMenu === "players" && (
                    <button
                      onClick={() => {
                        setShowSharePopup(true);
                        closeRosterMenus();
                      }}
                      className="flex items-center gap-1 px-2 py-1 rounded-md bg-primary/80 hover:bg-primary text-white text-micro font-semibold"
                    >
                      <Share2 className="w-3 h-3" />
                      <span>{t("game.inviteFriend")}</span>
                    </button>
                  )}
                  {showRosterMenu === "npcs" && isOwner && mode === "office" && (
                    <button
                      onClick={() => {
                        setShowHireModal(true);
                        closeRosterMenus();
                      }}
                      className="flex items-center gap-1 px-2 py-1 rounded-md bg-primary/80 hover:bg-primary text-white text-micro font-semibold"
                    >
                      <UserPlus className="w-3 h-3" />
                      <span>{t("game.hireNpc")}</span>
                    </button>
                  )}
                </div>
                <div className="max-h-64 overflow-y-auto py-1">
                  {showRosterMenu === "players" ? (
                    channelPlayers.length > 0 ? channelPlayers.map((player) => (
                      player.id === "__self__" ? (
                        <button
                          key={player.id}
                          onClick={(event) => openRosterActionMenu(event.currentTarget, {
                            type: "player",
                            playerId: player.id,
                            playerName: player.name,
                          })}
                          className="w-full px-3 py-2 text-body text-text-secondary hover:bg-surface-raised flex items-center gap-2 text-left"
                        >
                          <RosterAvatar appearance={player.appearance} />
                          <span className="truncate">{player.name}</span>
                          <span className="ml-auto text-micro text-text-dim">{t("game.you")}</span>
                        </button>
                      ) : (
                        <button
                          key={player.id}
                          onClick={(event) => openRosterActionMenu(event.currentTarget, {
                            type: "player",
                            playerId: player.id,
                            playerName: player.name,
                          })}
                          className="w-full px-3 py-2 text-body text-text-secondary hover:bg-surface-raised flex items-center gap-2 text-left"
                        >
                          <RosterAvatar appearance={player.appearance} />
                          <span className="truncate">{player.name}</span>
                        </button>
                      )
                    )) : (
                      <div className="px-3 py-3 text-caption text-text-dim">{t("game.noPlayersOnline")}</div>
                    )
                  ) : (
                    channelNpcs.length > 0 ? channelNpcs.map((npc) => (
                      <button
                        key={npc.id}
                        onClick={(event) => openRosterActionMenu(event.currentTarget, {
                          type: "npc",
                          npcId: npc.id,
                          npcName: npc.name,
                        })}
                        className="w-full px-3 py-2 text-body text-text-secondary hover:bg-surface-raised flex items-center gap-2 text-left"
                      >
                        <RosterAvatar appearance={npc.appearance as CharacterAppearance | LegacyCharacterAppearance | null} />
                        <span className="truncate">{npc.name}</span>
                      </button>
                    )) : (
                      <div className="px-3 py-3 text-caption text-text-dim">{t("game.noNpcsAtWork")}</div>
                    )
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Mode toggle */}
          <button
            onClick={() => setMode(mode === "office" ? "meeting" : "office")}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-caption font-semibold ${
              mode === "meeting"
                ? "bg-primary hover:bg-primary-hover text-white"
                : "bg-meeting/80 hover:bg-meeting text-white"
            }`}
          >
            <Users className="w-3 h-3" />
            {mode === "office" ? t("game.meetingRoom") : t("common.back")}
            <span className="bg-white/20 px-1.5 rounded-full text-micro">{meetingMinutesCount}</span>
          </button>

          {/* Tasks button */}
          <button
            onClick={() => setShowTaskBoard(true)}
            className="flex items-center gap-1 px-2.5 py-1 bg-primary/80 hover:bg-primary text-white rounded-md text-caption font-semibold"
          >
            <ClipboardList className="w-3 h-3" /> {t("game.tasks")}
            {(() => {
              const n = allTasks.filter((t) => t.status === "in_progress" || t.status === "pending").length;
              return <span className="bg-white/20 px-1.5 rounded-full text-micro">{n}</span>;
            })()}
          </button>

          {/* Separator */}
          <div className="w-px h-5 bg-border" />

          {/* Unified menu dropdown */}
          <div className="relative">
            <button
              onClick={() => { setShowUserMenu(!showUserMenu); setShowSharePopup(false); }}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white/5 border border-white/10 text-caption text-text-secondary hover:text-white hover:bg-white/10 relative"
            >
              <Settings className="w-3.5 h-3.5" />
              {t("game.menuSettings")}
              {notifications.some((n) => !n.read) && (
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-danger rounded-full" />
              )}
              <ChevronDown className="w-3 h-3" />
            </button>
            {showUserMenu && (
              <div className="absolute right-0 top-full mt-1 bg-surface border border-border rounded-lg shadow-xl w-56 z-50 py-1">
                {isOwner && (
                  <button
                    onClick={() => { openChannelSettings("settings"); setShowUserMenu(false); }}
                    className="w-full text-left px-4 py-2 text-body text-text-secondary hover:bg-surface-raised hover:text-white flex items-center gap-2"
                  >
                    <Settings className="w-3.5 h-3.5" />
                    {t("game.settings")}
                  </button>
                )}

                {/* Notifications section */}
                <div className="border-t border-border my-1" />
                <div className="px-4 py-2">
                  <button
                    type="button"
                    onClick={() => setNotificationsExpanded((prev) => !prev)}
                    className="w-full flex items-center justify-between text-caption text-text-dim hover:text-text-secondary"
                  >
                    <span className="flex items-center gap-1.5">
                      <Bell className="w-3.5 h-3.5" />
                      {t("game.notifications")}
                      {notifications.some((n) => !n.read) && (
                        <span className="bg-danger text-white text-micro px-1.5 rounded-full">
                          {notifications.filter((n) => !n.read).length}
                        </span>
                      )}
                    </span>
                    <ChevronDown
                      className={`w-3.5 h-3.5 transition-transform ${notificationsExpanded ? "rotate-180" : ""}`}
                    />
                  </button>
                  {notificationsExpanded && (
                    <div className="mt-2">
                      {notifications.length > 0 && (
                        <div className="flex justify-end mb-1">
                          <button
                            onClick={() => setNotifications((prev) => prev.map((n) => ({ ...n, read: true })))}
                            className="text-micro text-primary-light hover:text-primary"
                          >
                            {t("game.markAllRead")}
                          </button>
                        </div>
                      )}
                      {notifications.length === 0 ? (
                        <div className="text-caption text-text-dim py-2 text-center">{t("game.noNotifications")}</div>
                      ) : (
                        <div className="max-h-40 overflow-y-auto -mx-1 px-1">
                          {notifications.slice(0, 5).map((n) => (
                            <div
                              key={n.id}
                              className={`py-1.5 text-caption ${n.read ? "text-text-dim" : "text-text-secondary"}`}
                            >
                              <div className="truncate">{n.message}</div>
                              <div className="text-micro text-text-dim">{new Date(n.timestamp).toLocaleTimeString()}</div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Preferences section */}
                <div className="border-t border-border my-1" />
                <div className="px-4 py-2">
                  <div className="text-caption text-text-dim mb-1 flex items-center gap-1.5">
                    <Globe className="w-3.5 h-3.5" />
                    {t("common.language")}
                  </div>
                  <select
                    value={locale}
                    onChange={(e) => setLocale(e.target.value as typeof locale)}
                    className="w-full px-2 py-1 bg-surface border border-border rounded text-caption text-text cursor-pointer focus:outline-none focus:ring-1 focus:ring-primary-light"
                  >
                    {LOCALES.map((l) => (
                      <option key={l.code} value={l.code}>{l.label}</option>
                    ))}
                  </select>
                </div>

                <div className="border-t border-border my-1" />
                <button
                  onClick={() => {
                    setShowUserMenu(false);
                    openBugReport();
                  }}
                  className="w-full text-left px-4 py-2 text-body text-text-secondary hover:bg-surface-raised hover:text-white flex items-center gap-2"
                >
                  <Bug className="w-3.5 h-3.5" />
                  {t("game.reportBug")}
                </button>

                {/* Exit section */}
                <div className="border-t border-border my-1" />
                <button
                  onClick={async () => {
                    setShowUserMenu(false);
                    // Save position via API before leaving (socket disconnect may not fire)
                    try {
                      const channelId = new URLSearchParams(window.location.search).get("channelId");
                      if (channelId && socketRef.current) {
                        // Request position from Phaser via EventBus
                        const pos = await new Promise<{x: number; y: number} | null>((resolve) => {
                          let resolved = false;
                          const handler = (data: {x: number; y: number}) => {
                            resolved = true;
                            EventBus.off("player-position-response", handler);
                            resolve(data);
                          };
                          EventBus.on("player-position-response", handler);
                          EventBus.emit("request-player-position");
                          setTimeout(() => { if (!resolved) { EventBus.off("player-position-response", handler); resolve(null); } }, 200);
                        });
                        if (pos) {
                          await fetch(`/api/channels/${channelId}/save-position`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ x: Math.round(pos.x), y: Math.round(pos.y) }),
                          }).catch(() => {});
                        }
                      }
                    } catch { /* best effort */ }
                    window.location.href = `/channels?characterId=${characterId}`;
                  }}
                  className="w-full text-left px-4 py-2 text-body text-text-secondary hover:bg-surface-raised hover:text-white flex items-center gap-2"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  {t("game.leaveChannel")}
                </button>
                <button
                  onClick={() => {
                    document.cookie = "token=; path=/; max-age=0";
                    window.location.href = "/auth";
                  }}
                  className="w-full text-left px-4 py-2 text-body text-danger hover:bg-surface-raised hover:text-danger flex items-center gap-2"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  {t("auth.logout")}
                </button>

                <div className="border-t border-border my-1" />
                <button
                  onClick={() => {
                    setShowUserMenu(false);
                    setShowAboutModal(true);
                  }}
                  className="w-full text-left px-4 py-2 text-body text-text-secondary hover:bg-surface-raised hover:text-white flex items-center gap-2"
                >
                  <Info className="w-3.5 h-3.5" />
                  {t("game.aboutDeskRpg")}
                </button>
              </div>
            )}
          </div>

          {/* Share popup (positioned independently) */}
          {showSharePopup && channel?.inviteCode && (
            <div className="fixed top-12 right-4 bg-surface border border-border rounded-lg p-3 shadow-xl w-72 z-50">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs text-text-muted">{t("game.inviteLink")}</p>
                <button onClick={() => setShowSharePopup(false)} className="text-text-dim hover:text-text-secondary text-xs">{t("common.close")}</button>
              </div>
              <div className="flex gap-2">
                <input
                  readOnly
                  value={`${typeof window !== "undefined" ? window.location.origin : ""}/channels/join/${channel.inviteCode}`}
                  className="flex-1 px-2 py-1 bg-bg border border-border rounded text-xs text-text-secondary"
                />
                <button
                  onClick={handleCopyInvite}
                  className="px-2 py-1 bg-primary hover:bg-primary-hover rounded text-xs"
                >
                  {copied ? t("game.copied") : t("common.copy")}
                </button>
              </div>
              <p className="text-xs text-text-dim mt-2">
                {t("game.inviteCodeLabel")} <span className="text-text-secondary font-mono">{channel.inviteCode}</span>
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Click outside to close dropdowns */}
      {showUserMenu && (
        <div
          className="fixed inset-0 z-[9]"
          onClick={() => setShowUserMenu(false)}
        />
      )}

      {showAboutModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-2xl rounded-xl border border-border bg-surface shadow-2xl">
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <h2 className="text-lg font-semibold text-text">{t("about.title")}</h2>
              <button
                onClick={() => setShowAboutModal(false)}
                className="text-text-dim hover:text-text"
                aria-label={t("common.close")}
              >
                &times;
              </button>
            </div>
            <div className="px-6 py-5 space-y-4">
              <div className="grid grid-cols-[180px_1fr] gap-x-4 gap-y-4 text-sm">
                <div className="text-text-dim">{t("about.version")}</div>
                <div className="text-text">v{APP_VERSION}</div>

                <div className="text-text-dim">{t("about.sourceCode")}</div>
                <a
                  href={SOURCE_CODE_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary-light hover:text-primary underline underline-offset-2 break-all"
                >
                  {SOURCE_CODE_URL}
                </a>

                <div className="text-text-dim">{t("about.license")}</div>
                <a
                  href={LICENSE_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary-light hover:text-primary underline underline-offset-2 break-all"
                >
                  LICENSE.md
                </a>

                <div className="text-text-dim">{t("about.thirdPartyLicenses")}</div>
                <div className="space-y-1">
                  <a
                    href={THIRD_PARTY_LICENSES_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block text-primary-light hover:text-primary underline underline-offset-2"
                  >
                    {t("about.viewThirdPartyLicenses")}
                  </a>
                  <a
                    href={AVATAR_ASSET_CREDITS_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block text-primary-light hover:text-primary underline underline-offset-2"
                  >
                    {t("about.viewAvatarAssetCredits")}
                  </a>
                  <a
                    href={AVATAR_ASSET_LICENSE_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block text-primary-light hover:text-primary underline underline-offset-2"
                  >
                    {t("about.viewAvatarAssetLicenseNotes")}
                  </a>
                </div>

                <div className="text-text-dim">{t("about.instanceId")}</div>
                <div className="text-text break-all">{instanceId || "—"}</div>

                <div className="text-text-dim">{t("about.debug")}</div>
                <button
                  onClick={() => void copyDebugInformation()}
                  className="text-left text-primary-light hover:text-primary underline underline-offset-2"
                >
                  {debugCopied ? t("about.debugCopied") : t("about.copyDebugInformation")}
                </button>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-border">
              <button
                onClick={() => setShowAboutModal(false)}
                className="px-4 py-2 rounded bg-primary hover:bg-primary-hover text-white text-sm font-semibold"
              >
                {t("common.close")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* NPC Hire Modal */}
      <NpcHireModal
        channelId={channelId!}
        isOpen={showHireModal}
        onClose={() => { setShowHireModal(false); setEditingNpc(null); }}
        onPlaceOnMap={(npcData) => {
          setPendingNpc(npcData);
          setPlacementMode(true);
          setShowHireModal(false);
        }}
        onSaveEdit={async (npcId, updates) => {
          try {
            const patchRes = await fetch(`/api/npcs/${npcId}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(updates),
            });
            if (!patchRes.ok) {
              const errorData = await patchRes.json().catch(() => ({}));
              throw new Error(getLocalizedErrorMessage(t, errorData, "npc.saveEditFailed"));
            }
            const patchData = await patchRes.json().catch(() => ({}));
            const res = await fetch(`/api/npcs?channelId=${channelId}`);
            const data = await res.json();
            setChannelNpcs(data.npcs || []);
            setShowHireModal(false);
            setEditingNpc(null);
            const localUpdate = patchData?.npc
              ? {
                  npcId,
                  name: patchData.npc.name,
                  appearance: patchData.npc.appearance,
                  direction: patchData.npc.direction,
                }
              : { npcId, ...updates };
            EventBus.emit("npc:update-local", localUpdate);
            if (socket) socket.emit("npc:broadcast-update", localUpdate);
          } catch (error) {
            console.error("Failed to save NPC edit:", error);
            showToastNotification(
              `npc-edit-error-${npcId}`,
              error instanceof Error ? error.message : t("npc.saveEditFailed"),
            );
          }
        }}
        editingNpc={editingNpc}
        currentNpcCount={channelNpcs.length}
        hasGateway={!!channel?.hasGateway}
      />

      {showPasswordModal && channelId && (
        <PasswordModal
          channelName={channel?.name || t("channels.privateChannel")}
          onSubmit={handleGamePasswordSubmit}
          onClose={() => router.push(`/channels?characterId=${characterId}`)}
        />
      )}

      {showChannelSettings && channel && (
        <ChannelSettingsModal
          channelId={channel.id}
          channelName={channel.name}
          channelDescription={channel.description}
          isPublic={channel.isPublic}
          inviteCode={channel.inviteCode}
          initialTab={channelSettingsInitialTab}
          onClose={() => setShowChannelSettings(false)}
          onUpdated={(data) => {
            if (typeof data.gatewayConfig?.taskAutomation?.reportWaitSeconds === "number") {
              EventBus.emit("task-automation-updated", {
                reportWaitSeconds: data.gatewayConfig.taskAutomation.reportWaitSeconds,
              });
            }
            setChannel((prev) => {
              if (!prev) return prev;
              return {
                ...prev,
                ...data,
                hasGateway:
                  data.gatewayConfig
                    ? Boolean(
                        (typeof data.gatewayConfig.gatewayId === "string" && data.gatewayConfig.gatewayId.trim())
                        || (typeof data.gatewayConfig.url === "string" && data.gatewayConfig.url.trim())
                        || prev.gatewayConfig?.gatewayId
                        || prev.gatewayConfig?.url,
                      )
                    : prev.hasGateway,
                gatewayConfig: data.gatewayConfig
                  ? {
                      ...(prev.gatewayConfig || {}),
                      ...data.gatewayConfig,
                      taskAutomation: {
                        ...(prev.gatewayConfig?.taskAutomation || {}),
                        ...(data.gatewayConfig.taskAutomation || {}),
                      },
                    }
                  : prev.gatewayConfig,
              };
            });
          }}
        />
      )}

      <TaskBoard
        channelId={channelId!}
        isOpen={showTaskBoard}
        onClose={() => setShowTaskBoard(false)}
        tasks={allTasks}
        onDeleteTask={deleteTask}
        onRequestReportTask={requestTaskReport}
        onResumeTask={resumeTask}
        onCompleteTask={completeTask}
      />

      {/* Placement mode indicator */}
      {placementMode && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 bg-primary text-white px-4 py-2 rounded-lg shadow-lg text-body font-medium">
          {t("game.placementMode")}
        </div>
      )}

      {mode === "office" && (
        <>
          {/* Interact selection popup */}
          {interactSelectList && (
            <div className="fixed inset-0 z-40" onClick={() => setInteractSelectList(null)}>
              <div
                className="absolute bottom-16 left-1/2 -translate-x-1/2 bg-surface border border-border rounded-lg shadow-xl p-2 min-w-[180px]"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="text-center text-caption text-text-muted px-3 py-1 mb-1">{t("game.whoToTalkTo")}</div>
                {interactSelectList.map((target) => (
                  <button
                    key={`${target.type}-${target.id}`}
                    onClick={() => {
                      setInteractSelectList(null);
                      if (target.type === "npc") {
                        EventBus.emit("npc:interact", { npcId: target.id, npcName: target.name });
                      } else {
                        EventBus.emit("player:chat-open");
                      }
                    }}
                    className="w-full text-left px-3 py-2 text-body text-text hover:bg-surface-raised rounded flex items-center gap-2"
                  >
                    <span className={`w-2 h-2 rounded-full ${target.type === "npc" ? "bg-npc" : "bg-info"}`} />
                    {target.name}
                    <span className="text-caption text-text-dim ml-auto">{target.type === "npc" ? t("game.typeNpc") : t("game.typePlayer")}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Bottom toast */}
          {toastMessage && !interactSelectList && (
            <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-10 text-text text-body bg-surface/90 backdrop-blur px-5 py-2 rounded-full shadow-lg border border-border/50">
              {toastMessage}
            </div>
          )}

          {/* Left-side chat panel — resizable */}
          <ChatPanel
            dialogNpc={dialogNpc}
            npcMessages={npcMessages}
            isNpcStreaming={isNpcStreaming}
            npcChatInputDisabled={!socketConnected}
            npcChatDisabledPlaceholder={t("chat.disconnected")}
            onSend={handleDialogSend}
            onClose={handleDialogClose}
            npcSelectList={npcSelectList}
            onSelectNpc={handleSelectNpc}
            isOwner={isOwner}
            onEditNpc={(npcId) => EventBus.emit("npc:edit", { npcId })}
            onFireNpc={(npcId) => EventBus.emit("npc:fire", { npcId })}
            onResetNpcChat={(npcId) => {
              if (socketRef.current) socketRef.current.emit("npc:reset-chat", { npcId });
              setNpcMessages([]);
            }}
            channelMessages={channelMessages}
            channelChatOpen={channelChatOpen}
            channelChatInputDisabled={channelChatInputDisabled || !socketConnected}
            onSendChannelChat={handleChannelChatSend}
            currentPlayerName={character?.name}
            npcMoveState={dialogNpc ? npcMoveStates[dialogNpc.npcId] : undefined}
            onReturnNpc={dialogNpc && npcCallers[dialogNpc.npcId] === socket?.id ? handleReturnNpc : undefined}
            socket={socket}
            onDeleteTask={deleteTask}
            onRequestReportTask={requestTaskReport}
            onResumeTask={resumeTask}
            onCompleteTask={completeTask}
          />
        </>
      )}

      {/* NPC Context Menu */}
      {contextMenu && (() => {
        const currentMoveState = npcMoveStates[contextMenu.npcId] || contextMenu.moveState;
        const isCaller = npcCallers[contextMenu.npcId] === socket?.id;
        return <>
          <div className="fixed inset-0 z-40" onClick={() => setContextMenu(null)} />
          <div
            className="fixed z-50"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <div className="bg-surface border border-border rounded-lg shadow-xl py-1 min-w-[140px]">
              {currentMoveState === "idle" && (
                <button
                  onClick={handleCallNpc}
                  className="w-full text-left px-3 py-2 text-body text-npc hover:bg-surface-raised"
                >
                  <PhoneCall className="w-3.5 h-3.5 inline mr-1" />{t("context.call")}
                </button>
              )}
              {currentMoveState === "waiting" && isCaller && (
                <button
                  onClick={() => { handleReturnNpc(contextMenu.npcId); setContextMenu(null); }}
                  className="w-full text-left px-3 py-2 text-body text-npc hover:bg-surface-raised"
                >
                  <Undo2 className="w-3.5 h-3.5 inline mr-1" />{t("context.return")}
                </button>
              )}
              {currentMoveState === "waiting" && !isCaller && (
                <button disabled className="w-full text-left px-3 py-2 text-body text-text-dim cursor-not-allowed">
                  <Clock className="w-3.5 h-3.5 inline mr-1" />{t("context.calledByOther")}
                </button>
              )}
              {currentMoveState !== "idle" && currentMoveState !== "waiting" && (
                <button disabled className="w-full text-left px-3 py-2 text-body text-text-dim cursor-not-allowed">
                  <Footprints className="w-3.5 h-3.5 inline mr-1" />{t("npc.moving")}
                </button>
              )}
              <button
                onClick={handleContextTalk}
                disabled={currentMoveState !== "idle"}
                className={`w-full text-left px-3 py-2 text-body ${
                  currentMoveState === "idle"
                    ? "text-text hover:bg-surface-raised"
                    : "text-text-dim cursor-not-allowed"
                }`}
              >
                <MessageSquare className="w-3.5 h-3.5 inline mr-1" />{t("context.talk")}
              </button>
              {isOwner && (
                <button
                  onClick={() => handleEditNpcById(contextMenu.npcId)}
                  className="w-full text-left px-3 py-2 text-body text-text hover:bg-surface-raised"
                >
                  <Pencil className="w-3.5 h-3.5 inline mr-1" />{t("context.edit")}
                </button>
              )}
              <button
                onClick={() => handleResetNpcChatById(contextMenu.npcId)}
                className="w-full text-left px-3 py-2 text-body text-text hover:bg-surface-raised"
              >
                <RotateCcw className="w-3.5 h-3.5 inline mr-1" />{t("context.resetChat")}
              </button>
              {isOwner && (
                <button
                  onClick={() => handleFireNpcById(contextMenu.npcId)}
                  className="w-full text-left px-3 py-2 text-body text-danger hover:bg-surface-raised"
                >
                  <UserMinus className="w-3.5 h-3.5 inline mr-1" />{t("context.fire")}
                </button>
              )}
            </div>
          </div>
        </>;
      })()}

      {rosterActionMenu && (() => {
        if (rosterActionMenu.type === "player") {
          return (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setRosterActionMenu(null)} />
              <div
                className="fixed z-50"
                style={{ left: rosterActionMenu.x, top: rosterActionMenu.y }}
                data-roster-action-menu-root
              >
                <div className="bg-surface border border-border rounded-lg shadow-xl py-1 min-w-[160px]">
                  {rosterActionMenu.playerId === "__self__" ? (
                    <>
                      <button
                        onClick={handleEditCharacter}
                        className="w-full text-left px-3 py-2 text-body text-text hover:bg-surface-raised"
                      >
                        <Pencil className="w-3.5 h-3.5 inline mr-1" />{t("game.editCharacter")}
                      </button>
                      {isOwner && mode === "office" && (
                        <button
                          onClick={handleStartPositionSetting}
                          className="w-full text-left px-3 py-2 text-body text-text hover:bg-surface-raised"
                        >
                          <Footprints className="w-3.5 h-3.5 inline mr-1" />{t("game.setStartPosition")}
                        </button>
                      )}
                    </>
                  ) : (
                    <button
                      onClick={handleOpenPlayerChat}
                      className="w-full text-left px-3 py-2 text-body text-text hover:bg-surface-raised"
                    >
                      <MessageSquare className="w-3.5 h-3.5 inline mr-1" />{t("context.talk")}
                    </button>
                  )}
                </div>
              </div>
            </>
          );
        }

        const currentMoveState = npcMoveStates[rosterActionMenu.npcId] || "idle";
        const isCaller = npcCallers[rosterActionMenu.npcId] === socket?.id;
        return (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setRosterActionMenu(null)} />
            <div
              className="fixed z-50"
              style={{ left: rosterActionMenu.x, top: rosterActionMenu.y }}
              data-roster-action-menu-root
            >
              <div className="bg-surface border border-border rounded-lg shadow-xl py-1 min-w-[160px]">
                {currentMoveState === "idle" && (
                  <button
                    onClick={() => handleCallNpcById(rosterActionMenu.npcId)}
                    className="w-full text-left px-3 py-2 text-body text-npc hover:bg-surface-raised"
                  >
                    <PhoneCall className="w-3.5 h-3.5 inline mr-1" />{t("context.call")}
                  </button>
                )}
                {currentMoveState === "waiting" && isCaller && (
                  <button
                    onClick={() => handleReturnNpc(rosterActionMenu.npcId)}
                    className="w-full text-left px-3 py-2 text-body text-npc hover:bg-surface-raised"
                  >
                    <Undo2 className="w-3.5 h-3.5 inline mr-1" />{t("context.return")}
                  </button>
                )}
                {currentMoveState === "waiting" && !isCaller && (
                  <button disabled className="w-full text-left px-3 py-2 text-body text-text-dim cursor-not-allowed">
                    <Clock className="w-3.5 h-3.5 inline mr-1" />{t("context.calledByOther")}
                  </button>
                )}
                {currentMoveState !== "idle" && currentMoveState !== "waiting" && (
                  <button disabled className="w-full text-left px-3 py-2 text-body text-text-dim cursor-not-allowed">
                    <Footprints className="w-3.5 h-3.5 inline mr-1" />{t("npc.moving")}
                  </button>
                )}
                <button
                  onClick={() => handleTalkNpcById(rosterActionMenu.npcId, rosterActionMenu.npcName)}
                  disabled={currentMoveState !== "idle"}
                  className={`w-full text-left px-3 py-2 text-body ${
                    currentMoveState === "idle"
                      ? "text-text hover:bg-surface-raised"
                      : "text-text-dim cursor-not-allowed"
                  }`}
                >
                  <MessageSquare className="w-3.5 h-3.5 inline mr-1" />{t("context.talk")}
                </button>
                {isOwner && (
                  <button
                    onClick={() => handleEditNpcById(rosterActionMenu.npcId)}
                    className="w-full text-left px-3 py-2 text-body text-text hover:bg-surface-raised"
                  >
                    <Pencil className="w-3.5 h-3.5 inline mr-1" />{t("context.edit")}
                  </button>
                )}
                <button
                  onClick={() => handleResetNpcChatById(rosterActionMenu.npcId)}
                  className="w-full text-left px-3 py-2 text-body text-text hover:bg-surface-raised"
                >
                  <RotateCcw className="w-3.5 h-3.5 inline mr-1" />{t("context.resetChat")}
                </button>
                {isOwner && (
                  <button
                    onClick={() => handleFireNpcById(rosterActionMenu.npcId)}
                    className="w-full text-left px-3 py-2 text-body text-danger hover:bg-surface-raised"
                  >
                    <UserMinus className="w-3.5 h-3.5 inline mr-1" />{t("context.fire")}
                  </button>
                )}
              </div>
            </div>
          </>
        );
      })()}

      {mode === "meeting" && character && (
        <MeetingRoom
          channelId={channelId!}
          character={{
            id: character.id,
            name: character.name,
            appearance: character.appearance,
          }}
          socket={socket}
          npcs={channelNpcs}
          onLeave={() => setMode("office")}
        />
      )}
    </div>
  );
}
