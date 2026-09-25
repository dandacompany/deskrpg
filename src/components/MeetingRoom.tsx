"use client";

import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import ChatInput from "./ChatInput";
import MeetingOutcomeSection from "./meeting-room/MeetingOutcomeSection";
import { useMeetingAutoReturn } from "./meeting-room/use-meeting-auto-return";
import MinutesModal from "./MinutesModal";
import { useLocale, useT } from "@/lib/i18n";
import { ChevronDown, ChevronUp, Pause, Play } from "lucide-react";
import { appendMeetingMessage } from "./meeting-room/message-state";
import { mentionSkipI18nKey } from "./meeting-room/mention-skip-notice";
import { formatPollRaises, formatPollPasses, type PollRaiseItem } from "./meeting-room/poll-status";
import {
  restoreMeetingNpcs,
  type MeetingDiscussionState,
  type MeetingSpatialState,
} from "@/lib/meeting-discussion-state";
import { selectMeetingNpcs } from "./meeting-room/participants";
import { EventBus } from "@/game/EventBus";
import { MeetingSpeakerTracker } from "./meeting-room/speaker-tracker";
import ToolApprovalStack from "./approvals/ToolApprovalCard";
import MeetingTopicInput, { canSubmitMeetingTopic } from "./meeting-room/MeetingTopicInput";
import { meetingOverflow, type MeetingCapacity } from "./meeting-room/capacity";
import {
  restoreMeetingChat,
  restoreMeetingExecution,
  type MeetingExecutionState,
} from "./meeting-room/restore-state";
import { consumeNpcStreamBuffer } from "./meeting-room/stream-state";
import {
  sanitizeClientFinalSpeech,
  sanitizeClientStreamingSpeech,
} from "./meeting-room/stream-text";
import MeetingSidebar from "./meeting-room/MeetingSidebar";
import { useMeetingStop } from "./meeting-room/use-meeting-stop";
import RosterAvatar from "./RosterAvatar";
import { createAvatarLookup } from "@/app/game/avatar-lookup";
import { CHAT_AVATAR_SIZE } from "./ui/ChatBubble";
import { meetingErrorCode, meetingErrorMessage } from "@/lib/meeting-error";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Participant {
  id: string;
  userId?: string;
  name: string;
  appearance: unknown;
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
    appearance: unknown;
  };
  socket: Socket | null;
  npcs: { id: string; name: string; appearance: unknown }[];
  onLeave: () => void;
}

// ---------------------------------------------------------------------------
// MeetingControlBar — mode toggle, next turn, direct speak, stop
// ---------------------------------------------------------------------------

