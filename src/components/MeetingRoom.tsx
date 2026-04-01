"use client";

import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { Socket } from "socket.io-client";
import ChatInput from "./ChatInput";
import type {
  CharacterAppearance,
  LegacyCharacterAppearance,
} from "@/lib/lpc-registry";
import MinutesModal from "./MinutesModal";
import { useLocale, useT } from "@/lib/i18n";
import { ChevronDown, ChevronUp, Pause, Play } from "lucide-react";
import { buildSpeechBubblePreview } from "./meeting-room/speech-preview";
import { appendMeetingMessage } from "./meeting-room/message-state";
import { formatPollRaises, type PollRaiseItem } from "./meeting-room/poll-status";
import { clampMeetingSidebarWidth } from "./meeting-room/responsive";
import { computeMeetingTopicRows } from "./meeting-room/start-form";
import { consumeNpcStreamBuffer } from "./meeting-room/stream-state";
import { sanitizeClientFinalSpeech, sanitizeClientStreamingSpeech } from "./meeting-room/stream-text";
import MeetingSidebar from "./meeting-room/MeetingSidebar";
import MeetingTableScene, { type MeetingSceneSeat } from "./meeting-room/MeetingTableScene";
import { computeMeetingTableLayout } from "./meeting-room/layout";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Participant {
  id: string;
  name: string;
  appearance: CharacterAppearance | LegacyCharacterAppearance | null;
  type: "user" | "npc";
}

interface MeetingMessage {
  id: string;
  sender: string;
  senderId: string;
  senderType: "user" | "npc";
  content: string;
  timestamp: number;
}

interface PollStatus {
  status?: string;
  raises?: Array<string | PollRaiseItem>;
  passes?: string[];
}

interface MeetingRoomProps {
  channelId: string;
  character: {
    id: string;
    name: string;
    appearance: CharacterAppearance | LegacyCharacterAppearance;
  };
  socket: Socket | null;
  npcs: { id: string; name: string; appearance: unknown }[];
  onLeave: () => void;
}

// ---------------------------------------------------------------------------
// MeetingControlBar — mode toggle, next turn, direct speak, stop
// ---------------------------------------------------------------------------

