"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useT, useLocale, LOCALES } from "@/lib/i18n";
import { ClipboardList, MessageSquare, Undo2, Clock, Footprints, PhoneCall, Bell, ChevronDown, UserPlus, Settings, Share2, LogOut, Pencil, Users, Globe } from "lucide-react";
import type { Socket } from "socket.io-client";
import {
  CharacterAppearance,
  LegacyCharacterAppearance,
} from "@/lib/lpc-registry";
import { compositeCharacter } from "@/lib/sprite-compositor";
import { EventBus, setPendingChannelData } from "@/game/EventBus";
import ChatPanel, { type ChannelChatMessage } from "@/components/ChatPanel";
import MeetingRoom from "@/components/MeetingRoom";
import NpcHireModal from "@/components/NpcHireModal";
import type { NpcChatMessage } from "@/components/NpcDialog";
import PasswordModal from "@/components/PasswordModal";
import ChannelSettingsModal from "@/components/ChannelSettingsModal";
import TaskBoard from "@/components/TaskBoard";
import type { Task } from "@/components/TaskCard";

// Import PhaserGame with SSR disabled — Phaser requires browser APIs
const PhaserGame = dynamic(() => import("@/components/PhaserGame"), {
  ssr: false,
  loading: () => (
    <div className="fixed inset-0 bg-gray-800 flex items-center justify-center text-gray-400">
      Loading game engine...
    </div>
  ),
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
  hasGateway: boolean;
}

export default function GamePage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-gray-900 text-white">
        Loading...
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
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [playerCount, setPlayerCount] = useState(1);
  const [socket, setSocket] = useState<Socket | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [showSharePopup, setShowSharePopup] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [mode, setMode] = useState<"office" | "meeting">("office");
  const [channelNpcs, setChannelNpcs] = useState<{ id: string; name: string; appearance: unknown }[]>([]);

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
  const characterNameRef = useRef<string>("");

  // NPC greeting messages (stored until dialog opens)
  const npcGreetings = useRef<Map<string, string>>(new Map());
  const npcMessagesRef = useRef<NpcChatMessage[]>([]);

  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [showChannelSettings, setShowChannelSettings] = useState(false);
  const [showTaskBoard, setShowTaskBoard] = useState(false);
  const [allTasks, setAllTasks] = useState<Task[]>([]);

  // Owner & NPC management state
  const [isOwner, setIsOwner] = useState(false);
  const [showHireModal, setShowHireModal] = useState(false);
  const [placementMode, setPlacementMode] = useState(false);
  const [pendingNpc, setPendingNpc] = useState<{ name: string; persona: string; appearance: unknown; direction: string; agentId?: string; agentAction?: "select" | "create"; identity?: string; soul?: string } | null>(null);
  const [editingNpc, setEditingNpc] = useState<{ id: string; name: string; persona: string; appearance: unknown; agentId?: string | null } | null>(null);
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

  // Redirect to channel select if no channelId
  useEffect(() => {
    if (!channelId && characterId) {
      router.replace(`/channels?characterId=${characterId}`);
    } else if (!channelId && !characterId) {
      router.replace("/characters");
    }
  }, [channelId, characterId, router]);

  const showToastNotification = useCallback((id: string, message: string) => {
    setToastMessage(message);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToastMessage(null), 4000);
    setNotifications((prev) =>
      [{ id, message, timestamp: Date.now(), read: false }, ...prev].slice(0, 20),
    );
  }, []);

  // Socket.io connection (dynamic import to avoid SSR window access)
  useEffect(() => {
    let socketInstance: Socket | null = null;
    let cancelled = false;

    import("socket.io-client").then(({ io }) => {
      if (cancelled) return;
      socketInstance = io({ path: "/socket.io" });
      setSocket(socketInstance);
      socketRef.current = socketInstance;

      socketInstance.on("players:state", (data: { players: unknown[] }) => {
        setPlayerCount(data.players.length + 1);
      });
      socketInstance.on("player:joined", () => {
        setPlayerCount((c) => c + 1);
      });
      socketInstance.on("player:left", () => {
        setPlayerCount((c) => Math.max(1, c - 1));
      });

      // Channel chat history (sent on join)
      socketInstance.on("chat:history", (data: { messages: ChannelChatMessage[] }) => {
        setChannelMessages(data.messages || []);
      });

      // NPC chat history (sent on demand) — only apply if it matches the current dialog
      socketInstance.on("npc:history", (data: { npcId: string; messages: { role: string; content: string }[] }) => {
        if (!dialogNpcRef.current || dialogNpcRef.current.npcId !== data.npcId) return;
        if (data.messages && data.messages.length > 0) {
          setNpcMessages(data.messages.map(m => ({ role: m.role as "player" | "npc", content: m.content })));
        }
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

      socketInstance.on("session:kicked", (data: { reason: string }) => {
        alert(data.reason);
        router.push(`/channels?characterId=${characterId}`);
      });

      socketInstance.on("join-error", () => {
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

      socketInstance.on("npc:report-ready", (data: { npcId: string; message: string }) => {
        EventBus.emit("npc:call-to-player", { npcId: data.npcId, message: data.message });
      });

      // When NPC finishes responding, check if it's far from player and move it closer
      socketInstance.on("npc:response-complete", (data: { npcId: string; npcName: string }) => {
        EventBus.emit("npc:deliver-response", { npcId: data.npcId, npcName: data.npcName });
      });

      socketInstance.on("npc:returning", (data: { npcId: string }) => {
        EventBus.emit("npc:start-return", { npcId: data.npcId });
      });

      // NPC response streaming — only process for the NPC currently in dialog
      socketInstance.on("npc:response", (data: { npcId: string; chunk: string; done: boolean }) => {
        // Ignore responses for NPCs not in the current dialog
        if (dialogNpcRef.current && dialogNpcRef.current.npcId !== data.npcId) return;
        if (data.chunk) {
          streamBufferRef.current += data.chunk;
          const buffered = streamBufferRef.current;
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
          // 스트리밍 완료 시 json:task 블록을 즉시 제거 (npc:response-done 대기 없이)
          const finalText = streamBufferRef.current;
          if (finalText.includes("```json:task")) {
            const cleaned = finalText.replace(/```json:task\s*\n[\s\S]*?\n```/g, "").trim();
            setNpcMessages((prev) => {
              const lastIdx = prev.length - 1;
              if (lastIdx >= 0 && prev[lastIdx].role === "npc") {
                const updated = [...prev];
                updated[lastIdx] = { role: "npc", content: cleaned };
                return updated;
              }
              return prev;
            });
          }
          streamBufferRef.current = "";
        }
      });

      // Task: delete
      socketInstance.on("task:deleted", ({ taskId }: { taskId: string }) => {
        setAllTasks((prev) => prev.filter((t) => t.id !== taskId));
      });

      // Task: real-time updates
      socketInstance.on("task:updated", ({ task, action }: { task: Task; action: string }) => {
        setAllTasks((prev) => {
          const idx = prev.findIndex((t) => t.id === task.id);
          if (idx >= 0) {
            const updated = [...prev];
            updated[idx] = task;
            return updated;
          }
          return [task, ...prev];
        });
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
      socketRef.current = null;
    };
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
      const greeting = `Hi! I'm ${data.npcName}. Press E to talk!`;
      npcGreetings.current.set(data.npcId, greeting);
      EventBus.emit("npc:bubble", { npcId: data.npcId });
      showToastNotification(`greet-${data.npcId}-${Date.now()}`, `${data.npcName} says hello!`);
    };

    const handleToastShow = (data: { message: string }) => {
      setToastMessage(data.message);
    };
    const handleToastHide = () => {
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
    const handleMovementArrived = (data: { npcId: string; npcName?: string }) => {
      setNpcMoveStates(prev => ({ ...prev, [data.npcId]: "waiting" }));
      // Auto-open dialog when NPC arrives — preserve existing messages (don't resetDialog)
      if (data.npcName) {
        setDialogNpc({ npcId: data.npcId, npcName: data.npcName });
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
  }, [resetDialog]);

  const handleDialogClose = useCallback(() => {
    resetDialog();
    EventBus.emit("dialog:close");
  }, [resetDialog]);

  const handleSelectNpc = useCallback((npcId: string, npcName: string) => {
    resetDialog();
    setDialogNpc({ npcId, npcName });
    EventBus.emit("dialog:open");
  }, [resetDialog]);

  const handleDialogSend = useCallback(
    (message: string) => {
      if (!socket || !dialogNpc) return;
      // Add player message immediately
      setNpcMessages((prev) => [...prev, { role: "player", content: message }]);
      streamBufferRef.current = "";
      socket.emit("npc:chat", { npcId: dialogNpc.npcId, message });
    },
    [socket, dialogNpc],
  );

  const handleGamePasswordSubmit = useCallback(async (password: string): Promise<boolean> => {
    if (!channelId) return false;
    try {
      const res = await fetch(`/api/channels/${channelId}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) return false;
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
      return true;
    } catch {
      return false;
    }
  }, [channelId]);

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
      setError("No character selected");
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
      if (data.error === "password_required") {
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
          setError("Character not found");
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
        setChannel(channelData.channel);
        if (channelData.channel?.isOwner) setIsOwner(true);

        // Auto-join public channels
        if (channelData.channel?.isPublic && !channelData.channel?.isMember) {
          fetch(`/api/channels/${channelId}/join`, { method: "POST" }).catch(() => {});
        }

        // Set pending channel data for GameScene to read during create()
        // Parse mapData if it's a JSON string (SQLite stores as text)
        let rawMapData = channelData.channel.mapData;
        if (typeof rawMapData === "string") {
          try { rawMapData = JSON.parse(rawMapData); } catch { /* keep as string */ }
        }
        // Detect if mapData is actually Tiled JSON (has tiledversion field)
        const isTiledJson = rawMapData && typeof rawMapData === "object" && "tiledversion" in rawMapData;

        setPendingChannelData({
          channelId: channelData.channel.id,
          mapData: isTiledJson ? null : (rawMapData || null),
          tiledJson: isTiledJson ? rawMapData : null,
          mapConfig: typeof channelData.channel.mapConfig === "string"
            ? JSON.parse(channelData.channel.mapConfig)
            : (channelData.channel.mapConfig || null),
          savedPosition: channelData.channel.lastX != null && channelData.channel.lastY != null
            ? { x: channelData.channel.lastX, y: channelData.channel.lastY }
            : null,
        });

        // Composite character sprite
        const canvas = document.createElement("canvas");
        canvasRef.current = canvas;

        try {
          await compositeCharacter(canvas, found.appearance);
          const dataUrl = canvas.toDataURL("image/png");
          setSpritesheetDataUrl(dataUrl);
        } catch (err) {
          console.error("Failed to composite character:", err);
          setError("Failed to load character sprite");
        }

        setLoading(false);
      })
      .catch(() => {
        setError("Failed to load game data");
        setLoading(false);
      });
    })();
  }, [characterId, channelId]);

  // Fetch NPCs for this channel (for meeting room)
  useEffect(() => {
    if (!channelId) return;
    fetch(`/api/npcs?channelId=${channelId}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.npcs) setChannelNpcs(data.npcs);
      })
      .catch(() => {});
  }, [channelId]);

  // Emit owner status when scene is ready
  useEffect(() => {
    const onSceneReady = () => {
      EventBus.emit("owner-status", { isOwner });
    };
    EventBus.on("scene-ready", onSceneReady);
    return () => { EventBus.off("scene-ready", onSceneReady); };
  }, [isOwner]);

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
            agentId: pendingNpc.agentId, agentAction: pendingNpc.agentAction,
            identity: pendingNpc.identity, soul: pendingNpc.soul,
          }),
        });
        if (res.status === 409) return; // tile occupied, stay in placement mode
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
      } catch (err) { console.error("Failed to place NPC:", err); }
      finally { setPlacementMode(false); setPendingNpc(null); EventBus.emit("placement-mode-end"); }
    };
    const onPlacementCancel = () => { setPlacementMode(false); setPendingNpc(null); };
    EventBus.on("placement-complete", onPlacementComplete);
    EventBus.on("placement-cancel", onPlacementCancel);
    return () => { EventBus.off("placement-complete", onPlacementComplete); EventBus.off("placement-cancel", onPlacementCancel); };
  }, [placementMode, pendingNpc, channelId, socket]);

  // NPC management listeners (edit / fire)
  useEffect(() => {
    const onNpcEdit = (data: { npcId: string }) => {
      const npc = channelNpcs.find(n => n.id === data.npcId);
      if (!npc) return;
      setEditingNpc({
        id: npc.id, name: npc.name,
        persona: (npc as Record<string, unknown>).persona as string || "",
        appearance: npc.appearance,
        agentId: (npc as Record<string, unknown>).agentId as string | null || null,
      });
      setShowHireModal(true);
    };
    const onNpcFire = async (data: { npcId: string }) => {
      if (!confirm("Are you sure you want to fire this NPC?")) return;
      const firedNpcId = data.npcId;
      try {
        await fetch(`/api/npcs/${firedNpcId}`, { method: "DELETE" });
        const res = await fetch(`/api/npcs?channelId=${channelId}`);
        const npcsData = await res.json();
        setChannelNpcs(npcsData.npcs || []);
        // Remove NPC locally in GameScene
        EventBus.emit("npc:remove-local", { npcId: firedNpcId });
        // Broadcast to other players
        if (socket) socket.emit("npc:broadcast-remove", { npcId: firedNpcId });
        // Clean up tasks for the fired NPC
        setAllTasks((prev) => prev.filter((t) => t.npcId !== firedNpcId));
      } catch (err) { console.error("Failed to fire NPC:", err); }
    };
    EventBus.on("npc:edit", onNpcEdit);
    EventBus.on("npc:fire", onNpcFire);
    return () => { EventBus.off("npc:edit", onNpcEdit); EventBus.off("npc:fire", onNpcFire); };
  }, [channelNpcs, channelId, socket]);

  // NPC context menu handlers
  const handleCallNpc = useCallback(() => {
    if (!contextMenu || !socket) return;
    socket.emit("npc:call", { channelId, npcId: contextMenu.npcId });
    setContextMenu(null);
  }, [contextMenu, socket, channelId]);

  const handleContextTalk = useCallback(() => {
    if (!contextMenu) return;
    EventBus.emit("npc:interact", { npcId: contextMenu.npcId, npcName: contextMenu.npcName });
    setContextMenu(null);
  }, [contextMenu]);

  const handleReturnNpc = useCallback((npcId: string) => {
    if (!socket) return;
    socket.emit("npc:return-home", { channelId, npcId });
  }, [socket, channelId]);

  // ESC key to close context menu
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape" && contextMenu) {
        setContextMenu(null);
      }
    };
    const preventContextMenu = (e: MouseEvent) => e.preventDefault();
    window.addEventListener("keydown", handleEsc);
    window.addEventListener("contextmenu", preventContextMenu);
    return () => {
      window.removeEventListener("keydown", handleEsc);
      window.removeEventListener("contextmenu", preventContextMenu);
    };
  }, [contextMenu]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900 text-white">
        <div className="text-center">
          <div className="text-xl mb-2">Loading game...</div>
          <div className="text-gray-400">Preparing your character</div>
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
            Back to Characters
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen overflow-hidden bg-gray-900 text-white">
      {/* Game canvas — full screen background (hidden when in meeting mode) */}
      <div style={{ visibility: mode === "office" ? "visible" : "hidden", position: mode === "office" ? "relative" : "absolute", pointerEvents: mode === "office" ? "auto" : "none" }}>
        {spritesheetDataUrl && character && (
          <PhaserGame
            spritesheetDataUrl={spritesheetDataUrl}
            socket={socket}
            characterId={character.id}
            characterName={character.name}
            appearance={character.appearance}
          />
        )}
      </div>

      {/* Top bar — floating over game */}
      <div className="fixed top-0 left-0 right-0 z-10 flex items-center justify-between px-4 py-2 bg-black/50 backdrop-blur-sm">
        {/* Left: Channel name — Character name */}
        <h1 className="text-lg font-bold">
          {channel?.name || "DeskRPG"} &mdash; {character?.name}
        </h1>

        {/* Right: grouped controls */}
        <div className="flex items-center gap-1.5">
          {/* Players count */}
          <span className="text-caption text-text-dim px-1.5">{t("game.onlineCount", { count: playerCount })}</span>

          {/* Mode toggle */}
          <button
            onClick={() => setMode(mode === "office" ? "meeting" : "office")}
            className={`px-2.5 py-1 rounded-md text-caption font-semibold ${
              mode === "meeting"
                ? "bg-primary hover:bg-primary-hover text-white"
                : "bg-meeting/80 hover:bg-meeting text-white"
            }`}
          >
            {mode === "office" ? t("game.meetingRoom") : t("common.back")}
          </button>

          {/* Tasks button */}
          <button
            onClick={() => setShowTaskBoard(true)}
            className="flex items-center gap-1 px-2.5 py-1 bg-primary/80 hover:bg-primary text-white rounded-md text-caption font-semibold"
          >
            <ClipboardList className="w-3 h-3" /> {t("game.tasks")}
            {(() => { const n = allTasks.filter(t => t.status === "in_progress" || t.status === "pending").length; return n > 0 ? <span className="bg-white/20 px-1.5 rounded-full text-micro">{n}</span> : null; })()}
          </button>

          {/* Separator */}
          <div className="w-px h-5 bg-border" />

          {/* Unified menu dropdown */}
          <div className="relative">
            <button
              onClick={() => { setShowUserMenu(!showUserMenu); setShowSharePopup(false); }}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-caption text-text-secondary hover:text-white hover:bg-white/10 relative"
            >
              <Users className="w-3.5 h-3.5" />
              {character?.name}
              {notifications.some((n) => !n.read) && (
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-danger rounded-full" />
              )}
              <ChevronDown className="w-3 h-3" />
            </button>
            {showUserMenu && (
              <div className="absolute right-0 top-full mt-1 bg-surface border border-border rounded-lg shadow-xl w-56 z-50 py-1">
                {/* Character section */}
                <Link
                  href={`/characters/create?editId=${characterId}`}
                  className="block px-4 py-2 text-body text-text-secondary hover:bg-surface-raised hover:text-white flex items-center gap-2"
                  onClick={() => setShowUserMenu(false)}
                >
                  <Pencil className="w-3.5 h-3.5" />
                  {t("game.editCharacter")}
                </Link>

                {/* Channel section */}
                <div className="border-t border-border my-1" />
                {isOwner && mode === "office" && (
                  <button
                    onClick={() => { setShowHireModal(true); setShowUserMenu(false); }}
                    className="w-full text-left px-4 py-2 text-body text-text-secondary hover:bg-surface-raised hover:text-white flex items-center gap-2"
                  >
                    <UserPlus className="w-3.5 h-3.5" />
                    {t("game.hireNpc")}
                  </button>
                )}
                {isOwner && (
                  <button
                    onClick={() => { setShowChannelSettings(true); setShowUserMenu(false); }}
                    className="w-full text-left px-4 py-2 text-body text-text-secondary hover:bg-surface-raised hover:text-white flex items-center gap-2"
                  >
                    <Settings className="w-3.5 h-3.5" />
                    {t("game.settings")}
                  </button>
                )}
                {channel?.inviteCode && (
                  <button
                    onClick={() => { setShowSharePopup(!showSharePopup); setShowUserMenu(false); }}
                    className="w-full text-left px-4 py-2 text-body text-text-secondary hover:bg-surface-raised hover:text-white flex items-center gap-2"
                  >
                    <Share2 className="w-3.5 h-3.5" />
                    {t("game.share")}
                  </button>
                )}

                {/* Notifications section */}
                <div className="border-t border-border my-1" />
                <div className="px-4 py-2">
                  <div className="flex items-center justify-between mb-1">
                    <div className="text-caption text-text-dim flex items-center gap-1.5">
                      <Bell className="w-3.5 h-3.5" />
                      {t("game.notifications")}
                      {notifications.some((n) => !n.read) && (
                        <span className="bg-danger text-white text-micro px-1.5 rounded-full">
                          {notifications.filter((n) => !n.read).length}
                        </span>
                      )}
                    </div>
                    {notifications.length > 0 && (
                      <button
                        onClick={() => setNotifications((prev) => prev.map((n) => ({ ...n, read: true })))}
                        className="text-micro text-primary-light hover:text-primary"
                      >
                        {t("game.markAllRead")}
                      </button>
                    )}
                  </div>
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
          await fetch(`/api/npcs/${npcId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(updates),
          });
          const res = await fetch(`/api/npcs?channelId=${channelId}`);
          const data = await res.json();
          setChannelNpcs(data.npcs || []);
          setShowHireModal(false);
          setEditingNpc(null);
          if (socket) socket.emit("npc:broadcast-update", { npcId, ...updates });
        }}
        editingNpc={editingNpc}
        currentNpcCount={channelNpcs.length}
        hasGateway={!!channel?.hasGateway}
      />

      {showPasswordModal && channelId && (
        <PasswordModal
          channelName={channel?.name || "Private Channel"}
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
          onClose={() => setShowChannelSettings(false)}
          onUpdated={(data) => {
            setChannel((prev) => prev ? { ...prev, ...data } : prev);
          }}
        />
      )}

      <TaskBoard
        channelId={channelId!}
        isOpen={showTaskBoard}
        onClose={() => setShowTaskBoard(false)}
        tasks={allTasks}
        onDeleteTask={(taskId) => { if (socket) socket.emit("task:delete", { taskId }); }}
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
            channelChatInputDisabled={channelChatInputDisabled}
            onSendChannelChat={(message) => { if (socket) socket.emit("chat:send", { message }); }}
            currentPlayerName={character?.name}
            npcMoveState={dialogNpc ? npcMoveStates[dialogNpc.npcId] : undefined}
            onReturnNpc={dialogNpc && npcCallers[dialogNpc.npcId] === socket?.id ? handleReturnNpc : undefined}
            socket={socket}
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
            </div>
          </div>
        </>;
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