export function MeetingControlBar({
  mode,
  isWaiting,
  stopping = false,
  currentSpeaker,
  npcs,
  lastSpokeTimes,
  nowMs,
  onSetMode,
  onNextTurn,
  onDirectSpeak,
  onStop,
  t,
}: {
  mode: "auto" | "manual" | "directed";
  isWaiting: boolean;
  /** `meeting:stop` was sent and the meeting has not ended yet — the controls are locked. */
  stopping?: boolean;
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
  const modeLabel =
    mode === "auto"
      ? t("meeting.modeAuto")
      : mode === "manual"
        ? t("meeting.modeManual")
        : t("meeting.modeDirected");

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
          <span className="text-caption text-text-dim self-center mr-1">
            {t("meeting.npcLabel")}
          </span>
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
          disabled={stopping}
          className="px-2 py-1.5 rounded bg-surface-raised hover:bg-surface-raised text-text text-body disabled:opacity-50"
          title={mode === "auto" ? t("meeting.pauseManual") : t("meeting.playAuto")}
        >
          {mode === "auto" ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
        </button>
        <button
          onClick={onNextTurn}
          disabled={stopping || mode === "auto" || !isWaiting}
          className={`px-2 py-1.5 rounded text-body ${
            !stopping && mode !== "auto" && isWaiting
              ? "bg-surface-raised hover:bg-surface-raised text-text"
              : "bg-surface text-text-dim cursor-not-allowed"
          }`}
          title={t("meeting.nextTurnBtn")}
        >
          ⏭
        </button>
        <button
          data-meeting-stop
          onClick={onStop}
          disabled={stopping}
          className="px-2 py-1.5 rounded bg-danger-bg hover:bg-danger-hover text-text text-body disabled:opacity-50 disabled:cursor-not-allowed"
          title={t("meeting.stopMeeting")}
        >
          ⏹
        </button>
        <span className="ml-auto text-caption text-text-muted">
          {stopping && (
            <span data-meeting-stopping className="text-danger animate-pulse">
              {t("meeting.stopping")}
            </span>
          )}
          {!stopping && mode === "auto" && !isWaiting && (
            <span className="text-success animate-pulse">{t("meeting.autoProgress")}</span>
          )}
          {!stopping && mode !== "auto" && isWaiting && (
            <span className="text-npc">{t("meeting.nextTurn")}</span>
          )}
          {!stopping && !isWaiting && mode !== "auto" && currentSpeaker && (
            <span className="text-npc">
              {t("meeting.isSpeaking", { name: currentSpeaker.npcName })}
            </span>
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
  const [capacity, setCapacity] = useState<MeetingCapacity | null>(null);
  useEffect(() => {
    EventBus.on("meeting:capacity", setCapacity);
    EventBus.emit("meeting:capacity-request");
    return () => {
      EventBus.off("meeting:capacity", setCapacity);
    };
  }, []);
  const [input, setInput] = useState("");
  const [cooldown, setCooldown] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const joinedRef = useRef(false);
  const npcRawStreamsRef = useRef<Record<string, string>>({});
  const npcStreamsRef = useRef<Record<string, string>>({});
  const [meetingTopic, setMeetingTopic] = useState("");
  const [showStartOptions, setShowStartOptions] = useState(false);
  const [joinState, setJoinState] = useState<"joining" | "joined" | "disconnected">(() =>
    socket?.connected ? "joining" : "disconnected",
  );
  const [spatial, setSpatial] = useState<MeetingSpatialState | null>(null);
  const [meetingError, setMeetingError] = useState<string | null>(null);
  const characterRef = useRef({
    name: character.name,
    appearance: character.appearance,
  });
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

  const [discussionNpcs, setDiscussionNpcs] = useState<MeetingRoomProps["npcs"] | null>(null);
  const participantCountRef = useRef(0);

  // Post-meeting state
  const [meetingEnded, setMeetingEnded] = useState(false);
  const [lastMeetingResult, setLastMeetingResult] = useState<{
    topic: string;
    keyTopics: string[];
    conclusions: string | null;
    minutesId: string | null;
    totalTurns: number;
    durationSeconds: number | null;
    participantCount: number;
  } | null>(null);
  // Only while the end screen is up — once follow-up tasks are registered, return to the office to hear the report.
  const autoReturn = useMeetingAutoReturn(meetingEnded && lastMeetingResult !== null);
  const endedWithoutMinutes = meetingEnded && lastMeetingResult?.minutesId === null;
  const { hint: hintAutoReturn } = autoReturn;
  useEffect(() => {
    // With no minutes, there's nothing to register — just a hint.
    if (endedWithoutMinutes) hintAutoReturn();
  }, [endedWithoutMinutes, hintAutoReturn]);
  const [showMinutesModal, setShowMinutesModal] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);

  // Build current user as participant
  const currentUser: Participant = {
    id: socket?.id || "self",
    userId: participants.find((participant) => participant.id === socket?.id)?.userId,
    name: character.name,
    appearance: character.appearance,
    type: "user",
  };

  // Avatar for a speech bubble — look up employees from the channel roster, people from meeting participants (socket id).
  const meetingAvatarFor = createAvatarLookup(
    npcs,
    participants.map((participant) => ({
      userId: participant.id,
      name: participant.name,
      appearance: participant.appearance,
    })),
  );

  // Build NPC participants
  const displayedNpcs = discussionNpcs ?? selectMeetingNpcs(npcs, selectedNpcIds);
  // Names for approval cards — the channel roster plus whoever the discussion itself carries.
  const npcNames = Object.fromEntries(
    [...npcs, ...(discussionNpcs ?? [])].map((npc) => [npc.id, npc.name]),
  );
  const npcParticipants: Participant[] = displayedNpcs.map((npc) => ({
    id: `npc-${npc.id}`,
    name: npc.name,
    appearance: npc.appearance,
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

  // Join meeting room on mount
  useEffect(() => {
    if (!socket || joinedRef.current) return;
    joinedRef.current = true;

    let confirmed = false;
    let joinTimer: ReturnType<typeof setTimeout> | undefined;
    let roster: Array<{ id: string; userId?: string }> = [];
    const speaker = new MeetingSpeakerTracker((next) => EventBus.emit("meeting:speaker", next));

    // Listen for state sync (on join)
    const handleState = (data: {
      participants: { id: string; userId?: string; name: string; appearance: unknown }[];
      messages: MeetingMessage[];
      discussion?: MeetingDiscussionState | null;
      isInitiator?: boolean;
      spatial?: MeetingSpatialState | null;
    }) => {
      confirmed = true;
      roster = data.participants;
      clearTimeout(joinTimer);
      setJoinState("joined");
      setMeetingError(null);
      setSpatial(data.spatial ?? null);
      setStartingMeeting(
        data.spatial?.phase === "assembling" ||
          (data.spatial?.phase === "ready" && !data.discussion),
      );
      EventBus.emit("meeting:joined");
      if (data.discussion) {
        setDiscussionNpcs(restoreMeetingNpcs(data.discussion.npcs, npcsRef.current));
        setMeetingTopic(data.discussion.topic);
        meetingTopicRef.current = data.discussion.topic;
        setMeetingActive(true);
        setMeetingEnded(false);
        setLastMeetingResult(null);
        setMeetingMode(data.discussion.mode);
        setIsInitiator(data.isInitiator === true);
      } else {
        setMeetingActive(false);
        setDiscussionNpcs(null);
        setIsInitiator(false);
      }
      setParticipants(
        data.participants.map((p) => ({
          ...p,
          appearance: p.appearance,
          type: "user" as const,
        })),
      );
      const restored = restoreMeetingChat(data.discussion, data.messages);
      setMessages(restored.messages);
      setIsWaitingInput(restored.isWaitingInput);
      setCurrentSpeaker(restored.currentSpeaker);
      npcRawStreamsRef.current = restored.rawStreams;
      npcStreamsRef.current = restored.streams;
      setNpcStreams(restored.streams);
      if (restored.currentSpeaker && restored.streams[restored.currentSpeaker.npcId])
        speaker.stream(
          restored.currentSpeaker.npcId,
          restored.streams[restored.currentSpeaker.npcId],
        );
      else speaker.finish();
    };

    const handleParticipantJoined = (data: {
      id: string;
      userId?: string;
      name: string;
      appearance: unknown;
    }) => {
      roster = [...roster.filter((p) => p.id !== data.id), data];
      setParticipants((prev) => {
        if (prev.some((p) => p.id === data.id)) return prev;
        return [
          ...prev,
          {
            id: data.id,
            userId: data.userId,
            name: data.name,
            appearance: data.appearance,
            type: "user" as const,
          },
        ];
      });
    };

    const handleParticipantLeft = (data: { id: string }) => {
      roster = roster.filter((p) => p.id !== data.id);
      setParticipants((prev) => prev.filter((p) => p.id !== data.id));
    };

    const handleMessage = (msg: MeetingMessage) => {
      if (msg.senderType === "user") speaker.user(msg.senderId, msg.id, roster);
      const nextMessage =
        msg.senderType === "npc"
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
      /** Only arrives at the end of a turn (done) — the final body, same as what's kept in the meeting record. */
      text?: unknown;
    }) => {
      if (data.done) {
        speaker.finish(data.npcId);
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
          finalText: typeof data.text === "string" ? data.text : undefined,
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
          speaker.stream(data.npcId, nextStreams[data.npcId]);
        }
      }
    };

    const handleNpcTurnStart = (data: { npcId: string; npcName: string }) => {
      speaker.turn(data.npcId);
      setIsWaitingInput(false);
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
      discussion?: MeetingDiscussionState;
      participantCount?: number;
    }) => {
      if (suppressNextMeetingEndRef.current) {
        suppressNextMeetingEndRef.current = false;
        return;
      }

      setMeetingActive(false);
      speaker.finish();
      setStartingMeeting(false);
      setCurrentSpeaker(null);
      setPollStatus(null);

      setMeetingEnded(true);
      if (data.discussion)
        setDiscussionNpcs(restoreMeetingNpcs(data.discussion.npcs, npcsRef.current));
      setLastMeetingResult({
        topic: data.discussion?.topic ?? meetingTopicRef.current,
        keyTopics: data.keyTopics || [],
        conclusions: data.conclusions || null,
        minutesId: data.minutesId || null,
        totalTurns: data.totalTurns || 0,
        durationSeconds: data.durationSeconds || null,
        participantCount: data.participantCount ?? participantCountRef.current,
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

    // If the server is an old version and sends an object, don't render [object Object] — only use the code when it's a string.
    const handleMeetingError = (data: { error?: unknown; detail?: unknown }) => {
      clearTimeout(joinTimer);
      setStartingMeeting(false);
      const code = meetingErrorCode(data.error);
      const text = meetingErrorMessage(data, tRef.current);
      setMeetingError(text);
      if (!confirmed) EventBus.emit("meeting:join-failed", { reasonCode: code });
      const errorMsg: MeetingMessage = {
        id: `error-${Date.now()}`,
        sender: tRef.current("meeting.systemSender"),
        senderId: "system",
        senderType: "npc",
        content: `${tRef.current("meeting.errorPrefix")} ${text}`,
        timestamp: Date.now(),
      };
      setMessages((prev) => appendMeetingMessage(prev, errorMsg));
    };

    const handleMentionSkipped = (data: {
      npcId: string;
      npcName: string;
      reason: "quota_exhausted" | "backend_failing";
    }) => {
      // Picked from a table, not a ternary — the compiler catches it when a new reason is added (mention-skip-notice.ts).
      const i18nKey = mentionSkipI18nKey(data.reason);
      const infoMsg: MeetingMessage = {
        id: `mention-skipped-${Date.now()}-${data.npcId}`,
        sender: tRef.current("meeting.systemSender"),
        senderId: "system",
        senderType: "npc",
        content: tRef.current(i18nKey, { name: data.npcName }),
        timestamp: Date.now(),
      };
      setMessages((prev) => appendMeetingMessage(prev, infoMsg));
    };

    const handleModeChanged = (data: {
      mode: "auto" | "manual" | "directed";
      by: string;
      initiatorId?: string;
      discussion?: MeetingDiscussionState;
      execution?: MeetingExecutionState;
    }) => {
      if (data.discussion) {
        setStartingMeeting(false);
        setDiscussionNpcs(restoreMeetingNpcs(data.discussion.npcs, npcsRef.current));
        setMeetingTopic(data.discussion.topic);
        meetingTopicRef.current = data.discussion.topic;
        setMeetingActive(true);
        setMeetingEnded(false);
        setLastMeetingResult(null);
        setIsInitiator(data.discussion.initiatorSocketId === socket.id);
      }
      setMeetingMode(data.mode);
      const restored = restoreMeetingExecution(data.execution ?? data.discussion);
      setIsWaitingInput(restored.isWaitingInput);
      setCurrentSpeaker(restored.currentSpeaker);
      npcRawStreamsRef.current = restored.rawStreams;
      npcStreamsRef.current = restored.streams;
      setNpcStreams(restored.streams);
      if (restored.currentSpeaker && restored.streams[restored.currentSpeaker.npcId])
        speaker.stream(
          restored.currentSpeaker.npcId,
          restored.streams[restored.currentSpeaker.npcId],
        );
      else speaker.finish();
    };

    const handleWaitingInput = (data: { pollResult?: PollStatus | null }) => {
      speaker.finish();
      setIsWaitingInput(true);
      if (data.pollResult) setPollStatus(data.pollResult);
    };

    const handleTurnAborted = (data: { npcId: string }) => {
      speaker.finish(data.npcId);
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

    const rejoin = () => {
      confirmed = false;
      setJoinState("joining");
      clearTimeout(joinTimer);
      joinTimer = setTimeout(() => {
        if (!confirmed) EventBus.emit("meeting:join-failed", { reasonCode: "arrival_timeout" });
      }, 15000);
      socket.emit("meeting:join", {
        channelId,
        characterName: characterRef.current.name,
        appearance: characterRef.current.appearance,
      });
    };
    const disconnected = () => {
      confirmed = false;
      clearTimeout(joinTimer);
      setJoinState("disconnected");
      speaker.finish();
    };
    const denied = (data: { channelId?: string; action?: string; reason?: string }) => {
      if (data.channelId === channelId && data.action?.startsWith("meeting:")) {
        setStartingMeeting(false);
        setMeetingError(data.reason ?? "forbidden");
        if (data.action === "meeting:join")
          EventBus.emit("meeting:join-failed", { reasonCode: data.reason ?? "forbidden" });
      }
    };
    const spatialState = (next: MeetingSpatialState) => {
      if (next.channelId !== channelId) return;
      setSpatial((prev) => (prev && prev.generation > next.generation ? prev : next));
      setStartingMeeting((previous) =>
        next.phase === "ready" ? previous : next.phase === "assembling",
      );
    };
    socket.on("connect", rejoin);
    socket.on("disconnect", disconnected);
    socket.on("channel:access-denied", denied);
    socket.on("meeting:spatial-state", spatialState);
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
    socket.on("meeting:mention-skipped", handleMentionSkipped);
    if (socket.connected) rejoin();

    return () => {
      socket.off("connect", rejoin);
      socket.off("disconnect", disconnected);
      socket.off("channel:access-denied", denied);
      socket.off("meeting:spatial-state", spatialState);
      clearTimeout(joinTimer);
      speaker.dispose();
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
      socket.off("meeting:mention-skipped", handleMentionSkipped);
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
    if (
      !canSubmitMeetingTopic(meetingTopic) ||
      selectedNpcIds.size === 0 ||
      startingMeeting ||
      !socket ||
      joinState !== "joined" ||
      spatial?.phase === "returning"
    )
      return;
    if (
      spatial?.phase === "blocked" &&
      spatial.participants.some(
        (actor) => actor.kind === "npc" && !selectedNpcIds.has(actor.actorId),
      )
    ) {
      socket.emit("meeting:cancel-preparation", { channelId });
      setMeetingError(t("meeting.returnBeforeRetry"));
      return;
    }
    setMeetingError(null);
    setStartingMeeting(true);
    setDiscussionNpcs(selectMeetingNpcs(npcs, selectedNpcIds));
    socket.emit("meeting:start-discussion", {
      channelId,
      topic,
      selectedNpcIds: Array.from(selectedNpcIds),
      settings: {
        initialMode: startMode,
        maxTotalTurns: maxTurns,
        hybridMode,
        hybridAutoResumeMs:
          hybridMode && hybridResumeMode === "timer" ? hybridResumeSeconds * 1000 : null,
      },
    });
    // Clear the previous meeting's end screen. The render condition is `meetingEnded && lastMeetingResult`,
    // so without clearing this, the previous meeting's summary stays on screen even while the new
    // meeting is running turns normally — the server sends speech, but the user only sees the old meeting.
    // This used to be cleared only from "Start over" (handleResetDiscussion, with a window.confirm).
    setMeetingEnded(false);
    setLastMeetingResult(null);
  }, [
    meetingTopic,
    startingMeeting,
    socket,
    channelId,
    selectedNpcIds,
    npcs,
    startMode,
    maxTurns,
    hybridMode,
    hybridResumeMode,
    hybridResumeSeconds,
    joinState,
    spatial,
    t,
  ]);

  const { stopping, stop: handleEndMeeting } = useMeetingStop(socket, channelId);

  const handleSetMode = useCallback(
    (mode: "auto" | "manual") => {
      if (!socket) return;
      setMeetingMode(mode);
      setIsWaitingInput(false);
      socket.emit("meeting:set-mode", { channelId, mode });
    },
    [socket, channelId],
  );

  const handleResetDiscussion = useCallback(() => {
    if (!socket || !meetingActive) return;
    if (!window.confirm(t("meeting.restartConfirm"))) return;

    suppressNextMeetingEndRef.current = true;
    socket.emit("meeting:stop", { channelId });
    setMeetingActive(false);
    setMeetingEnded(false);
    setDiscussionNpcs(null);
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

  const handleNextTurn = useCallback(() => {
    if (!socket) return;
    socket.emit("meeting:next-turn", { channelId });
    setIsWaitingInput(false);
  }, [socket, channelId]);

  const handleDirectSpeak = useCallback(
    (npcId: string) => {
      if (!socket) return;
      socket.emit("meeting:direct-speak", { channelId, npcId });
      setIsWaitingInput(false);
    },
    [socket, channelId],
  );

  const handleSend = useCallback(
    (msg?: string) => {
      const trimmed = (msg ?? input).trim();
      if (!trimmed || cooldown || !socket || joinState !== "joined") return;
      if (!msg) setInput("");
      if (meetingActive) {
        socket.emit("meeting:user-speak", { channelId, message: trimmed });
      } else {
        socket.emit("meeting:chat", { channelId, message: trimmed });
      }
      setCooldown(true);
      setTimeout(() => setCooldown(false), 2000);
    },
    [input, cooldown, socket, channelId, meetingActive, joinState],
  );

  const sceneParticipants = [currentUser, ...otherParticipants];
  useEffect(() => {
    participantCountRef.current = sceneParticipants.length;
  }, [sceneParticipants.length]);
  const raiseNames = formatPollRaises(pollStatus?.raises);

  // Collect streaming NPC messages for display
  const streamingEntries = Object.entries(npcStreams);
  const cannotStart =
    !canSubmitMeetingTopic(meetingTopic) ||
    startingMeeting ||
    selectedNpcIds.size === 0 ||
    spatial?.phase === "returning" ||
    joinState !== "joined";
  const overflow = meetingOverflow(
    capacity,
    selectedNpcIds.size,
    participants.filter((p) => p.type === "user").length,
  );

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
        {showStartOptions ? (
          <ChevronUp className="h-4 w-4 shrink-0" />
        ) : (
          <ChevronDown className="h-4 w-4 shrink-0" />
        )}
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
                <input
                  type="radio"
                  name="startMode"
                  checked={startMode === "auto"}
                  onChange={() => setStartMode("auto")}
                  className="accent-primary"
                />
                {t("meeting.modeAuto")}
              </label>
              <label className="flex items-center gap-1 text-text-secondary cursor-pointer">
                <input
                  type="radio"
                  name="startMode"
                  checked={startMode === "manual"}
                  onChange={() => setStartMode("manual")}
                  className="accent-primary"
                />
                {t("meeting.modeManual")}
              </label>
            </div>
            <label className="flex items-center gap-2 text-caption text-text-secondary cursor-pointer">
              <input
                type="checkbox"
                checked={hybridMode}
                onChange={(e) => setHybridMode(e.target.checked)}
                className="accent-primary"
              />
              {t("meeting.hybridModeDesc")}
            </label>
            {hybridMode && (
              <div className="ml-5 space-y-1">
                <label className="flex items-center gap-1 text-caption text-text-muted cursor-pointer">
                  <input
                    type="radio"
                    name="hybridResume"
                    checked={hybridResumeMode === "manual"}
                    onChange={() => setHybridResumeMode("manual")}
                    className="accent-primary"
                  />
                  {t("meeting.manualResume")}
                </label>
                <label className="flex items-center gap-1 text-caption text-text-muted cursor-pointer">
                  <input
                    type="radio"
                    name="hybridResume"
                    checked={hybridResumeMode === "timer"}
                    onChange={() => setHybridResumeMode("timer")}
                    className="accent-primary"
                  />
                  <input
                    type="number"
                    min={5}
                    max={120}
                    value={hybridResumeSeconds}
                    onChange={(e) =>
                      setHybridResumeSeconds(
                        Math.max(5, Math.min(120, Number(e.target.value) || 30)),
                      )
                    }
                    className="w-12 bg-surface-raised text-text px-1 py-0.5 rounded border border-border text-caption text-center"
                    disabled={hybridResumeMode !== "timer"}
                  />
                  {t("meeting.timerResumeAfter")}
                </label>
              </div>
            )}
          </div>
        </>
      )}
      {overflow > 0 && (
        <p role="note" data-meeting-overflow className="text-caption">
          {t("meeting.overflowNotice", { count: overflow })}
        </p>
      )}
      <MeetingTopicInput
        value={meetingTopic}
        onChange={setMeetingTopic}
        onSubmit={handleStartDiscussion}
      />
    </>
  );

  return (
    <div
      data-meeting-join-state={joinState}
      className="h-full min-h-0 flex flex-col bg-bg text-text"
    >
      {joinState !== "joined" && (
        <div role="status" className="shrink-0 p-3">
          {t(joinState === "joining" ? "meeting.joining" : "meeting.disconnected")}
          {joinState === "disconnected" && (
            <button type="button" onClick={() => socket?.connect()}>
              {t("common.retry")}
            </button>
          )}
        </div>
      )}
      <fieldset disabled={joinState !== "joined"} className="flex-1 flex flex-col min-h-0 min-w-0">
        {meetingError && (
          <p role="alert" className="shrink-0 p-3 text-danger">
            {t("meeting.entryFailed", {
              reason:
                t(`meeting.reason.${meetingError}`) === `meeting.reason.${meetingError}`
                  ? meetingError
                  : t(`meeting.reason.${meetingError}`),
            })}
          </p>
        )}
        {spatial && spatial.phase !== "idle" && (
          <div
            data-meeting-spatial={spatial.phase}
            role="status"
            className="max-h-40 shrink-0 overflow-y-auto border-b border-border p-3 text-caption"
          >
            <p>{t(`meeting.spatial.${spatial.phase}`)}</p>
            <ul>
              {spatial.participants.map((actor) => (
                <li key={`${actor.kind}:${actor.actorId}`}>
                  {actor.kind === "npc"
                    ? (npcs.find((npc) => npc.id === actor.actorId)?.name ?? actor.actorId)
                    : (participants.find((p) => p.userId === actor.actorId)?.name ?? actor.actorId)}
                  : {t(`meeting.spatial.${actor.state}`)}
                </li>
              ))}
            </ul>
            {spatial.failure && (
              <p>
                {t(`meeting.reason.${spatial.failure.reasonCode}`) ===
                `meeting.reason.${spatial.failure.reasonCode}`
                  ? spatial.failure.reasonCode
                  : t(`meeting.reason.${spatial.failure.reasonCode}`)}
              </p>
            )}
            {spatial.phase === "blocked" && (
              <button type="button" data-meeting-preparation-retry onClick={handleStartDiscussion}>
                {t("common.retry")}
              </button>
            )}
            {(spatial.phase === "assembling" || spatial.phase === "blocked") && !meetingActive && (
              <button
                type="button"
                data-meeting-preparation-cancel
                onClick={() => socket?.emit("meeting:cancel-preparation", { channelId })}
              >
                {t("meeting.cancelPreparation")}
              </button>
            )}
          </div>
        )}
        {meetingActive && isInitiator && (
          <MeetingControlBar
            mode={meetingMode}
            isWaiting={isWaitingInput}
            stopping={stopping}
            currentSpeaker={currentSpeaker}
            npcs={displayedNpcs}
            lastSpokeTimes={lastSpokeTimes}
            nowMs={nowMs}
            onSetMode={handleSetMode}
            onNextTurn={handleNextTurn}
            onDirectSpeak={handleDirectSpeak}
            onStop={handleEndMeeting}
            t={t}
          />
        )}
        <MeetingSidebar
          participantCount={sceneParticipants.length}
          title={t("meeting.groupChat")}
          width={420}
          actions={
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
                  disabled={stopping}
                  className="px-2.5 py-1 rounded-lg border border-border bg-surface-raised hover:bg-surface-raised text-text text-caption disabled:opacity-50"
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
          }
          statusBar={
            meetingActive && pollStatus ? (
              <div className="flex flex-wrap gap-1 items-center">
                <span className="text-npc font-semibold">{t("meeting.polling")}</span>
                {raiseNames.length > 0 && (
                  <span className="text-success">
                    {t("meeting.raiseLabel")} {raiseNames.join(", ")}
                  </span>
                )}
                {pollStatus.passes && pollStatus.passes.length > 0 && (
                  <span className="text-text-dim">
                    {t("meeting.passLabel")}{" "}
                    {formatPollPasses(
                      pollStatus.passes,
                      displayedNpcs,
                      t("meeting.unknownNpc"),
                    ).join(", ")}
                  </span>
                )}
                {pollStatus.status && <span className="text-text-muted">{pollStatus.status}</span>}
              </div>
            ) : null
          }
          footer={
            !meetingEnded ? (
              <div data-meeting-chat-input className="border-t border-border bg-bg">
                <ToolApprovalStack
                  socket={socket}
                  channelId={channelId}
                  context="meeting"
                  npcNames={npcNames}
                />
                <ChatInput
                  onSend={(msg) => handleSend(msg)}
                  placeholder={t("meeting.speakToMeeting")}
                  disabled={joinState !== "joined"}
                  disabledPlaceholder={t(
                    joinState === "joining" ? "meeting.joining" : "meeting.disconnected",
                  )}
                  cooldown={cooldown}
                  accent="meeting"
                  mentionCandidates={
                    displayedNpcs.length
                      ? displayedNpcs.map((n) => ({ id: n.id, name: n.name }))
                      : undefined
                  }
                  autoFocus
                />
              </div>
            ) : undefined
          }
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
                {messages.map((msg, index) => {
                  const isMe = msg.senderId === socket?.id;
                  const isNpc = msg.senderType === "npc";
                  const isSystem = msg.senderId === "system";
                  // Same rule as the chat panel — avatar only for others, and just leave the slot when the same speaker continues.
                  const previous = messages[index - 1];
                  const continued =
                    !!previous &&
                    previous.senderId === msg.senderId &&
                    previous.senderType === msg.senderType;
                  return (
                    <div
                      key={msg.id}
                      // e2e hook. To verify the turn actually rotates among several NPCs, each speech's
                      // speaker must be readable from outside — a color utility class can't do that.
                      data-meeting-message={msg.senderType}
                      data-sender={msg.sender}
                      className={`flex gap-2 ${isMe ? "justify-end" : "justify-start"}`}
                    >
                      {!isMe &&
                        !isSystem &&
                        (continued ? (
                          <div
                            data-chat-avatar="spacer"
                            aria-hidden="true"
                            className="shrink-0"
                            style={{ width: CHAT_AVATAR_SIZE }}
                          />
                        ) : (
                          <div data-chat-avatar="shown" className="shrink-0 self-start">
                            <RosterAvatar
                              appearance={meetingAvatarFor({
                                kind: isNpc ? "npc" : "user",
                                // The meeting server carries an employee's speech senderId as `npc-<id>`.
                                id: isNpc ? msg.senderId.replace(/^npc-/, "") : msg.senderId,
                                name: msg.sender,
                              })}
                              size={CHAT_AVATAR_SIZE}
                            />
                          </div>
                        ))}
                      <div className="max-w-[85%]">
                        {!isMe && !(continued && !isSystem) && (
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
                    currentSpeaker?.npcId === npcId ? currentSpeaker.npcName : npc?.name || npcId;
                  return (
                    <div key={`stream-${npcId}`} className="flex justify-start">
                      <div className="max-w-[85%]">
                        <div className="text-micro font-medium mb-0.5 text-npc">{speakerName}</div>
                        <div className="px-3 py-2 rounded-lg text-body bg-surface-raised text-text border border-npc/30">
                          {content}
                          <span className="inline-block w-1.5 h-4 bg-npc ml-0.5 animate-pulse" />
                        </div>
                      </div>
                    </div>
                  );
                })}
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
                      <div className="text-heading font-bold text-info">
                        {lastMeetingResult.participantCount}
                      </div>
                      <div className="text-micro text-text-muted">
                        {t("meeting.recordedParticipants")}
                      </div>
                    </div>
                    <div className="bg-surface-raised/50 rounded px-3 py-2 text-center">
                      <div className="text-heading font-bold text-npc">
                        {lastMeetingResult.totalTurns}
                      </div>
                      <div className="text-micro text-text-muted">{t("meeting.totalTurns")}</div>
                    </div>
                  </div>

                  <p className="text-micro text-text-muted">
                    {t("meeting.recordedParticipantsNote")}
                  </p>

                  {/* Key topics & conclusions */}
                  {lastMeetingResult.keyTopics.length > 0 || lastMeetingResult.conclusions ? (
                    <>
                      {lastMeetingResult.keyTopics.length > 0 && (
                        <div className="space-y-1">
                          <p className="text-caption text-text-dim font-medium">
                            {t("meeting.keyTopics")}
                          </p>
                          <ul className="space-y-0.5">
                            {lastMeetingResult.keyTopics.map((topic, i) => (
                              <li
                                key={i}
                                className="text-caption text-text-secondary flex items-start gap-1.5"
                              >
                                <span className="text-info mt-0.5">•</span>
                                <span>{topic}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {lastMeetingResult.conclusions && (
                        <div className="space-y-1">
                          <p className="text-caption text-text-dim font-medium">
                            {t("meeting.conclusions")}
                          </p>
                          <p className="text-caption text-text-secondary leading-relaxed">
                            {lastMeetingResult.conclusions}
                          </p>
                        </div>
                      )}
                    </>
                  ) : (
                    <p className="text-caption text-text-dim italic text-center py-2">
                      {t("meeting.noSummary")}
                    </p>
                  )}
                </div>

                {/* Decisions/follow-ups and "register as a project?" — only when the minutes were saved */}
                {lastMeetingResult.minutesId && (
                  <MeetingOutcomeSection
                    minutesId={lastMeetingResult.minutesId}
                    channelId={channelId}
                    npcs={npcs}
                    onSummaryChanged={(summary) =>
                      setLastMeetingResult((prev) => (prev ? { ...prev, ...summary } : prev))
                    }
                    onOutcomeLoaded={(pending) => {
                      if (!pending) autoReturn.hint();
                    }}
                    onRegistered={autoReturn.start}
                    onDeclined={autoReturn.start}
                  />
                )}

                {autoReturn.state.status === "hint" && (
                  <p data-auto-return-hint className="text-caption text-info text-center">
                    {t("meeting.autoReturn.hint")}
                  </p>
                )}

                {/* Divider */}
                <div className="border-t border-border" />

                {/* New meeting form */}
                <div className="space-y-3">
                  <h4 className="text-title text-text-secondary text-center">
                    {t("meeting.newMeeting")}
                  </h4>
                  {renderMeetingStartForm()}
                  <button
                    onClick={() => {
                      setMeetingEnded(false);
                      setLastMeetingResult(null);
                      setMessages([]);
                      handleStartDiscussion();
                    }}
                    data-meeting-start
                    disabled={cannotStart}
                    className={`w-full px-4 py-2 rounded font-semibold text-body ${
                      canSubmitMeetingTopic(meetingTopic) &&
                      !startingMeeting &&
                      selectedNpcIds.size > 0
                        ? "bg-primary hover:bg-primary-hover text-white"
                        : "bg-surface-raised text-text-dim cursor-not-allowed"
                    }`}
                  >
                    {startingMeeting ? t("meeting.starting") : t("meeting.startDiscussion")}
                  </button>
                </div>
              </div>

              {/* Auto-return hint — placed at the always-visible bottom since the result panel scrolls; if "stay" isn't visible, it can't be chosen. */}
              {autoReturn.state.status === "counting" && (
                <div
                  data-auto-return
                  role="status"
                  className="flex items-center gap-2 border-t border-info/40 bg-info/10 px-4 py-2 flex-shrink-0"
                >
                  <span className="flex-1 text-caption text-text-secondary">
                    {t("meeting.autoReturn.counting", { seconds: autoReturn.state.remaining })}
                  </span>
                  <button
                    type="button"
                    data-auto-return-stay
                    onClick={autoReturn.stay}
                    className="px-3 py-1 rounded text-caption font-semibold bg-surface-raised text-text-secondary border border-border"
                  >
                    {t("meeting.autoReturn.stay")}
                  </button>
                </div>
              )}
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
                          } catch {
                            /* ignore */
                          }
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
                            const res = await fetch(
                              `/api/meetings/${lastMeetingResult.minutesId}/export?${params.toString()}`,
                            );
                            const data = await res.json();
                            if (data.text) {
                              await navigator.clipboard.writeText(data.text);
                            }
                          } catch {
                            /* ignore */
                          }
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
            <div className="h-full flex flex-col min-h-0 overflow-y-auto">
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
                    data-meeting-start
                    disabled={cannotStart}
                    className={`w-full px-4 py-2 rounded font-semibold text-body ${
                      canSubmitMeetingTopic(meetingTopic) &&
                      !startingMeeting &&
                      selectedNpcIds.size > 0
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
      </fieldset>

      {showMinutesModal && (
        <MinutesModal
          channelId={channelId}
          npcs={npcs}
          onClose={() => setShowMinutesModal(false)}
        />
      )}
    </div>
  );
}