function MeetingControlBar({
  mode, isWaiting, currentSpeaker, npcs, lastSpokeTimes,
  nowMs, onSetMode, onNextTurn, onDirectSpeak, onStop,
  t,
}: {
  mode: "auto" | "manual" | "directed";
  isWaiting: boolean;
  currentSpeaker: { npcId: string; npcName: string } | null;
  npcs: { id: string; name: string }[];
  lastSpokeTimes: Record<string, number>;
  nowMs: number;
  onSetMode: (mode: "auto" | "manual") => void;
  onNextTurn: () => void;
  onDirectSpeak: (npcId: string) => void;
  onStop: () => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const modeLabel = mode === "auto" ? t("meeting.modeAuto") : mode === "manual" ? t("meeting.modeManual") : t("meeting.modeDirected");

  const formatElapsed = (npcId: string) => {
    const lastTime = lastSpokeTimes[npcId];
    if (!lastTime) return t("meeting.waiting");
    const sec = Math.floor((nowMs - lastTime) / 1000);
    if (sec < 60) return t("meeting.secAgo", { sec });
    return t("meeting.minAgo", { min: Math.floor(sec / 60) });
  };

  return (
    <div className="border-t border-border bg-surface/80">
      {mode !== "auto" && (
        <div className="px-3 py-2 border-b border-border flex flex-wrap gap-1.5">
          <span className="text-caption text-text-dim self-center mr-1">{t("meeting.npcLabel")}</span>
          {npcs.map((npc) => {
            const isSpeaking = currentSpeaker?.npcId === npc.id;
            return (
              <button
                key={npc.id}
                onClick={() => onDirectSpeak(npc.id)}
                className={`px-2 py-1 rounded text-caption font-medium transition ${
                  isSpeaking
                    ? "bg-npc text-black animate-pulse"
                    : "bg-surface-raised hover:bg-surface-raised text-npc"
                }`}
              >
                {npc.name} <span className="text-text-muted ml-0.5">{formatElapsed(npc.id)}</span>
              </button>
            );
          })}
        </div>
      )}
      <div className="px-3 py-2 flex items-center gap-2">
        <button
          onClick={() => onSetMode(mode === "auto" ? "manual" : "auto")}
          className="px-2 py-1.5 rounded bg-surface-raised hover:bg-surface-raised text-text text-body"
          title={mode === "auto" ? t("meeting.pauseManual") : t("meeting.playAuto")}
        >
          {mode === "auto" ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
        </button>
        <button
          onClick={onNextTurn}
          disabled={mode === "auto" || !isWaiting}
          className={`px-2 py-1.5 rounded text-body ${
            mode !== "auto" && isWaiting
              ? "bg-surface-raised hover:bg-surface-raised text-text"
              : "bg-surface text-text-dim cursor-not-allowed"
          }`}
          title={t("meeting.nextTurnBtn")}
        >
          ⏭
        </button>
        <button
          onClick={onStop}
          className="px-2 py-1.5 rounded bg-danger-bg hover:bg-danger-hover text-text text-body"
          title={t("meeting.stopMeeting")}
        >
          ⏹
        </button>
        <span className="ml-auto text-caption text-text-muted">
          {mode === "auto" && !isWaiting && (
            <span className="text-success animate-pulse">{t("meeting.autoProgress")}</span>
          )}
          {mode !== "auto" && isWaiting && (
            <span className="text-npc">{t("meeting.nextTurn")}</span>
          )}
          {!isWaiting && mode !== "auto" && currentSpeaker && (
            <span className="text-npc">{t("meeting.isSpeaking", { name: currentSpeaker.npcName })}</span>
          )}
        </span>
        <span className="text-micro bg-surface-raised px-1.5 py-0.5 rounded text-text-secondary">
          {modeLabel}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MeetingRoom Component
// ---------------------------------------------------------------------------

export default function MeetingRoom({
  channelId,
  character,
  socket,
  npcs,
  onLeave,
}: MeetingRoomProps) {
  const t = useT();
  const { locale } = useLocale();
  const [messages, setMessages] = useState<MeetingMessage[]>([]);
  const [npcStreams, setNpcStreams] = useState<Record<string, string>>({});
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [input, setInput] = useState("");
  const [cooldown, setCooldown] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const joinedRef = useRef(false);
  const npcRawStreamsRef = useRef<Record<string, string>>({});
  const npcStreamsRef = useRef<Record<string, string>>({});
  const [meetingTopic, setMeetingTopic] = useState("");
  const [showStartOptions, setShowStartOptions] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(360);
  const [contentWidth, setContentWidth] = useState(0);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const characterRef = useRef({
    name: character.name,
    appearance: character.appearance,
  });
  const contentRef = useRef<HTMLDivElement>(null);
  const meetingTopicRef = useRef(meetingTopic);
  const npcsRef = useRef(npcs);
  const tRef = useRef(t);
  const suppressNextMeetingEndRef = useRef(false);

  // --- New state for broker-driven discussions ---
  const [meetingActive, setMeetingActive] = useState(false);
  const [startingMeeting, setStartingMeeting] = useState(false);
  const [currentSpeaker, setCurrentSpeaker] = useState<{
    npcId: string;
    npcName: string;
  } | null>(null);
  const [pollStatus, setPollStatus] = useState<PollStatus | null>(null);
  const [meetingMode, setMeetingMode] = useState<"auto" | "manual" | "directed">("auto");
  const [isWaitingInput, setIsWaitingInput] = useState(false);
  const [isInitiator, setIsInitiator] = useState(false);
  const [lastSpokeTimes, setLastSpokeTimes] = useState<Record<string, number>>({});

  // Start dialog settings
  const [startMode, setStartMode] = useState<"auto" | "manual">("auto");
  const [hybridMode, setHybridMode] = useState(false);
  const [hybridResumeMode, setHybridResumeMode] = useState<"manual" | "timer">("manual");
  const [hybridResumeSeconds, setHybridResumeSeconds] = useState(30);
  const npcSelectionKey = npcs.map((npc) => npc.id).join("|");
  const [selectedNpcIds, setSelectedNpcIds] = useState<Set<string>>(
    () => new Set(npcs.map((npc) => npc.id)),
  );
  const syncSelectedNpcIds = useEffectEvent((nextNpcs: MeetingRoomProps["npcs"]) => {
    setSelectedNpcIds(new Set(nextNpcs.map((npc) => npc.id)));
  });
  const [maxTurns, setMaxTurns] = useState(20);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Post-meeting state
  const [meetingEnded, setMeetingEnded] = useState(false);
  const [lastMeetingResult, setLastMeetingResult] = useState<{
    topic: string;
    keyTopics: string[];
    conclusions: string | null;
    minutesId: string | null;
    totalTurns: number;
    durationSeconds: number | null;
  } | null>(null);
  const [showMinutesModal, setShowMinutesModal] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);

  // Build current user as participant
  const currentUser: Participant = {
    id: socket?.id || "self",
    name: character.name,
    appearance: character.appearance,
    type: "user",
  };

  // Build NPC participants
  const npcParticipants: Participant[] = npcs.map((npc) => ({
    id: `npc-${npc.id}`,
    name: npc.name,
    appearance: npc.appearance as CharacterAppearance | LegacyCharacterAppearance | null,
    type: "npc" as const,
  }));

  // Merge remote users + NPCs for "others"
  const otherParticipants = [
    ...participants.filter((p) => p.id !== socket?.id),
    ...npcParticipants,
  ];

  useEffect(() => {
    characterRef.current = {
      name: character.name,
      appearance: character.appearance,
    };
  }, [character.appearance, character.name]);

  useEffect(() => {
    meetingTopicRef.current = meetingTopic;
  }, [meetingTopic]);

  useEffect(() => {
    npcsRef.current = npcs;
  }, [npcs]);

  useEffect(() => {
    tRef.current = t;
  }, [t]);

  useEffect(() => {
    syncSelectedNpcIds(npcs);
  }, [npcSelectionKey, npcs]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    const node = contentRef.current;
    if (!node) return;

    const updateWidth = () => {
      const nextWidth = node.getBoundingClientRect().width;
      setContentWidth(nextWidth);
      setSidebarWidth((prev) => clampMeetingSidebarWidth(prev, nextWidth));
    };

    updateWidth();

    const observer = new ResizeObserver(() => {
      updateWidth();
    });
    observer.observe(node);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isResizingSidebar) return;

    const handlePointerMove = (event: PointerEvent) => {
      const rect = contentRef.current?.getBoundingClientRect();
      if (!rect) return;

      const nextWidth = rect.right - event.clientX;
      setSidebarWidth(clampMeetingSidebarWidth(nextWidth, rect.width));
    };

    const stopResizing = () => {
      setIsResizingSidebar(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResizing);
    window.addEventListener("pointercancel", stopResizing);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResizing);
      window.removeEventListener("pointercancel", stopResizing);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizingSidebar]);

  // Join meeting room on mount
  useEffect(() => {
    if (!socket || joinedRef.current) return;
    joinedRef.current = true;

    socket.emit("meeting:join", {
      channelId,
      characterName: characterRef.current.name,
      appearance: characterRef.current.appearance,
    });

    // Listen for state sync (on join)
    const handleState = (data: {
      participants: { id: string; name: string; appearance: unknown }[];
      messages: MeetingMessage[];
    }) => {
      setParticipants(
        data.participants.map((p) => ({
          ...p,
          appearance: p.appearance as CharacterAppearance | LegacyCharacterAppearance | null,
          type: "user" as const,
        })),
      );
      // Start with empty chat — past messages are preserved in meeting minutes DB
      setMessages([]);
      npcRawStreamsRef.current = {};
      npcStreamsRef.current = {};
      setNpcStreams({});
    };

    const handleParticipantJoined = (data: {
      id: string;
      name: string;
      appearance: unknown;
    }) => {
      setParticipants((prev) => {
        if (prev.some((p) => p.id === data.id)) return prev;
        return [
          ...prev,
          {
            id: data.id,
            name: data.name,
            appearance: data.appearance as CharacterAppearance | LegacyCharacterAppearance | null,
            type: "user" as const,
          },
        ];
      });
    };

    const handleParticipantLeft = (data: { id: string }) => {
      setParticipants((prev) => prev.filter((p) => p.id !== data.id));
    };

    const handleMessage = (msg: MeetingMessage) => {
      const nextMessage = msg.senderType === "npc"
        ? {
          ...msg,
          content: sanitizeClientFinalSpeech(msg.content),
        }
        : msg;
      setMessages((prev) => appendMeetingMessage(prev, nextMessage));
    };

    const handleNpcStream = (data: {
      npcId: string;
      npcName?: string;
      chunk: string;
      done: boolean;
    }) => {
      if (data.done) {
        const npc = npcsRef.current.find((n) => n.id === data.npcId);
        const senderName = data.npcName || npc?.name || data.npcId;
        const timestamp = Date.now();

        // Track last spoke time
        setLastSpokeTimes((prev) => ({ ...prev, [data.npcId]: timestamp }));
        const result = consumeNpcStreamBuffer({
          streams: npcStreamsRef.current,
          npcId: data.npcId,
          fallbackSenderName: senderName,
          timestamp,
        });
        const nextRawStreams = { ...npcRawStreamsRef.current };
        delete nextRawStreams[data.npcId];
        npcRawStreamsRef.current = nextRawStreams;
      npcStreamsRef.current = result.nextStreams;
      setNpcStreams(result.nextStreams);
      if (result.finalizedMessage) {
        const finalizedMessage: MeetingMessage = {
          ...result.finalizedMessage,
          content: sanitizeClientFinalSpeech(result.finalizedMessage.content),
        };
        setMessages((msgs) => appendMeetingMessage(msgs, finalizedMessage));
      }
        setCurrentSpeaker(null);
      } else {
        if (data.chunk) {
          const nextRawStreams = {
            ...npcRawStreamsRef.current,
            [data.npcId]: (npcRawStreamsRef.current[data.npcId] || "") + data.chunk,
          };
          npcRawStreamsRef.current = nextRawStreams;
          const nextStreams = {
            ...npcStreamsRef.current,
            [data.npcId]: sanitizeClientStreamingSpeech(nextRawStreams[data.npcId]),
          };
          npcStreamsRef.current = nextStreams;
          setNpcStreams(nextStreams);
        }
      }
    };

    const handleNpcTurnStart = (data: { npcId: string; npcName: string }) => {
      setCurrentSpeaker({ npcId: data.npcId, npcName: data.npcName });
    };

    const handlePollStatus = (data: PollStatus) => {
      setPollStatus(data);
    };

    const handleMeetingEnd = (data: {
      transcript?: string;
      keyTopics?: string[];
      conclusions?: string | null;
      minutesId?: string | null;
      totalTurns?: number;
      durationSeconds?: number | null;
    }) => {
      if (suppressNextMeetingEndRef.current) {
        suppressNextMeetingEndRef.current = false;
        return;
      }

      setMeetingActive(false);
      setCurrentSpeaker(null);
      setPollStatus(null);

      setMeetingEnded(true);
      setLastMeetingResult({
        topic: meetingTopicRef.current,
        keyTopics: data.keyTopics || [],
        conclusions: data.conclusions || null,
        minutesId: data.minutesId || null,
        totalTurns: data.totalTurns || 0,
        durationSeconds: data.durationSeconds || null,
      });

      if (data.transcript) {
        const transcriptMsg: MeetingMessage = {
          id: `transcript-${Date.now()}`,
          sender: tRef.current("meeting.systemSender"),
          senderId: "system",
          senderType: "npc",
          content: `${tRef.current("meeting.endedTranscriptPrefix")}\n${data.transcript}`,
          timestamp: Date.now(),
        };
        setMessages((prev) => appendMeetingMessage(prev, transcriptMsg));
      }
    };

    const handleMeetingError = (data: { error: string }) => {
      const errorMsg: MeetingMessage = {
        id: `error-${Date.now()}`,
        sender: tRef.current("meeting.systemSender"),
        senderId: "system",
        senderType: "npc",
        content: `${tRef.current("meeting.errorPrefix")} ${data.error}`,
        timestamp: Date.now(),
      };
      setMessages((prev) => appendMeetingMessage(prev, errorMsg));
    };

    const handleModeChanged = (data: { mode: "auto" | "manual" | "directed"; by: string; initiatorId?: string }) => {
      setMeetingMode(data.mode);
      setIsWaitingInput(data.mode !== "auto");
    };

    const handleWaitingInput = (data: { pollResult?: PollStatus | null }) => {
      setIsWaitingInput(true);
      if (data.pollResult) setPollStatus(data.pollResult);
    };

    const handleTurnAborted = (data: { npcId: string }) => {
      const timestamp = Date.now();
      setLastSpokeTimes((prev) => ({ ...prev, [data.npcId]: timestamp }));
      const npc = npcsRef.current.find((n) => n.id === data.npcId);
      const result = consumeNpcStreamBuffer({
        streams: npcStreamsRef.current,
        npcId: data.npcId,
        fallbackSenderName: npc?.name || data.npcId,
        timestamp,
      });
      const nextRawStreams = { ...npcRawStreamsRef.current };
      delete nextRawStreams[data.npcId];
      npcRawStreamsRef.current = nextRawStreams;
      npcStreamsRef.current = result.nextStreams;
      setNpcStreams(result.nextStreams);
      if (result.finalizedMessage) {
        const abortedMessage: MeetingMessage = {
          ...result.finalizedMessage,
          id: `${result.finalizedMessage.id}-abort`,
          content: `${sanitizeClientFinalSpeech(result.finalizedMessage.content)} ${tRef.current("meeting.aborted")}`,
        };
        setMessages((msgs) => appendMeetingMessage(msgs, abortedMessage));
      }
      setCurrentSpeaker(null);
    };

    socket.on("meeting:state", handleState);
    socket.on("meeting:participant-joined", handleParticipantJoined);
    socket.on("meeting:participant-left", handleParticipantLeft);
    socket.on("meeting:message", handleMessage);
    socket.on("meeting:npc-stream", handleNpcStream);
    socket.on("meeting:npc-turn-start", handleNpcTurnStart);
    socket.on("meeting:poll-status", handlePollStatus);
    socket.on("meeting:end", handleMeetingEnd);
    socket.on("meeting:error", handleMeetingError);
    socket.on("meeting:mode-changed", handleModeChanged);
    socket.on("meeting:waiting-input", handleWaitingInput);
    socket.on("meeting:turn-aborted", handleTurnAborted);

    return () => {
      socket.off("meeting:state", handleState);
      socket.off("meeting:participant-joined", handleParticipantJoined);
      socket.off("meeting:participant-left", handleParticipantLeft);
      socket.off("meeting:message", handleMessage);
      socket.off("meeting:npc-stream", handleNpcStream);
      socket.off("meeting:npc-turn-start", handleNpcTurnStart);
      socket.off("meeting:poll-status", handlePollStatus);
      socket.off("meeting:end", handleMeetingEnd);
      socket.off("meeting:error", handleMeetingError);
      socket.off("meeting:mode-changed", handleModeChanged);
      socket.off("meeting:waiting-input", handleWaitingInput);
      socket.off("meeting:turn-aborted", handleTurnAborted);
      socket.emit("meeting:leave", { channelId });
      joinedRef.current = false;
    };
  }, [socket, channelId]);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, npcStreams]);

  const handleStartDiscussion = useCallback(() => {
    const topic = meetingTopic.trim();
    if (!topic || startingMeeting || !socket) return;
    setStartingMeeting(true);
    socket.emit("meeting:start-discussion", {
      channelId,
      topic,
      selectedNpcIds: Array.from(selectedNpcIds),
      settings: {
        initialMode: startMode,
        maxTotalTurns: maxTurns,
        hybridMode,
        hybridAutoResumeMs: hybridMode && hybridResumeMode === "timer"
          ? hybridResumeSeconds * 1000
          : null,
      },
    });
    setMeetingActive(true);
    setIsInitiator(true);
    setMeetingMode(startMode);
    setStartingMeeting(false);
  }, [meetingTopic, startingMeeting, socket, channelId, selectedNpcIds, startMode, maxTurns, hybridMode, hybridResumeMode, hybridResumeSeconds]);

  const handleEndMeeting = useCallback(() => {
    if (!socket) return;
    socket.emit("meeting:stop", { channelId });
  }, [socket, channelId]);

  const handleSetMode = useCallback((mode: "auto" | "manual") => {
    if (!socket) return;
    setMeetingMode(mode);
    setIsWaitingInput(mode !== "auto");
    socket.emit("meeting:set-mode", { channelId, mode });
  }, [socket, channelId]);

  const handleResetDiscussion = useCallback(() => {
    if (!socket || !meetingActive) return;
    if (!window.confirm(t("meeting.restartConfirm"))) return;

    suppressNextMeetingEndRef.current = true;
    socket.emit("meeting:stop", { channelId });
    setMeetingActive(false);
    setMeetingEnded(false);
    setLastMeetingResult(null);
    setMeetingMode(startMode);
    setIsWaitingInput(false);
    setCurrentSpeaker(null);
    setPollStatus(null);
    npcRawStreamsRef.current = {};
    npcStreamsRef.current = {};
    setNpcStreams({});
    setMessages([]);
    setShowExportMenu(false);
  }, [socket, meetingActive, t, channelId, startMode]);

  const handleSidebarResizeStart = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsResizingSidebar(true);
  }, []);

  const handleNextTurn = useCallback(() => {
    if (!socket) return;
    socket.emit("meeting:next-turn", { channelId });
    setIsWaitingInput(false);
  }, [socket, channelId]);

  const handleDirectSpeak = useCallback((npcId: string) => {
    if (!socket) return;
    socket.emit("meeting:direct-speak", { channelId, npcId });
    setIsWaitingInput(false);
  }, [socket, channelId]);

  const handleSend = useCallback((msg?: string) => {
    const trimmed = (msg ?? input).trim();
    if (!trimmed || cooldown || !socket) return;
    if (!msg) setInput("");
    if (meetingActive) {
      socket.emit("meeting:user-speak", { channelId, message: trimmed });
    } else {
      socket.emit("meeting:chat", { channelId, message: trimmed });
    }
    setCooldown(true);
    setTimeout(() => setCooldown(false), 2000);
  }, [input, cooldown, socket, channelId, meetingActive]);

  const sceneParticipants = [currentUser, ...otherParticipants];
  const layout = computeMeetingTableLayout({
    participantIds: sceneParticipants.map((participant) => participant.id),
  });
  const participantMap = new Map(
    sceneParticipants.map((participant) => [participant.id, participant] as const),
  );
  const currentSpeechPreview = currentSpeaker
    ? buildSpeechBubblePreview(npcStreams[currentSpeaker.npcId] || "")
    : null;
  const raiseNames = formatPollRaises(pollStatus?.raises);
  const tableAvailableWidth = contentWidth > 0
    ? Math.max(contentWidth - sidebarWidth - 32, 320)
    : 980;
  const sceneSeats: MeetingSceneSeat[] = layout.seats.map((seat) => {
    const participant = participantMap.get(seat.participantId);
    const isChair = seat.participantId === currentUser.id;
    const isSpeaking = Boolean(
      currentSpeaker &&
      participant?.type === "npc" &&
      participant.id === `npc-${currentSpeaker.npcId}`,
    );

    return {
      ...seat,
      name: participant?.name || "Unknown",
      appearance: participant?.appearance || null,
      isChair,
      isNpc: participant?.type === "npc",
      isSpeaking,
      speechPreview: isSpeaking ? currentSpeechPreview : null,
      isClickable: Boolean(participant?.type === "npc" && meetingActive && isInitiator),
      onClick:
        participant?.type === "npc" && meetingActive && isInitiator
          ? () => handleDirectSpeak(participant.id.replace(/^npc-/, ""))
          : undefined,
    };
  });

  // Collect streaming NPC messages for display
  const streamingEntries = Object.entries(npcStreams);

  // Shared meeting start form (used in pre-meeting and post-meeting views)
  const renderMeetingStartForm = () => (
    <>
      <button
        type="button"
        onClick={() => setShowStartOptions((prev) => !prev)}
        className="flex items-center justify-between rounded-lg border border-border bg-surface-raised/40 px-3 py-2 text-caption text-text-secondary hover:bg-surface-raised/60"
      >
        <span className="truncate">
          {`${showStartOptions ? t("common.hide") : t("common.show")} ${t("meeting.settings")} · ${selectedNpcIds.size}/${npcs.length} NPC · ${maxTurns}`}
        </span>
        {showStartOptions ? <ChevronUp className="h-4 w-4 shrink-0" /> : <ChevronDown className="h-4 w-4 shrink-0" />}
      </button>
      {showStartOptions && (
        <>
          {/* NPC Participant selection */}
          <div className="space-y-2 pt-2 border-t border-border">
            <p className="text-caption text-text-dim font-medium">{t("meeting.npcParticipants")}</p>
            {npcs.length === 0 ? (
              <p className="text-caption text-text-dim italic">{t("meeting.noNpcs")}</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {npcs.map((npc) => {
                  const isSelected = selectedNpcIds.has(npc.id);
                  return (
                    <label
                      key={npc.id}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-caption cursor-pointer border transition-colors ${
                        isSelected
                          ? "border-info bg-info/15 text-info"
                          : "border-border bg-surface-raised/50 text-text-muted"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={(e) => {
                          const next = new Set(selectedNpcIds);
                          if (e.target.checked) {
                            next.add(npc.id);
                          } else {
                            next.delete(npc.id);
                          }
                          setSelectedNpcIds(next);
                        }}
                        className="accent-info w-3 h-3"
                      />
                      {npc.name}
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          {/* Turn count slider */}
          <div className="space-y-1.5 pt-2 border-t border-border">
            <div className="flex items-center justify-between">
              <p className="text-caption text-text-dim font-medium">
                {t("meeting.maxTurns")}: <span className="text-info font-semibold">{maxTurns}</span>
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-caption text-text-dim">5</span>
              <input
                type="range"
                min={5}
                max={50}
                step={5}
                value={maxTurns}
                onChange={(e) => setMaxTurns(Number(e.target.value))}
                className="flex-1 accent-info"
              />
              <span className="text-caption text-text-dim">50</span>
            </div>
          </div>

          <div className="space-y-2 pt-2 border-t border-border">
            <p className="text-caption text-text-dim font-medium">{t("meeting.settings")}</p>
            <div className="flex items-center gap-3 text-caption">
              <span className="text-text-muted w-16">{t("meeting.startMode")}</span>
              <label className="flex items-center gap-1 text-text-secondary cursor-pointer">
                <input type="radio" name="startMode" checked={startMode === "auto"} onChange={() => setStartMode("auto")} className="accent-primary" />
                {t("meeting.modeAuto")}
              </label>
              <label className="flex items-center gap-1 text-text-secondary cursor-pointer">
                <input type="radio" name="startMode" checked={startMode === "manual"} onChange={() => setStartMode("manual")} className="accent-primary" />
                {t("meeting.modeManual")}
              </label>
            </div>
            <label className="flex items-center gap-2 text-caption text-text-secondary cursor-pointer">
              <input type="checkbox" checked={hybridMode} onChange={(e) => setHybridMode(e.target.checked)} className="accent-primary" />
              {t("meeting.hybridModeDesc")}
            </label>
            {hybridMode && (
              <div className="ml-5 space-y-1">
                <label className="flex items-center gap-1 text-caption text-text-muted cursor-pointer">
                  <input type="radio" name="hybridResume" checked={hybridResumeMode === "manual"} onChange={() => setHybridResumeMode("manual")} className="accent-primary" />
                  {t("meeting.manualResume")}
                </label>
                <label className="flex items-center gap-1 text-caption text-text-muted cursor-pointer">
                  <input type="radio" name="hybridResume" checked={hybridResumeMode === "timer"} onChange={() => setHybridResumeMode("timer")} className="accent-primary" />
                  <input type="number" min={5} max={120} value={hybridResumeSeconds} onChange={(e) => setHybridResumeSeconds(Math.max(5, Math.min(120, Number(e.target.value) || 30)))} className="w-12 bg-surface-raised text-text px-1 py-0.5 rounded border border-border text-caption text-center" disabled={hybridResumeMode !== "timer"} />
                  {t("meeting.timerResumeAfter")}
                </label>
              </div>
            )}
          </div>
        </>
      )}
      <textarea
        value={meetingTopic}
        onChange={(e) => setMeetingTopic(e.target.value.slice(0, 200))}
        rows={computeMeetingTopicRows(meetingTopic)}
        onKeyDown={(e) => {
          if (
            e.key === "Enter" &&
            !e.nativeEvent.isComposing &&
            (e.metaKey || e.ctrlKey)
          ) {
            e.preventDefault();
            handleStartDiscussion();
          }
        }}
        placeholder={t("meeting.topicPlaceholder")}
        className="w-full resize-none overflow-y-auto bg-surface-raised text-text px-3 py-2 rounded border border-border focus:ring-2 focus:ring-primary-light focus:border-transparent focus:outline-none text-body leading-relaxed"
        maxLength={200}
      />
    </>
  );

  return (
    <div className="fixed inset-0 z-5 flex flex-col bg-bg text-text">
      {/* Main content: table + chat side by side */}
      <div ref={contentRef} className="flex-1 flex min-h-0 pt-[44px]">
        {/* Left: Meeting Table visualization */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex-1 p-4">
            <MeetingTableScene
              availableWidth={tableAvailableWidth}
              layout={layout}
              seats={sceneSeats}
            />
          </div>
          {meetingActive && isInitiator && (
            <MeetingControlBar
              mode={meetingMode}
              isWaiting={isWaitingInput}
              currentSpeaker={currentSpeaker}
              npcs={npcs}
              lastSpokeTimes={lastSpokeTimes}
              nowMs={nowMs}
              onSetMode={handleSetMode}
              onNextTurn={handleNextTurn}
              onDirectSpeak={handleDirectSpeak}
              onStop={handleEndMeeting}
              t={t}
            />
          )}
        </div>

        <MeetingSidebar
          participantCount={sceneSeats.length}
          title={t("meeting.groupChat")}
          width={sidebarWidth}
          onResizeStart={handleSidebarResizeStart}
          isResizing={isResizingSidebar}
          actions={(
            <>
              <button
                onClick={() => setShowMinutesModal(true)}
                className="px-2.5 py-1 bg-surface-raised hover:bg-surface-raised border border-border rounded-lg text-info text-caption"
              >
                {t("minutes.title")}
              </button>
              {meetingActive && isInitiator && (
                <button
                  onClick={handleResetDiscussion}
                  className="px-2.5 py-1 rounded-lg border border-border bg-surface-raised hover:bg-surface-raised text-text text-caption"
                >
                  {t("meeting.restart")}
                </button>
              )}
              {meetingActive && !isInitiator && (
                <button
                  onClick={onLeave}
                  className="px-2 py-1 rounded text-caption font-semibold bg-surface-raised hover:bg-surface-raised text-text shrink-0"
                >
                  {t("common.leave")}
                </button>
              )}
            </>
          )}
          statusBar={meetingActive && pollStatus ? (
            <div className="flex flex-wrap gap-1 items-center">
              <span className="text-npc font-semibold">{t("meeting.polling")}</span>
              {raiseNames.length > 0 && (
                <span className="text-success">
                  {t("meeting.raiseLabel")} {raiseNames.join(", ")}
                </span>
              )}
              {pollStatus.passes && pollStatus.passes.length > 0 && (
                <span className="text-text-dim">
                  {t("meeting.passLabel")} {pollStatus.passes.join(", ")}
                </span>
              )}
              {pollStatus.status && (
                <span className="text-text-muted">{pollStatus.status}</span>
              )}
            </div>
          ) : null}
        >

          {/* Messages or Topic Input */}
          {meetingActive ? (
            <div className="h-full flex flex-col min-h-0 overflow-hidden">
              {/* Active meeting messages */}
              <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
                {messages.length === 0 && streamingEntries.length === 0 && (
                  <div className="text-text-dim text-body italic py-8 text-center">
                    {t("meeting.discussionStarted")}
                  </div>
                )}
                {messages.map((msg) => {
                  const isMe = msg.senderId === socket?.id;
                  const isNpc = msg.senderType === "npc";
                  return (
                    <div
                      key={msg.id}
                      className={`flex ${isMe ? "justify-end" : "justify-start"}`}
                    >
                      <div className="max-w-[85%]">
                        {!isMe && (
                          <div
                            className={`text-micro font-medium mb-0.5 ${
                              isNpc ? "text-npc" : "text-text-muted"
                            }`}
                          >
                            {msg.sender}
                          </div>
                        )}
                        <div
                          className={`px-3 py-2 rounded-lg text-body ${
                            isMe
                              ? "bg-primary text-white"
                              : isNpc
                                ? "bg-surface-raised text-text border border-npc/30"
                                : msg.senderId === "system"
                                  ? "bg-surface text-text-muted border border-border italic text-caption"
                                  : "bg-surface-raised text-text"
                          }`}
                        >
                          {msg.content}
                        </div>
                      </div>
                    </div>
                  );
                })}

                {/* Speaking indicator above streaming */}
                {currentSpeaker && (
                  <div className="flex justify-start">
                    <div className="text-micro text-npc italic px-1">
                      {t("meeting.isSpeaking", { name: currentSpeaker.npcName })}
                    </div>
                  </div>
                )}

                {/* Streaming NPC messages */}
                {streamingEntries.map(([npcId, content]) => {
                  const npc = npcs.find((n) => n.id === npcId);
                  const speakerName =
                    currentSpeaker?.npcId === npcId
                      ? currentSpeaker.npcName
                      : npc?.name || npcId;
                  return (
                    <div key={`stream-${npcId}`} className="flex justify-start">
                      <div className="max-w-[85%]">
                        <div className="text-micro font-medium mb-0.5 text-npc">
                          {speakerName}
                        </div>
                        <div className="px-3 py-2 rounded-lg text-body bg-surface-raised text-text border border-npc/30">
                          {content}
                          <span className="inline-block w-1.5 h-4 bg-npc ml-0.5 animate-pulse" />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Input for active meeting */}
              <div className="sticky bottom-0 z-10 flex-shrink-0 border-t border-border bg-bg/95 backdrop-blur supports-[backdrop-filter]:bg-bg/85">
                <ChatInput
                  onSend={(msg) => handleSend(msg)}
                  placeholder={t("meeting.speakToMeeting")}
                  cooldown={cooldown}
                  accentColor="indigo"
                  autoFocus
                />
              </div>
            </div>
          ) : meetingEnded && lastMeetingResult ? (
            /* ---- Post-meeting hybrid view ---- */
            <div className="h-full flex flex-col min-h-0 overflow-hidden">
              {/* Scrollable content */}
              <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
                {/* Completion badge */}
                <div className="flex justify-center">
                  <span className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-success/15 border border-success/40 text-success text-body font-semibold rounded-full">
                    {t("meeting.ended")}
                  </span>
                </div>

                {/* Summary card */}
                <div className="bg-surface rounded-lg p-4 border border-border space-y-3">
                  <h3 className="text-title text-text">{lastMeetingResult.topic}</h3>

                  {/* Stats grid */}
                  <div className="grid grid-cols-2 gap-2">
                    <div className="bg-surface-raised/50 rounded px-3 py-2 text-center">
                      <div className="text-heading font-bold text-info">{sceneSeats.length}</div>
                      <div className="text-micro text-text-muted">{t("meeting.participantCount")}</div>
                    </div>
                    <div className="bg-surface-raised/50 rounded px-3 py-2 text-center">
                      <div className="text-heading font-bold text-npc">{lastMeetingResult.totalTurns}</div>
                      <div className="text-micro text-text-muted">{t("meeting.totalTurns")}</div>
                    </div>
                  </div>

                  {/* Key topics & conclusions */}
                  {lastMeetingResult.keyTopics.length > 0 || lastMeetingResult.conclusions ? (
                    <>
                      {lastMeetingResult.keyTopics.length > 0 && (
                        <div className="space-y-1">
                          <p className="text-caption text-text-dim font-medium">{t("meeting.keyTopics")}</p>
                          <ul className="space-y-0.5">
                            {lastMeetingResult.keyTopics.map((topic, i) => (
                              <li key={i} className="text-caption text-text-secondary flex items-start gap-1.5">
                                <span className="text-info mt-0.5">•</span>
                                <span>{topic}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {lastMeetingResult.conclusions && (
                        <div className="space-y-1">
                          <p className="text-caption text-text-dim font-medium">{t("meeting.conclusions")}</p>
                          <p className="text-caption text-text-secondary leading-relaxed">{lastMeetingResult.conclusions}</p>
                        </div>
                      )}
                    </>
                  ) : (
                    <p className="text-caption text-text-dim italic text-center py-2">{t("meeting.noSummary")}</p>
                  )}
                </div>

                {/* Divider */}
                <div className="border-t border-border" />

                {/* New meeting form */}
                <div className="space-y-3">
                  <h4 className="text-title text-text-secondary text-center">{t("meeting.newMeeting")}</h4>
                  {renderMeetingStartForm()}
                  <button
                    onClick={() => {
                      setMeetingEnded(false);
                      setLastMeetingResult(null);
                      setMessages([]);
                      handleStartDiscussion();
                    }}
                    disabled={!meetingTopic.trim() || startingMeeting || selectedNpcIds.size === 0}
                    className={`w-full px-4 py-2 rounded font-semibold text-body ${
                      meetingTopic.trim() && !startingMeeting && selectedNpcIds.size > 0
                        ? "bg-primary hover:bg-primary-hover text-white"
                        : "bg-surface-raised text-text-dim cursor-not-allowed"
                    }`}
                  >
                    {startingMeeting ? t("meeting.starting") : t("meeting.startDiscussion")}
                  </button>
                </div>
              </div>

              {/* Fixed bottom bar */}
              <div className="px-4 py-3 border-t border-border bg-surface/80 flex items-center gap-2 flex-shrink-0">
                <div className="relative">
                  <button
                    onClick={() => setShowExportMenu((v) => !v)}
                    className="px-3 py-2 rounded text-caption font-semibold bg-surface-raised hover:bg-surface-raised text-text-secondary border border-border"
                  >
                    {t("meeting.export")}
                  </button>
                  {showExportMenu && (
                    <div className="absolute bottom-full left-0 mb-1 bg-surface border border-border rounded-lg shadow-lg py-1 min-w-[140px] z-10">
                      <button
                        onClick={async () => {
                          if (!lastMeetingResult.minutesId) return;
                          try {
                            const params = new URLSearchParams({ format: "md", locale });
                            const a = document.createElement("a");
                            a.href = `/api/meetings/${lastMeetingResult.minutesId}/export?${params.toString()}`;
                            a.download = "";
                            a.click();
                          } catch { /* ignore */ }
                          setShowExportMenu(false);
                        }}
                        className="w-full px-3 py-1.5 text-left text-caption text-text-secondary hover:bg-surface-raised"
                      >
                        {t("meeting.exportMd")}
                      </button>
                      <button
                        onClick={async () => {
                          if (!lastMeetingResult.minutesId) return;
                          try {
                            const params = new URLSearchParams({ format: "clipboard", locale });
                            const res = await fetch(`/api/meetings/${lastMeetingResult.minutesId}/export?${params.toString()}`);
                            const data = await res.json();
                            if (data.text) {
                              await navigator.clipboard.writeText(data.text);
                            }
                          } catch { /* ignore */ }
                          setShowExportMenu(false);
                        }}
                        className="w-full px-3 py-1.5 text-left text-caption text-text-secondary hover:bg-surface-raised"
                      >
                        {t("meeting.exportClipboard")}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            /* ---- Pre-meeting view ---- */
            <div className="h-full flex flex-col min-h-0 overflow-hidden">
              {/* Existing messages area */}
              <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
                {messages.length === 0 ? (
                  <div className="text-text-dim text-body italic py-4 text-center">
                    {t("meeting.noMessages")}
                  </div>
                ) : (
                  messages.map((msg) => {
                    const isMe = msg.senderId === socket?.id;
                    const isNpc = msg.senderType === "npc";
                    return (
                      <div
                        key={msg.id}
                        className={`flex ${isMe ? "justify-end" : "justify-start"}`}
                      >
                        <div className="max-w-[85%]">
                          {!isMe && (
                            <div
                              className={`text-micro font-medium mb-0.5 ${
                                isNpc ? "text-npc" : "text-text-muted"
                              }`}
                            >
                              {msg.sender}
                            </div>
                          )}
                          <div
                            className={`px-3 py-2 rounded-lg text-body ${
                              isMe
                                ? "bg-primary text-white"
                                : isNpc
                                  ? "bg-surface-raised text-text border border-npc/30"
                                  : "bg-surface-raised text-text"
                            }`}
                          >
                            {msg.content}
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              {/* Topic input form */}
              <div className="px-4 py-4 border-t border-border bg-surface/60 flex-shrink-0">
                <div className="bg-surface rounded-lg p-4 flex flex-col gap-3 border border-border">
                  {renderMeetingStartForm()}
                  <button
                    onClick={handleStartDiscussion}
                    disabled={!meetingTopic.trim() || startingMeeting || selectedNpcIds.size === 0}
                    className={`w-full px-4 py-2 rounded font-semibold text-body ${
                      meetingTopic.trim() && !startingMeeting && selectedNpcIds.size > 0
                        ? "bg-primary hover:bg-primary-hover text-white"
                        : "bg-surface-raised text-text-dim cursor-not-allowed"
                    }`}
                  >
                    {startingMeeting ? t("meeting.starting") : t("meeting.startDiscussion")}
                  </button>
                </div>
              </div>
            </div>
          )}
        </MeetingSidebar>
      </div>

      {showMinutesModal && (
        <MinutesModal channelId={channelId} onClose={() => setShowMinutesModal(false)} />
      )}
    </div>
  );
}
