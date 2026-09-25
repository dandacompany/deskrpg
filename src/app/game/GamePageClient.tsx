"use client";

import SocketConnectionNotice from "@/components/SocketConnectionNotice";
import { APP_VERSION, LICENSE_URL, REPO_URL } from "@/lib/app-meta";
import { GrowthStarButton } from "@/components/growth/GrowthStarButton";
import { UpdateNoticeModal } from "@/components/growth/UpdateNoticeModal";
import { useAppMeta } from "@/components/growth/use-app-meta";
import { BugReportModal } from "@/components/growth/BugReportModal";
import { SurveyModal } from "@/components/growth/SurveyModal";
import { installErrorCapture } from "@/components/growth/feedback-client";
import { useSurveyPrompt } from "@/components/growth/use-survey-prompt";
import { npcMotionUi } from "./npc-motion-ui";
import { navigatorMotion } from "./conversation-integration";
import type { MotionSnapshot } from "@/game/motion-snapshot";

import { MapChatWalkers } from "./map-chat-walkers";
import { MapChatParticipants } from "./map-chat-participants";
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { useSearchParams, useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import Link from "next/link";
import { employeesHref } from "@/components/workspace-navigation";
import { useT, useLocale, LOCALES } from "@/lib/i18n";
import {
  MessageSquare,
  Undo2,
  Clock,
  Footprints,
  PhoneCall,
  Bell,
  ChevronDown,
  UserMinus,
  Settings,
  Eye,
  LogOut,
  Pencil,
  Users,
  Globe,
  RotateCcw,
  Bug,
  Info,
  KanbanSquare,
  AlarmClock,
  Package,
  ArrowUpCircle,
} from "lucide-react";
import type { Socket } from "socket.io-client";
import { EventBus, setPendingChannelData, type PendingChannelData } from "@/game/EventBus";
import { decideChatError } from "./chat-error-dispatch";
import { initialRoomState, lastRoomKey, reduceRoomState } from "./room-state";
import {
  activeReportReleased,
  decideReportCall,
  dismissReport,
  dismissedReportIds,
  recallReport,
  reviveDismissedReports,
  settleReturningNpcs,
  missedReportArrival,
  reconcileReportAttempts,
  releaseUnacquiredReportCalls,
  reportCallBlocked,
  reportAckKey,
  reportsForChannel,
  reportTarget,
  npcSignature,
  type ReportAttempt,
} from "./npc-report-dispatch";
import {
  acknowledgeReport,
  EMPTY_REPORT_ACK,
  parseReportAck,
  serializeReportAck,
  type ReportAck,
  type ReportItem,
} from "@/game/report-queue";
import { decideContextInvite } from "./context-invite-decision";
import type { RoomMessage, RoomSummary } from "@/lib/chat-rooms-policy";
import {
  buildPlacementRequest,
  keepsPlacementMode,
  placementBroadcastPlan,
} from "@/game/npc-placement-request";
import ReportBadge from "@/components/report/ReportBadge";
import ChatPanel from "@/components/ChatPanel";
import ConversationPane from "@/components/conversation/ConversationPane";
import ConversationWorkspace from "@/components/conversation/ConversationWorkspace";
import MeetingWorkspace from "@/components/conversation/MeetingWorkspace";
import { ToolApprovalsProvider } from "@/components/approvals/ToolApprovalsProvider";
import { useMeetingEntry } from "@/components/meeting-room/use-meeting-entry";
import "@/components/meeting-room/meeting-mode.css";
import { buildDmThreadEntries, needsCallBeforeDmSend, type DmThread } from "@/lib/dm-threads";
import { isNpcCallRejected, npcCallErrorKey } from "@/lib/npc-call-errors";
import WorkspaceNavigator, {
  type NavigatorNpc,
  type NpcNavigatorAction,
  type RosterNpc,
} from "@/components/conversation/WorkspaceNavigator";
import { createAvatarLookup } from "./avatar-lookup";
import type { NpcChatMessage } from "@/components/NpcDialog";
import PasswordModal from "@/components/PasswordModal";
import ChannelSettingsModal from "@/components/ChannelSettingsModal";
import ViewSettingsModal from "@/components/ViewSettingsModal";
import type { NpcMotionConfig } from "@/lib/npc-motion-config";
import type { ChatTaskDraft } from "@/components/kanban/kanban-view-model";
import KanbanBoardModal from "@/components/kanban/KanbanBoardModal";
import { CRON_SOCKET_EVENT } from "@/components/cron/CronPanel";
import type { PanelBadgeCounts } from "@/components/ChatPanel";
import { openCardTarget, type OpenCardTarget } from "@/components/kanban/open-card-target";
import AttentionInboxPanel from "@/components/attention/AttentionInboxPanel";
import Modal from "@/components/ui/Modal";
import MinutesModal from "@/components/MinutesModal";
import CronModal from "@/components/cron/CronModal";
import ArtifactsModal from "@/components/artifacts/ArtifactsModal";
import ConnectorManagerModal from "@/components/connectors/ConnectorManagerModal";
import ApprovalPolicyModal from "@/components/approvals/ApprovalPolicyModal";
import SkillManagerModal from "@/components/skills/SkillManagerModal";
import type { SourceTarget } from "@/components/artifacts/artifact-view-model";
import { createArtifactsApi } from "@/components/artifacts/artifacts-api";
import type { TaskDrawerArtifacts } from "@/components/kanban/TaskDrawer";
import {
  INITIAL_ARTIFACTS_MODAL,
  nextArtifactChips,
  planSourceNavigation,
  reduceArtifactsModal,
  type ArtifactChip,
  type ArtifactSocketEvent,
} from "./artifact-entry";
import {
  EMPTY_NPC_WORKING,
  parseNpcWorkingPayload,
  reduceNpcWorking,
  workingNpcCounts,
  workingNpcIds,
  type NpcWorkingMap,
} from "./npc-working-state";
import { getLocalizedErrorMessage, getLocalizedMessage } from "@/lib/i18n/error-codes";
import { mentionSkipI18nKey } from "@/components/meeting-room/mention-skip-notice";
import type { MentionSkipReason } from "@/lib/conversation/floor-controller";
import { resolveNpcResponseChunk, type NpcResponsePayload } from "@/lib/npc-response-messages";
import type { ChatResponse } from "@/lib/chat-response";
import {
  npcPresentationPhases,
  initialChatResponseState,
  reconcileNpcResponseMessages,
  reduceChatResponseState,
  responsesForScope,
  upsertLegacyNpcChunk,
} from "./chat-response-state";

const SOURCE_CODE_URL = REPO_URL;
const THIRD_PARTY_LICENSES_URL = "/third-party-licenses.html";
const INSTANCE_ID_STORAGE_KEY = "deskrpg.instanceId";

function GameEngineLoading() {
  const t = useT();

  return (
    <div className="fixed inset-0 bg-surface flex items-center justify-center text-text-muted">
      {t("game.loadingEngine")}
    </div>
  );
}

// Load the Three.js office presentation on the client.
const ThreeGame = dynamic(() => import("@/components/ThreeGame"), {
  ssr: false,
  loading: () => <GameEngineLoading />,
});

/**
 * The source of appearance is JSON in the DB. The map (ThreeGame) reads only `officeLookId`, and the meeting and list components
 * interpret the rest — this file borrows those components' prop types as is and does not know the appearance format.
 */
type CharacterAppearanceData = ComponentProps<typeof MeetingWorkspace>["character"]["appearance"];

interface Character {
  id: string;
  name: string;
  appearance: CharacterAppearanceData;
}

interface GameNotification {
  id: string;
  message: string;
  timestamp: number;
  read: boolean;
}

interface ChannelInfo {
  id: string;
  ownerId?: string;
  name: string;
  description: string | null;
  inviteCode: string | null;
  mapData: unknown;
  mapConfig: unknown;
  /** NPC walking speed (shared per channel). The server clamps it, so it is never empty. */
  motionConfig?: NpcMotionConfig;
  isPublic: boolean;
  isMember?: boolean;
  isOwner?: boolean;
  hasGateway: boolean;
  gatewayConfig?: {
    gatewayId?: string | null;
    url?: string | null;
    token?: string | null;
  } | null;
}

interface ChannelPlayerSummary {
  id: string;
  userId?: string;
  name: string;
  appearance: CharacterAppearanceData | null;
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

type GamePageClientProps = {
  /**
   * Called when 3D can no longer run (renderer init failure, WebGL context loss).
   * Disconnect the socket before calling so no half-alive channel screen is left behind.
   */
  onFatal?: () => void;
};

export default function GamePage({ onFatal }: GamePageClientProps = {}) {
  const t = useT();
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-bg text-text">
          {t("common.loading")}
        </div>
      }
    >
      <GamePageInner onFatal={onFatal} />
    </Suspense>
  );
}

function withoutNpc(set: ReadonlySet<string>, npcId: string): ReadonlySet<string> {
  if (!set.has(npcId)) return set;
  const next = new Set(set);
  next.delete(npcId);
  return next;
}

function GamePageInner({ onFatal }: GamePageClientProps) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const t = useT();
  const { locale, setLocale } = useLocale();
  const channelId = searchParams.get("channelId");

  // The server decides "me" — read via GET /api/characters/me, not the URL (player:join follows the same rule).
  const [character, setCharacter] = useState<Character | null>(null);
  const characterId = character?.id ?? null;
  const [channel, setChannel] = useState<ChannelInfo | null>(null);
  const [gameChannelData, setGameChannelData] = useState<PendingChannelData>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // playerCount is derived from channelPlayers array length
  const [socket, setSocket] = useState<Socket | null>(null);
  const [socketConnected, setSocketConnected] = useState(false);
  const [showSharePopup, setShowSharePopup] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const appMeta = useAppMeta();
  const [showUpdateNotice, setShowUpdateNotice] = useState(false);
  const [showBugReport, setShowBugReport] = useState(false);
  const surveyPrompt = useSurveyPrompt(appMeta.feedbackUrl);
  useEffect(() => installErrorCapture(), []);
  // The kanban board (T8). `kanbanRefreshTick` rises on every `kanban:event`, and the modal rereads with a debounce.
  const [showKanban, setShowKanban] = useState(false);
  const [chatTaskDraft, setChatTaskDraft] = useState<
    (ChatTaskDraft & { channelId: string; seq: number }) | null
  >(null);
  useEffect(() => {
    const open = () => setShowKanban(true);
    EventBus.on("kanban:open", open);
    return () => {
      EventBus.off("kanban:open", open);
    };
  }, []);
  const [kanbanRefreshTick, setKanbanRefreshTick] = useState(0);
  // Unread badges on the employee dialog tabs (T6) and their recompute signal (rises on every `cron:event`).
  const [panelBadges, setPanelBadges] = useState<PanelBadgeCounts | null>(null);
  const [panelBadgeTick, setPanelBadgeTick] = useState(0);
  // Whether the board was open **at the moment** the card was clicked — kept in a ref to see it without recreating the callback.
  const showKanbanRef = useRef(showKanban);
  useEffect(() => {
    showKanbanRef.current = showKanban;
  }, [showKanban]);
  // The room notice's "카드 열기" (R29), the artifact's "출처로 이동", the employee dialog's card tab (T6) — expand this card's
  // detail. If the board was closed at click time, `initialTaskId` (read at mount); if open,
  // bump `focusRequest`'s `seq` (`openCardTarget`).
  const [kanbanCard, setKanbanCard] = useState<OpenCardTarget | null>(null);
  // The room notice's "프로젝트로 등록" — opens those minutes (the follow-up registration screen) without entering the meeting room.
  const [noticeMinutesId, setNoticeMinutesId] = useState<string | null>(null);
  // The decision inbox — things a person must answer, like approvals, reviews and blocks. Opened by the header button and approval request notices.
  // Without this screen, cards registered in a meeting would stay awaiting approval (`blocked`) forever.
  const [showAttention, setShowAttention] = useState(false);
  // The channel cron screen (T10, R15). "이력 열기" (R30) opens it at that job's run history.
  const [showCron, setShowCron] = useState(false);
  const [cronInitialJobId, setCronInitialJobId] = useState<string | null>(null);
  // The channel artifacts modal. While open, tick rises on every `artifact:event` and the last event is passed to the modal
  // (cleared on close — `reduceArtifactsModal`).
  const [artifactsModal, dispatchArtifactsModal] = useReducer(
    reduceArtifactsModal,
    INITIAL_ARTIFACTS_MODAL,
  );
  // Artifacts the NPC currently in conversation saved in chat — cleared when the conversation NPC changes.
  const [npcArtifactChips, setNpcArtifactChips] = useState<ArtifactChip[]>([]);
  // The map's "working" state (R27). Holds only the socket's `npc:working` — no optimistic updates (R26).
  const [npcWorking, setNpcWorking] = useState<NpcWorkingMap>(EMPTY_NPC_WORKING);
  const meetingEntry = useMeetingEntry(socket, channelId);
  const mode = ["joining", "joined"].includes(meetingEntry.state.status) ? "meeting" : "office";
  // Map rendering needs only placed NPC identity and appearance.
  const [channelNpcs, setChannelNpcs] = useState<
    {
      id: string;
      name: string;
      appearance: unknown;
    }[]
  >([]);
  // The map list (`channelNpcs`) has only placed, clocked-in NPCs. The attendance roster must also show NPCs without a seat
  // or clocked out, so it is read separately with `?roster=1`.
  const [rosterNpcs, setRosterNpcs] = useState<RosterNpc[]>([]);
  // So socket listeners read the latest attendance roster (profile names).
  const rosterNpcsRef = useRef<RosterNpc[]>([]);
  useEffect(() => {
    rosterNpcsRef.current = rosterNpcs;
  }, [rosterNpcs]);
  const [channelPlayers, setChannelPlayers] = useState<ChannelPlayerSummary[]>([]);
  const [conversationPanelWidth, setConversationPanelWidth] = useState(388);

  // Ref to track current dialogNpc for use inside socket listeners (must be declared before sync effect)
  const dialogNpcRef = useRef<{ npcId: string; npcName: string } | null>(null);

  // NPC dialog state — all managed here, ChatPanel is pure display
  const [npcActivityKey, setNpcActivityKey] = useState<string | null>(null);
  const [dialogNpc, setDialogNpc] = useState<{ npcId: string; npcName: string } | null>(null);
  /** The employee whose skill management modal is open — opened by "관리 열기" in the dialog's [스킬] tab. */
  const [skillManagerNpc, setSkillManagerNpc] = useState<{
    npcId: string;
    npcName: string;
    skillName: string | null;
  } | null>(null);
  /** The employee whose connector manager is open — opened from the dialog's [Connectors] tab. */
  const [connectorManagerNpc, setConnectorManagerNpc] = useState<{
    npcId: string;
    npcName: string;
    server?: string;
  } | null>(null);
  /** The employee whose unattended run policy modal is open — opened from the [Connectors] tab. */
  const [approvalPolicyNpc, setApprovalPolicyNpc] = useState<{
    npcId: string;
    npcName: string;
  } | null>(null);
  // The report queue — derived from office notices. Only acknowledgment points are kept in the browser (`reportAckKey`).
  const [reportAck, setReportAck] = useState<ReportAck>(EMPTY_REPORT_ACK);
  // The report currently being delivered (or coming to be delivered). Tracked per report, not per employee — so another
  // report from the same employee does not cut ahead of the chronological order.
  const [reportingMessageId, setReportingMessageId] = useState<string | null>(null);
  // The report shown at the top of the dialog opened by someone coming to report.
  const [dialogReport, setDialogReport] = useState<ReportItem | null>(null);
  // A version that tells the screen the attempt log (ref) changed, the last acknowledgment time, and a clock for reviving folded reports.
  const [reportAttemptsVersion, setReportAttemptsVersion] = useState(0);
  const lastReportAckAtRef = useRef<number | null>(null);
  // Employees being sent back to their seats. Not candidates for report calls until they arrive.
  const returningNpcsRef = useRef<ReadonlySet<string>>(new Set());
  const [reportClock, setReportClock] = useState(0);
  const reportAttemptsRef = useRef<ReportAttempt[]>([]);
  // One DM line per employee in the conversation list. Unlike rooms the server does not push these, so ask when needed.
  const [dmThreads, setDmThreads] = useState<DmThread[]>([]);
  // Keep ref in sync so socket listeners can read current value without stale closure
  useEffect(() => {
    dialogNpcRef.current = dialogNpc;
  }, [dialogNpc]);
  // Artifact chips belong to that conversation — cleared when the conversation NPC changes or it closes.
  const dialogNpcId = dialogNpc?.npcId ?? null;
  useEffect(() => {
    setNpcArtifactChips([]);
  }, [dialogNpcId]);
  const [npcMessages, setNpcMessages] = useState<NpcChatMessage[]>([]);
  const [isNpcStreaming, setIsNpcStreaming] = useState(false);
  const [chatResponses, dispatchChatResponse] = useReducer(
    reduceChatResponseState,
    initialChatResponseState,
  );
  useEffect(() => {
    const publish = () =>
      EventBus.emit("npc:response-phases", { phases: npcPresentationPhases(chatResponses) });
    publish();
    EventBus.on("scene-ready", publish);
    return () => {
      EventBus.off("scene-ready", publish);
    };
  }, [chatResponses]);
  // The working list goes to the map the same way. If the scene comes up late, it is sent again on `scene-ready`.
  useEffect(() => {
    const publish = () =>
      EventBus.emit("npc:working-state", {
        npcIds: workingNpcIds(npcWorking),
        counts: workingNpcCounts(npcWorking),
      });
    publish();
    EventBus.on("scene-ready", publish);
    return () => {
      EventBus.off("scene-ready", publish);
    };
  }, [npcWorking]);
  const [npcSelectList, setNpcSelectList] = useState<{ npcId: string; npcName: string }[] | null>(
    null,
  );
  const [interactSelectList, setInteractSelectList] = useState<
    { id: string; name: string; type: "npc" | "player" }[] | null
  >(null);

  // Channel chat state — split per room. The server only speaks `room:*`.
  const [roomState, dispatchRoom] = useReducer(reduceRoomState, initialRoomState);
  const currentRoomId = roomState.currentRoomId;
  /**
   * The room we currently hold `room:open` on. Needed to close the previous room when moving rooms,
   * and after reconnecting the server's `openRooms` is empty, so reset to null to reopen.
   */
  const openedRoomRef = useRef<string | null>(null);
  /**
   * Whether I created the room. The client does not know its own user id (there is no viewer identity endpoint),
   * so `room:create` carries a one-time ticket and the server returns that ticket **only to the requesting socket**.
   * Telling apart by name would pull two people who created the same name at once into each other's rooms.
   */
  const pendingCreateRef = useRef<string | null>(null);
  const [channelChatOpen, setChannelChatOpen] = useState(false);
  const [channelChatInputDisabled, setChannelChatInputDisabled] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Notification state
  const [notifications, setNotifications] = useState<GameNotification[]>([]);
  const [notificationsExpanded, setNotificationsExpanded] = useState(false);
  const characterNameRef = useRef<string>("");
  const characterAppearanceRef = useRef<CharacterAppearanceData | null>(null);

  // NPC greeting messages (stored until dialog opens)
  const npcGreetings = useRef<Map<string, string>>(new Map());
  const npcMessagesRef = useRef<NpcChatMessage[]>([]);
  /**
   * NPCs walking over because they were named in map chat. This is so the 1:1 dialog **does not open**
   * when they arrive — the answer appears in map chat, and a dialog popping up would cover that chat.
   * A different event from calling them via the context menu (the existing behavior that auto-opens the dialog).
   */
  const mapChatWalkersRef = useRef<MapChatWalkers>(new MapChatWalkers());
  const mapChatParticipantsRef = useRef<MapChatParticipants>(new MapChatParticipants());
  /** Whether the channel chat panel is visible now (ChatPanel reports it) — passed to the scene. */
  const [channelChatVisible, setChannelChatVisible] = useState(false);

  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [showChannelSettings, setShowChannelSettings] = useState(false);
  const [showViewSettings, setShowViewSettings] = useState(false);
  const returnToKanbanRef = useRef(false);
  const [channelSettingsInitialTab, setChannelSettingsInitialTab] = useState<
    "settings" | "members" | "gateway"
  >("settings");
  const [showAboutModal, setShowAboutModal] = useState(false);
  const [meetingMinutesCount, setMeetingMinutesCount] = useState(0);

  // Owner & NPC management state
  const [isOwner, setIsOwner] = useState(false);
  const [placementMode, setPlacementMode] = useState(false);
  const [spawnSetMode, setSpawnSetMode] = useState(false);
  // The NPC to place is **an existing row**. It is not created but given a seat, so
  // an id is enough (the profile is the source of truth for name, persona and appearance).
  const [pendingNpc, setPendingNpc] = useState<{ id: string; wasPlaced: boolean } | null>(null);
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
  const npcMoveStatesRef = useRef<Record<string, string>>({});
  // The scene looks at "which room is visible now" — null if the panel is closed or there is no room.
  // Whenever either value changes the latest combination must always be sent, so emit from one effect.
  useEffect(() => {
    EventBus.emit("room:visible", { roomId: channelChatVisible ? currentRoomId : null });
  }, [channelChatVisible, currentRoomId]);
  useEffect(() => {
    npcMoveStatesRef.current = npcMoveStates;
  }, [npcMoveStates]);
  const npcMotionSnapshotRef = useRef<MotionSnapshot | null>(null);
  const [npcCallers, setNpcCallers] = useState<Record<string, string>>({}); // npcId → callerSocketId

  // Ref to accumulate streaming text (avoids setState-in-effect issues)
  const streamBufferRef = useRef("");
  const socketRef = useRef<Socket | null>(null);
  // Current player position — updated from the simulation for beforeunload save
  const playerPositionRef = useRef<{ x: number; y: number } | null>(null);
  const [instanceId, setInstanceId] = useState("");
  const [debugCopied, setDebugCopied] = useState(false);

  // If 3D dies there is no reason to keep the channel screen — disconnect the socket first and tell the gate.
  const handleGameFatal = useCallback(() => {
    const socketInstance = socketRef.current;
    if (socketInstance) {
      socketInstance.removeAllListeners();
      socketInstance.disconnect();
      socketRef.current = null;
    }
    onFatal?.();
  }, [onFatal]);

  const openChannelSettings = useCallback(
    (initialTab: "settings" | "members" | "gateway" = "settings") => {
      setChannelSettingsInitialTab(initialTab);
      setShowChannelSettings(true);
    },
    [],
  );

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
      nextId =
        window.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      window.localStorage.setItem(INSTANCE_ID_STORAGE_KEY, nextId);
    }
    setInstanceId(nextId);
  }, []);

  // Redirect to channel select if no channelId
  useEffect(() => {
    if (!channelId) router.replace("/channels");
  }, [channelId, router]);

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
      setTimeout(() => {
        if (!resolved) EventBus.off("player-position-response", handler);
      }, 500);
    }, 15000);

    // Save position on page unload (refresh, tab close)
    const handleUnload = () => {
      // EventBus is synchronous — get fresh position immediately
      let freshPos: { x: number; y: number } | null = null;
      const syncHandler = (data: { x: number; y: number }) => {
        freshPos = data;
      };
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
  // Toasts for the cron screen and tab (R19). A new id per message — so they do not stack in the notice list.
  const cronToast = useCallback(
    (message: string) => showToastNotification(`cron-${Date.now()}`, message),
    [showToastNotification],
  );

  // Socket.io connection (dynamic import to avoid SSR window access)
  useEffect(() => {
    let socketInstance: Socket | null = null;
    let cancelled = false;
    const leavePage = () => socketInstance?.disconnect();
    const restorePage = (event: PageTransitionEvent) => {
      if (event.persisted && !cancelled) socketInstance?.connect();
    };
    window.addEventListener("pagehide", leavePage);
    window.addEventListener("pageshow", restorePage);

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
          socketInstance?.emit("room:list", { channelId });
        }
      });
      // The history of the conversation that was open is fetched again after re-entry (player:spawn). The owner of the history
      // is decided on the server by player:join, so asking right after connect gets an empty history because it is not known yet.
      socketInstance.on("player:spawn", () => {
        const openNpc = dialogNpcRef.current;
        if (openNpc) {
          socketInstance?.emit("npc:history", { npcId: openNpc.npcId });
        }
        // The list is asked here for the same reason — my DMs come only after the history owner is decided.
        socketInstance?.emit("npc:dm-threads");
      });
      socketInstance.on("npc:dm-threads", ({ threads }: { threads: DmThread[] }) => {
        setDmThreads(Array.isArray(threads) ? threads : []);
      });
      socketInstance.on("disconnect", (reason: string) => {
        npcMotionSnapshotRef.current = null;
        setSocketConnected(false);
        setIsNpcStreaming(false);
        setNpcActivityKey(null);
        dispatchChatResponse({ type: "disconnect" });
        // Release report calls that got no response so they can be called again after reconnecting.
        const released = releaseUnacquiredReportCalls(reportAttemptsRef.current);
        if (released !== reportAttemptsRef.current) {
          reportAttemptsRef.current = [...released];
          setReportAttemptsVersion((v) => v + 1);
        }
        setNpcMessages((previous) => previous.filter((message) => !message.responseTransient));
        // The server's openRooms is per-socket state — it empties on disconnect, so rooms must be reopened.
        openedRoomRef.current = null;
        showToastNotification("socket-disconnected", t("game.socketDisconnected", { reason }));
      });
      socketInstance.on("room:error", (payload: unknown) => {
        const { toastKey, rejoin, backToList } = decideChatError(payload);
        showToastNotification("channel-chat-error", t(toastKey));
        if (rejoin) EventBus.emit("socket-rejoin");
        if (backToList) {
          // That room is gone or we lost permission — go back to the list and fetch fresh from the server.
          dispatchRoom({ type: "showList" });
          if (channelId) socketInstance?.emit("room:list", { channelId });
        }
      });
      socketInstance.on("connect_error", (error: Error) => {
        setSocketConnected(false);
        setIsNpcStreaming(false);
        console.error("[page] socket connect_error", {
          message: error.message,
          description:
            "description" in error
              ? (error as Error & { description?: unknown }).description
              : undefined,
          context:
            "context" in error ? (error as Error & { context?: unknown }).context : undefined,
          type: "type" in error ? (error as Error & { type?: unknown }).type : undefined,
        });
        showToastNotification("socket-connect-error", t("game.socketConnectFailed"));
      });

      socketInstance.on("players:state", (data: { players: unknown[] }) => {
        // This acknowledgement arrives after authentication and handler registration.
        if (channelId) {
          socketInstance?.emit("room:list", { channelId });
        }
        setChannelPlayers([
          {
            id: "__self__",
            name: characterNameRef.current || t("game.you"),
            appearance: characterAppearanceRef.current ?? null,
          },
          ...(
            (data.players || []) as {
              id: string;
              userId?: string;
              characterName: string;
              appearance?: CharacterAppearanceData | null;
            }[]
          ).map((player) => ({
            id: player.id,
            userId: player.userId,
            name: player.characterName,
            appearance: player.appearance ?? null,
          })),
        ]);
      });
      socketInstance.on(
        "player:joined",
        (player: {
          id: string;
          userId?: string;
          characterName: string;
          appearance?: CharacterAppearanceData | null;
        }) => {
          setChannelPlayers((prev) => {
            if (prev.some((existing) => existing.id === player.id)) return prev;
            return [
              ...prev,
              {
                id: player.id,
                userId: player.userId,
                name: player.characterName,
                appearance: player.appearance ?? null,
              },
            ];
          });
        },
      );
      socketInstance.on("player:left", ({ id }: { id: string }) => {
        setChannelPlayers((prev) => prev.filter((player) => player.id !== id));
      });

      // Room list and history — the list comes after connect, the history is the response to room:open.
      socketInstance.on(
        "room:list-response",
        (data: { rooms: RoomSummary[]; viewerUserId?: string }) => {
          let preferRoomId: string | null = null;
          try {
            preferRoomId = channelId ? window.localStorage.getItem(lastRoomKey(channelId)) : null;
          } catch {
            preferRoomId = null;
          }
          dispatchRoom({
            type: "list",
            rooms: data.rooms || [],
            preferRoomId,
            viewerUserId: data.viewerUserId ?? null,
          });
        },
      );

      socketInstance.on("room:history", (data: { roomId: string; messages: RoomMessage[] }) => {
        dispatchRoom({ type: "history", roomId: data.roomId, messages: data.messages || [] });
      });

      socketInstance.on("room:created", (data: { room: RoomSummary; requestId?: string }) => {
        const enter = data.requestId != null && data.requestId === pendingCreateRef.current;
        if (enter) pendingCreateRef.current = null;
        dispatchRoom({ type: "created", room: data.room, enter });
      });

      socketInstance.on("room:updated", (data: { room: RoomSummary }) => {
        dispatchRoom({ type: "updated", room: data.room, enter: false });
      });

      socketInstance.on("room:deleted", (data: { roomId: string }) => {
        if (openedRoomRef.current === data.roomId) openedRoomRef.current = null;
        dispatchRoom({ type: "deleted", roomId: data.roomId });
      });

      // NPC chat history (sent on demand) — only apply if it matches the current dialog
      socketInstance.on(
        "npc:history",
        (data: {
          npcId: string;
          messages: { id?: string; responseRequestId?: string; role: string; content: string }[];
        }) => {
          if (!dialogNpcRef.current || dialogNpcRef.current.npcId !== data.npcId) return;
          const historyMessages = (data.messages || []).map<NpcChatMessage>((m) => ({
            role: m.role === "npc" ? "npc" : "player",
            content: m.content,
            id: m.id,
            responseRequestId: m.responseRequestId,
          }));
          setNpcMessages(historyMessages);
        },
      );

      // Room messages
      socketInstance.on("room:message", (data: { roomId: string; message: RoomMessage }) => {
        const msg = data.message;
        dispatchRoom({ type: "message", roomId: data.roomId, message: msg });
        if (msg.senderKind === "system") return;
        // Show speech bubble on map
        if (msg.senderId) {
          EventBus.emit("chat:bubble", { senderId: msg.senderId });
          EventBus.emit("chat:speech", { actorId: msg.senderId, text: msg.content });
        }
        // Add notification + toast if not from self
        if (msg.senderName !== characterNameRef.current) {
          const preview = msg.content.length > 30 ? msg.content.slice(0, 30) + "..." : msg.content;
          showToastNotification(msg.id, `${msg.senderName}: ${preview}`);
        }
      });

      socketInstance.on(
        "room:response-state",
        (data: { roomId: string; response: ChatResponse }) => {
          if (data.response.content)
            EventBus.emit("chat:speech", {
              actorId: data.response.npcId,
              text: data.response.content,
            });
          dispatchChatResponse({
            type: "state",
            scope: "room",
            scopeId: data.roomId,
            response: data.response,
          });
        },
      );
      socketInstance.on(
        "room:response-snapshot",
        (data: { roomId: string; responses: ChatResponse[] }) => {
          dispatchChatResponse({
            type: "snapshot",
            scope: "room",
            scopeId: data.roomId,
            responses: data.responses || [],
          });
        },
      );
      socketInstance.on("npc:response-state", (data: { response: ChatResponse }) => {
        if (data.response.content)
          EventBus.emit("chat:speech", {
            actorId: data.response.npcId,
            text: data.response.content,
          });
        dispatchChatResponse({
          type: "state",
          scope: "npc",
          scopeId: data.response.npcId,
          response: data.response,
        });
        if (dialogNpcRef.current?.npcId === data.response.npcId) {
          setNpcMessages((previous) => reconcileNpcResponseMessages(previous, [data.response]));
          if (
            data.response.status === "complete" ||
            data.response.status === "failed" ||
            data.response.status === "cancelled"
          ) {
            setNpcActivityKey(null);
          }
        }
      });
      socketInstance.on(
        "npc:response-snapshot",
        (data: { npcId: string; responses: ChatResponse[] }) => {
          dispatchChatResponse({
            type: "snapshot",
            scope: "npc",
            scopeId: data.npcId,
            responses: data.responses || [],
          });
          if (dialogNpcRef.current?.npcId === data.npcId) {
            setNpcMessages((previous) =>
              reconcileNpcResponseMessages(previous, data.responses || [], {
                replaceTransient: true,
              }),
            );
            const hasActive = (data.responses || []).some(
              (response) =>
                response.status === "queued" ||
                response.status === "thinking" ||
                response.status === "streaming",
            );
            if (!hasActive) setNpcActivityKey(null);
          }
        },
      );

      // A notice for free chat only — do not reuse meeting-only events for the map room. Map room broadcasts
      // also reach people in a meeting (meeting participants do not leave the map room), and then someone else's
      // map events get inserted into the transcript of a meeting in progress.
      socketInstance.on(
        "room:mention-skipped",
        (data: {
          roomId: string;
          npcId?: string;
          npcName?: string;
          reason: MentionSkipReason | "no_match";
        }) => {
          if (data.roomId !== openedRoomRef.current) return;
          if (data.reason === "no_match") {
            // The mention matched no member — there is no specific NPC, so a nameless toast.
            showToastNotification(`chat-mention-no-match-${Date.now()}`, t("room.mentionNoMatch"));
            return;
          }
          showToastNotification(
            `chat-mention-skipped-${data.npcId}-${Date.now()}`,
            t(mentionSkipI18nKey(data.reason), { name: data.npcName ?? "" }),
          );
        },
      );

      // A failed turn (timeout, adapter error, empty response). The map has no streaming bubble, so without this
      // signal the user is left with only their own bubble.
      socketInstance.on(
        "room:npc-aborted",
        (data: { roomId: string; npcId: string; npcName: string; reason: string }) => {
          if (data.roomId !== openedRoomRef.current) return;
          showToastNotification(
            `chat-npc-aborted-${data.npcId}-${Date.now()}`,
            t(data.reason === "queue_full" ? "chat.npcQueueFull" : "chat.npcNoResponse", {
              name: data.npcName,
            }),
          );
        },
      );

      socketInstance.on("member:kicked", () => {
        alert(t("game.removedFromChannel"));
        router.push("/channels");
      });

      socketInstance.on(
        "map:refresh",
        (data: { channelId: string; protocolVersion: number; phase: string }) => {
          if (data.channelId !== channelId || data.protocolVersion !== 1) return;
          if (data.phase === "begin") EventBus.emit("map-refresh-start");
          if (data.phase === "ready") window.location.reload();
        },
      );

      socketInstance.on(
        "channel:updated",
        (data: { name?: string; isPublic?: boolean; motionConfig?: NpcMotionConfig }) => {
          setChannel((prev) => (prev ? { ...prev, ...data } : prev));
          // The owner changed the walking speed. If this browser is driving NPCs it applies from the next step.
          if (data.motionConfig) EventBus.emit("channel:motion-config", data.motionConfig);
        },
      );

      socketInstance.on("channel:deleted", () => {
        alert(t("game.channelDeleted"));
        router.push("/channels");
      });

      socketInstance.on(
        "channel:access-denied",
        (data: { channelId?: string; action?: string; reason?: string; errorCode?: string }) => {
          setIsNpcStreaming(false);
          const message = getLocalizedErrorMessage(t, data, "errors.forbidden");
          if (data.errorCode === "character_missing") {
            // Entering requires my character — create one and come back to this channel.
            alert(message);
            router.push(
              channelId
                ? `/characters?joinChannel=${encodeURIComponent(channelId)}`
                : "/characters",
            );
            return;
          }
          showToastNotification(
            `channel-access-denied-${data.action ?? "unknown"}-${data.reason ?? "unknown"}`,
            message,
          );
        },
      );

      socketInstance.on("session:kicked", (data: { reason: string }) => {
        setIsNpcStreaming(false);
        alert(getLocalizedMessage(t, data.reason, "game.sessionKicked"));
        router.push("/channels");
      });

      socketInstance.on("join-error", () => {
        setIsNpcStreaming(false);
        router.push("/channels");
      });

      socketInstance.on("npc:motion-state", (snapshot: MotionSnapshot) => {
        if (snapshot.channelId !== channelId) return;
        npcMotionSnapshotRef.current = snapshot;
        setNpcMoveStates(
          Object.fromEntries(
            snapshot.npcs.map((npc) => [
              npc.npcId,
              npc.phase === "called"
                ? "moving-to-player"
                : npc.phase === "ambient"
                  ? "idle"
                  : npc.phase,
            ]),
          ),
        );
        setNpcCallers(
          Object.fromEntries(
            snapshot.npcs
              .filter((npc) => npc.ownerSocketId && npc.phase !== "ambient")
              .map((npc) => [npc.npcId, npc.ownerSocketId!]),
          ),
        );
      });
      // NPC movement socket events — relay to the simulation via EventBus
      socketInstance.on(
        "npc:come-to-player",
        (data: { npcId: string; targetPlayerId: string; reason?: string; roomId?: string }) => {
          // Room-runtime also emits this legacy intent directly. Acquire the same server
          // claim before driving; the coordinator replies with snapshot then this event.
          if (
            npcMotionSnapshotRef.current?.npcs.find((npc) => npc.npcId === data.npcId)
              ?.ownerSocketId !== data.targetPlayerId
          ) {
            if (data.targetPlayerId === socketInstance?.id)
              socketInstance?.emit(
                "npc:call",
                {
                  channelId,
                  npcId: data.npcId,
                  ...(data.reason ? { reason: data.reason } : {}),
                  ...(data.roomId ? { roomId: data.roomId } : {}),
                },
                // Not a call a person pressed but a confirming call that follows the room runtime's intent —
                // toasting would warn on every conversation turn. Still, it is not silently discarded.
                (result: unknown) => {
                  if (isNpcCallRejected(result))
                    console.warn("[npc-call] intent claim rejected", data.npcId, result);
                },
              );
            return;
          }
          EventBus.emit("npc:movement-owner", { npcId: data.npcId, ownerId: data.targetPlayerId });
          setNpcCallers((prev) => ({ ...prev, [data.npcId]: data.targetPlayerId }));
          // Only the caller runs local A* pathfinding; other clients follow npc:position-sync
          if (socketInstance && data.targetPlayerId === socketInstance.id) {
            // The display is decided on arrival, but the reason is only known now. At close range the emit below
            // proceeds all the way to arrival on the spot, so it must be recorded before the emit.
            // A context menu call (no reason) invalidates a previous map chat wait. Without clearing it,
            // when that NPC arrives the 1:1 dialog the user just explicitly requested gets swallowed —
            // the simulation silently ignores recalls of an NPC already walking, so arrival happens from the original
            // walk and the entry stays alive until then.
            mapChatWalkersRef.current.noteCall(data.npcId, data.reason);
            mapChatParticipantsRef.current.noteCalled(data.roomId, data.npcId, data.reason);
            EventBus.emit("npc:call-to-player", {
              npcId: data.npcId,
              reason: data.reason,
              roomId: data.roomId,
            });
          }
        },
      );

      // Generic NPC chat responses stay in the dialog — nothing pulls the NPC over.
      socketInstance.on("npc:response-complete", () => {});

      // Progress state. If the dialog is open, as a status line inside it; otherwise as a bubble on the map —
      // do not show the same fact in two places at once.
      socketInstance.on("npc:activity", (data: { npcId: string; activityKey?: string | null }) => {
        const key = data.activityKey ?? null;
        const inDialog = dialogNpcRef.current?.npcId === data.npcId;
        if (inDialog) {
          setNpcActivityKey(key);
          EventBus.emit("npc:activity-bubble", { npcId: data.npcId });
          return;
        }
        setNpcActivityKey(null);
        EventBus.emit("npc:activity-bubble", {
          npcId: data.npcId,
          text: key ? t(key) : undefined,
        });
      });

      socketInstance.on("npc:returning", (data: { npcId: string }) => {
        EventBus.emit("npc:start-return", { npcId: data.npcId });
      });

      // NPC response streaming — DM messages only
      socketInstance.on("npc:response", (data: NpcResponsePayload) => {
        if (data.responseRequestId) return;
        const chunk = resolveNpcResponseChunk(data, t);
        // Ignore responses for NPCs not in the current dialog
        if (dialogNpcRef.current && dialogNpcRef.current.npcId !== data.npcId) return;

        if (chunk) {
          const continuing = streamBufferRef.current.length > 0;
          streamBufferRef.current += chunk;
          const buffered = streamBufferRef.current;
          EventBus.emit("chat:speech", { actorId: data.npcId, text: buffered });
          setIsNpcStreaming(true);
          setNpcMessages((prev) => upsertLegacyNpcChunk(prev, buffered, continuing));
        }
        if (data.done) {
          setIsNpcStreaming(false);
          const hadBufferedContent = streamBufferRef.current.length > 0;
          const cleaned = streamBufferRef.current.trim();
          if (hadBufferedContent) {
            setNpcMessages((prev) => {
              const lastIdx = prev.length - 1;
              if (lastIdx >= 0 && prev[lastIdx].role === "npc") {
                const updated = [...prev];
                updated[lastIdx] = { ...updated[lastIdx], content: cleaned };
                return updated;
              }
              return prev;
            });
          }
          streamBufferRef.current = "";
        }
      });

      // Request initial room list for this channel
      if (channelId) {
        socketInstance.emit("room:list", { channelId });
      }
    });

    return () => {
      cancelled = true;
      npcMotionSnapshotRef.current = null;
      window.removeEventListener("pagehide", leavePage);
      window.removeEventListener("pageshow", restorePage);
      if (socketInstance) {
        socketInstance.off("room:error");
        socketInstance.off("room:list-response");
        socketInstance.off("room:history");
        socketInstance.off("room:message");
        socketInstance.off("room:response-state");
        socketInstance.off("room:response-snapshot");
        socketInstance.off("npc:response-state");
        socketInstance.off("npc:response-snapshot");
        socketInstance.off("room:created");
        socketInstance.off("room:updated");
        socketInstance.off("room:deleted");
        socketInstance.off("room:mention-skipped");
        socketInstance.off("room:npc-aborted");
        socketInstance.removeAllListeners();
        socketInstance.disconnect();
      }
      // removeAllListeners() detaches the disconnect handler first, so the reset inside it does not run.
      // Reset here so that when the socket is recreated the room:open effect unconditionally reopens on the new socket.
      openedRoomRef.current = null;
      setSocket(null);
      setSocketConnected(false);
      setChannelPlayers([]);
      socketRef.current = null;
    };
  }, [channelId, router, showToastNotification, t]);

  // Shared dialog state reset
  const resetDialog = useCallback(() => {
    setDialogNpc(null);
    dialogNpcRef.current = null;
    setNpcMessages([]);
    npcMessagesRef.current = [];
    setIsNpcStreaming(false);
    setNpcSelectList(null);
    streamBufferRef.current = "";
    setNpcActivityKey(null);
  }, []);

  // Keep refs in sync with state for use in socket handlers
  useEffect(() => {
    npcMessagesRef.current = npcMessages;
  }, [npcMessages]);

  // Listen for NPC interact event from the simulation
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

    const handleInteractSelect = (data: {
      targets: { id: string; name: string; type: "npc" | "player" }[];
    }) => {
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
      EventBus.emit("npc:bubble", {
        npcId: data.npcId,
        text: t("game.npcGreetingBubble"),
        durationMs: 4500,
      });
      showToastNotification(
        `greet-${data.npcId}-${Date.now()}`,
        t("game.npcGreeting", { name: data.npcName }),
      );
    };

    const handleToastShow = (data: {
      message?: string;
      messageKey?: string;
      params?: Record<string, string>;
    }) => {
      // Cancel any auto-clear timer so proximity toast persists until toast:hide
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
        toastTimerRef.current = null;
      }
      // The simulation does not know the locale — pass only the key and translate here.
      // (The scene used to build English sentences and pass them, so Korean users saw English too.)
      setToastMessage(data.messageKey ? t(data.messageKey, data.params) : (data.message ?? ""));
    };
    const handleToastHide = () => {
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
        toastTimerRef.current = null;
      }
      setToastMessage(null);
    };

    const handleContextMenu = (data: {
      npcId: string;
      npcName: string;
      screenX: number;
      screenY: number;
      moveState: string;
    }) => {
      setContextMenu({
        npcId: data.npcId,
        npcName: data.npcName,
        x: data.screenX,
        y: data.screenY,
        moveState: data.moveState,
      });
    };

    const handleMovementStarted = (data: { npcId: string }) => {
      setNpcMoveStates((prev) => ({ ...prev, [data.npcId]: "moving-to-player" }));
    };
    const handleMovementArrived = (data: { npcId: string; npcName?: string }) => {
      setNpcMoveStates((prev) => ({ ...prev, [data.npcId]: "waiting" }));
      // NPCs called via map chat answer in map chat — opening the 1:1 dialog here would cover
      // the panel where that answer shows.
      const fromMapChat = mapChatWalkersRef.current.takeOnArrival(data.npcId);
      // Auto-open dialog when NPC arrives — preserve existing messages (don't resetDialog)
      if (data.npcName && !fromMapChat) {
        const nextDialogNpc = { npcId: data.npcId, npcName: data.npcName };
        // If the employee came to report, show that report at the top of the dialog.
        const report = reportingItemRef.current;
        setDialogReport(report && report.npcId === data.npcId ? report : null);
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
      mapChatWalkersRef.current.forget(data.npcId);
      setNpcMoveStates((prev) => ({ ...prev, [data.npcId]: "idle" }));
      setNpcCallers((prev) => {
        const next = { ...prev };
        delete next[data.npcId];
        return next;
      });
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
    // After closing, the list is visible — ask again so what was just exchanged shows in the preview.
    socketRef.current?.emit("npc:dm-threads");
  }, [resetDialog]);

  const closeRosterMenus = useCallback(() => {
    setContextMenu(null);
  }, []);

  const handleCallNpcById = useCallback(
    (npcId: string) => {
      if (!socket) return;
      // The server can refuse the call (in a meeting, occupied by another user, list mismatch). The ack used to be
      // ignored, so it looked **as if the click did nothing**, and the user had no way to know why.
      socket.emit("npc:call", { channelId, npcId }, (result: unknown) => {
        if (!isNpcCallRejected(result)) return;
        showToastNotification(
          `npc-call-${npcId}`,
          t(npcCallErrorKey((result as { error?: unknown })?.error)),
        );
      });
      setContextMenu(null);
      closeRosterMenus();
    },
    [socket, channelId, closeRosterMenus, showToastNotification, t],
  );

  const handleTalkNpcById = useCallback(
    (npcId: string, npcName: string) => {
      EventBus.emit("npc:approach-and-interact", { npcId, npcName });
      setContextMenu(null);
      closeRosterMenus();
    },
    [closeRosterMenus],
  );

  /**
   * The gateway profile is the source of truth for an NPC's name, appearance and persona, so they are not edited on the map.
   * The only thing the map can do is **move the seat**.
   */
  const handleMoveNpcById = useCallback(
    (npcId: string) => {
      // Being in the map list (`channelNpcs`) = already has a seat = has a sprite on other screens
      // too. What to broadcast after placement finishes branches here.
      setPendingNpc({ id: npcId, wasPlaced: channelNpcs.some((n) => n.id === npcId) });
      setPlacementMode(true);
      setContextMenu(null);
      closeRosterMenus();
    },
    [channelNpcs, closeRosterMenus],
  );

  const gatewayId = channel?.gatewayConfig?.gatewayId ?? null;

  const openProfileSettings = useCallback(() => {
    if (!gatewayId) return;
    const returnTo = `${window.location.pathname}${window.location.search}`;
    setContextMenu(null);
    closeRosterMenus();
    router.push(employeesHref(gatewayId, { returnTo }));
  }, [closeRosterMenus, gatewayId, router]);

  const handleHireNpc = useCallback(() => {
    if (!gatewayId) return;
    const returnTo = `${window.location.pathname}${window.location.search}`;
    closeRosterMenus();
    router.push(employeesHref(gatewayId, { create: true, returnTo }));
  }, [closeRosterMenus, gatewayId, router]);

  const handleResetNpcChatById = useCallback(
    (npcId: string) => {
      if (socketRef.current) {
        socketRef.current.emit("npc:reset-chat", { npcId });
      }
      if (dialogNpcRef.current?.npcId === npcId) {
        setNpcMessages([]);
        npcMessagesRef.current = [];
      }
      setContextMenu(null);
      closeRosterMenus();
    },
    [closeRosterMenus],
  );

  /**
   * This is **clocking out**, not firing. Deleting the NPC row would lose the seat when clocking back in.
   * It goes through the socket rather than REST because the in-meeting block is visible only on the socket side.
   */
  const setNpcActiveById = useCallback(
    (npcId: string, active: boolean) => {
      if (!socketRef.current || !channelId) return;
      socketRef.current.emit("npc:set-active", { channelId, npcId, active });
      setContextMenu(null);
      closeRosterMenus();
    },
    [channelId, closeRosterMenus],
  );

  const handleSleepNpcById = useCallback(
    (npcId: string) => {
      if (!confirm(t("game.fireNpcConfirm"))) return;
      setNpcActiveById(npcId, false);
    },
    [setNpcActiveById, t],
  );

  const handleOpenPlayerChat = useCallback(() => {
    EventBus.emit("player:chat-open");
    closeRosterMenus();
  }, [closeRosterMenus]);

  const handleEditCharacter = useCallback(() => {
    closeRosterMenus();
    router.push("/characters");
  }, [closeRosterMenus, router]);

  const handleStartPositionSetting = useCallback(() => {
    if (!isOwner || mode !== "office") return;
    setSpawnSetMode(true);
    closeRosterMenus();
  }, [closeRosterMenus, isOwner, mode]);

  const handleSelectNpc = useCallback(
    (npcId: string, npcName: string) => {
      resetDialog();
      const nextDialogNpc = { npcId, npcName };
      dialogNpcRef.current = nextDialogNpc;
      setDialogNpc(nextDialogNpc);
      EventBus.emit("dialog:open");
      EventBus.emit("npc:bubble-clear", { npcId });
      if (socketRef.current) {
        socketRef.current.emit("npc:history", { npcId });
      }
    },
    [resetDialog],
  );

  const handleDialogSend = useCallback(
    async (message: string, files?: File[]) => {
      if (!socket || !dialogNpc) return;
      if (!socket.connected) {
        showToastNotification(
          `npc-chat-disconnected-${dialogNpc.npcId}`,
          t("game.npcChatDisconnected"),
        );
        return;
      }
      // Add player message immediately (with file names if attached)
      const displayMessage =
        files && files.length > 0
          ? `${message}\n📎 ${files.map((f) => f.name).join(", ")}`
          : message;
      const sourceMessageId = crypto.randomUUID();
      setNpcMessages((prev) => [
        ...prev,
        { id: sourceMessageId, role: "player", content: displayMessage },
      ]);

      // Convert files to ArrayBuffers for socket transport
      let filePayloads:
        Array<{ name: string; type: string; size: number; data: ArrayBuffer }> | undefined;
      if (files && files.length > 0) {
        filePayloads = await Promise.all(
          files.map(async (f) => ({
            name: f.name,
            type: f.type,
            size: f.size,
            data: await f.arrayBuffer(),
          })),
        );
      }

      if (socket.id) EventBus.emit("chat:speech", { actorId: socket.id, text: displayMessage });
      // A DM opened from the list has not called that employee — call them **at send time** (Dante's instruction).
      // If they are already beside us or on the way the scene ignores the recall, so do not fire then.
      if (channelId && needsCallBeforeDmSend(npcMoveStatesRef.current[dialogNpc.npcId])) {
        // Do not include reason — the only value the server knows is "map-chat" (post-processing that opens the room screen),
        // and unknown values are silently dropped. The DM is already open, so a plain call is right.
        socket.emit("npc:call", { channelId, npcId: dialogNpc.npcId }, (result: unknown) => {
          if (!isNpcCallRejected(result)) return;
          showToastNotification(
            `npc-call-${dialogNpc.npcId}`,
            t(npcCallErrorKey((result as { error?: unknown })?.error)),
          );
        });
      }
      // Update the list preview first without a server round trip — the list is asked again on close.
      setDmThreads((previous) => [
        {
          npcId: dialogNpc.npcId,
          lastMessage: { role: "player" as const, content: message },
          lastAt: Date.now(),
        },
        ...previous.filter((thread) => thread.npcId !== dialogNpc.npcId),
      ]);
      socket.emit("npc:chat", {
        npcId: dialogNpc.npcId,
        message,
        sourceMessageId,
        // Right after reconnecting the server's `players` does not have this socket yet and does not know the character.
        // Send the character along so conversation in that window is not lost (the server verifies ownership).
        characterId: characterId ?? undefined,
        files: filePayloads,
      });
    },
    [socket, channelId, dialogNpc, characterId, showToastNotification, t],
  );

  const handleRoomSend = useCallback(
    (message: string) => {
      if (!socket || !socket.connected) {
        showToastNotification("channel-chat-disconnected", t("game.channelChatDisconnected"));
        return;
      }
      if (!currentRoomId) return;
      socket.emit("room:send", { roomId: currentRoomId, message });
      if (socket.id) EventBus.emit("chat:speech", { actorId: socket.id, text: message });
      // A message restarting the conversation — call participants who went back to their seats to our side again.
      // The server calls mentioned NPCs separately, and if they are already beside us or walking the scene ignores the recall.
      const present = new Set(
        Object.entries(npcMoveStatesRef.current)
          .filter(([, st]) => st === "waiting" || st === "moving-to-player")
          .map(([id]) => id),
      );
      // For group rooms the member list is the source of truth for participants (everyone answers even without a mention).
      // For office the member list is the whole channel, so that is impossible and the mention history is used.
      const room = roomState.rooms.find((candidate) => candidate.id === currentRoomId);
      const targets =
        room?.kind === "group"
          ? room.members
              .filter((member) => member.kind === "npc")
              .map((member) => member.id)
              .filter((npcId) => !present.has(npcId))
          : mapChatParticipantsRef.current.recallTargets(currentRoomId, present);
      for (const npcId of targets) {
        socket.emit(
          "npc:call",
          { channelId, npcId, reason: "map-chat", roomId: currentRoomId },
          // This is the path that calls automatically when restarting a conversation. `already_claimed` (another user
          // is in conversation) is normal here, so no toast — but a trace is left.
          (result: unknown) => {
            if (isNpcCallRejected(result))
              console.warn("[npc-call] room recall rejected", npcId, result);
          },
        );
      }
    },
    [socket, channelId, currentRoomId, roomState.rooms, showToastNotification, t],
  );

  /** Moving rooms closes the previous room and opens the new one. The last room is remembered per channel. */
  useEffect(() => {
    const socketInstance = socketRef.current;
    if (!socketInstance || !socketConnected || !currentRoomId) return;
    const previous = openedRoomRef.current;
    if (previous === currentRoomId) return;
    if (previous) socketInstance.emit("room:close", { roomId: previous });
    socketInstance.emit("room:open", { roomId: currentRoomId });
    openedRoomRef.current = currentRoomId;
    if (channelId) {
      try {
        window.localStorage.setItem(lastRoomKey(channelId), currentRoomId);
      } catch {
        // Private mode or blocked storage — we just cannot remember the last room.
      }
    }
  }, [currentRoomId, socketConnected, channelId]);

  const handleRoomAction = useCallback(
    (action: Parameters<typeof reduceRoomState>[1]) => dispatchRoom(action),
    [],
  );

  const handleRoomCreate = useCallback(
    (name: string, npcIds: string[], userIds: string[]) => {
      if (!socket || !socket.connected || !channelId) return;
      // When the server returns `room:created`, this ticket is the only basis for telling "the one I created".
      const requestId = crypto.randomUUID();
      pendingCreateRef.current = requestId;
      socket.emit("room:create", { channelId, name, npcIds, userIds, requestId });
    },
    [socket, channelId],
  );

  const handleRoomInvite = useCallback(
    (roomId: string, npcIds: string[], userIds: string[]) => {
      socket?.emit("room:invite", { roomId, npcIds, userIds });
    },
    [socket],
  );

  const handleRoomLeave = useCallback(
    (roomId: string) => {
      socket?.emit("room:leave", { roomId });
    },
    [socket],
  );

  const handleRoomRename = useCallback(
    (roomId: string, name: string) => {
      socket?.emit("room:rename", { roomId, name });
    },
    [socket],
  );

  const handleRoomDelete = useCallback(
    (roomId: string) => {
      socket?.emit("room:delete", { roomId });
    },
    [socket],
  );

  /** NPCs that can be mentioned with `@` — for office everyone clocked in, for group only those who are room members. */
  // Dialog avatars — employees' appearance from the roster, people's from the online list.
  const avatarFor = useMemo(
    () =>
      createAvatarLookup(
        rosterNpcs,
        channelPlayers.map((player) => ({
          userId: player.id === "__self__" ? roomState.viewerUserId : player.userId,
          name: player.name,
          appearance: player.appearance,
        })),
      ),
    [rosterNpcs, channelPlayers, roomState.viewerUserId],
  );

  const mentionCandidatesFor = useCallback(
    (roomId: string | null) => {
      const active = rosterNpcs
        .filter((npc) => npc.active)
        .map((npc) => ({ id: npc.id, name: npc.name }));
      const room = roomState.rooms.find((candidate) => candidate.id === roomId);
      if (!room || room.kind === "office") return active;
      const memberIds = new Set(
        room.members.filter((member) => member.kind === "npc").map((member) => member.id),
      );
      return active.filter((npc) => memberIds.has(npc.id));
    },
    [rosterNpcs, roomState.rooms],
  );

  const handleGamePasswordSubmit = useCallback(
    async (password: string): Promise<string | null> => {
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
    },
    [channelId, t],
  );

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
        fetch("/api/characters/me").then((res) => res.json()),
        channelRes
          ? channelRes.json()
          : fetch(`/api/channels/${channelId}`).then((res) => res.json()),
      ])
        .then(async ([charData, channelData]) => {
          // Character
          const found: Character | null = charData.character ?? null;
          if (!found) {
            // Without my character one cannot enter — create one and come back to this channel.
            router.replace(`/characters?joinChannel=${encodeURIComponent(channelId)}`);
            return;
          }
          setCharacter(found);
          characterNameRef.current = found.name;
          characterAppearanceRef.current = found.appearance ?? null;

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
              throw new Error(
                getLocalizedErrorMessage(t, errorData, "errors.failedToLoadGameData"),
              );
            }
            nextChannel = {
              ...nextChannel,
              isMember: true,
            };
          }

          setChannel(nextChannel);
          if (nextChannel?.isOwner) setIsOwner(true);

          // Channel data the simulation reads when it starts
          // Parse mapData if it's a JSON string (SQLite stores as text)
          let rawMapData = channelData.channel.mapData;
          if (typeof rawMapData === "string") {
            try {
              rawMapData = JSON.parse(rawMapData);
            } catch {
              /* keep as string */
            }
          }
          // Detect if mapData is actually Tiled JSON (has tiledversion field)
          const isTiledJson =
            rawMapData && typeof rawMapData === "object" && "tiledversion" in rawMapData;

          const nextPendingChannelData: PendingChannelData = {
            channelId: channelData.channel.id,
            mapRevision: channelData.channel.mapRevision ?? "null",
            mapData: isTiledJson ? null : rawMapData || null,
            tiledJson: isTiledJson ? rawMapData : null,
            mapConfig:
              typeof channelData.channel.mapConfig === "string"
                ? JSON.parse(channelData.channel.mapConfig)
                : channelData.channel.mapConfig || null,
            motionConfig: channelData.channel.motionConfig ?? null,
            savedPosition:
              channelData.channel.lastX != null && channelData.channel.lastY != null
                ? { x: channelData.channel.lastX, y: channelData.channel.lastY }
                : null,
          };
          setPendingChannelData(nextPendingChannelData);
          setGameChannelData(nextPendingChannelData);

          setLoading(false);
        })
        .catch(() => {
          setError(t("errors.failedToLoadGameData"));
          setLoading(false);
        });
    })();
  }, [channelId, router, t]);

  /**
   * Read the map list and the attendance roster together. Updating only one makes two parts of the screen
   * state different facts — like clocking someone out in the roster while the header's "출근 N명" stays the same.
   */
  const refreshNpcLists = useCallback(async () => {
    if (!channelId) return;
    try {
      const [mapRes, rosterRes] = await Promise.all([
        fetch(`/api/npcs?channelId=${channelId}`),
        fetch(`/api/npcs?channelId=${channelId}&roster=1`),
      ]);
      if (!mapRes.ok) {
        const errorData = await mapRes.json().catch(() => ({}));
        throw new Error(getLocalizedErrorMessage(t, errorData, "errors.failedToFetchNpcs"));
      }
      const mapData = await mapRes.json();
      if (mapData.npcs) setChannelNpcs(mapData.npcs);
      if (rosterRes.ok) {
        const rosterData = await rosterRes.json();
        if (Array.isArray(rosterData.npcs)) {
          setRosterNpcs(
            rosterData.npcs.map(
              (
                npc: RosterNpc & {
                  positionX?: number | null;
                  placed?: boolean;
                  seatNumber?: number | null;
                },
              ) => ({
                id: npc.id,
                name: npc.name,
                appearance: npc.appearance,
                active: !!npc.active,
                placed: !!npc.placed,
                seatNumber: npc.seatNumber ?? null,
                profile: npc.profile ?? null,
              }),
            ),
          );
        }
      }
    } catch (err) {
      console.error("Failed to fetch channel NPCs:", err);
    }
  }, [channelId, t]);

  // Fetch NPCs for this channel (for meeting room + roster)
  useEffect(() => {
    if (!channelId || (!channel?.isMember && !channel?.isOwner)) return;
    void refreshNpcLists();
  }, [channelId, channel?.isMember, channel?.isOwner, refreshNpcLists]);

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
    return () => {
      EventBus.off("scene-ready", onSceneReady);
    };
  }, [isOwner]);

  // Placement mode coordination
  useEffect(() => {
    if (placementMode && pendingNpc) {
      EventBus.emit("placement-mode-start", pendingNpc);
    }
    const restorePlacement = () => {
      if (placementMode && pendingNpc) EventBus.emit("placement-mode-start", pendingNpc);
    };
    EventBus.on("scene-ready", restorePlacement);
    const onPlacementComplete = async (data: { col: number; row: number }) => {
      if (!pendingNpc) return;
      // Keep placement mode only on 409 (tile occupied). `return` does not skip finally,
      // so signal with a flag — previously only the comment said "keep it" while in reality
      // placement mode quietly turned off (clicking a cell did nothing).
      let keepPlacementMode = false;
      try {
        // Do not create a new NPC — **give a seat** to an existing row. The create route
        // is gone, and this route accepts nothing but seat and facing (the profile is the source of truth).
        const request = buildPlacementRequest(pendingNpc.id, data.col, data.row);
        const res = await fetch(request.url, request.init);
        // Another NPC is already on that cell (`npcs_channel_position_unique`). Keep placement mode
        // and wait for another cell, but say why it did not work.
        if (keepsPlacementMode(res.status)) {
          keepPlacementMode = true;
          showToastNotification("npc-place-occupied", t("errors.tileAlreadyOccupied"));
          return;
        }
        if (!res.ok) {
          const errorData = await res.json().catch(() => ({}));
          throw new Error(getLocalizedErrorMessage(t, errorData, "errors.failedToCreateNpc"));
        }
        const result = await res.json();
        await refreshNpcLists();
        if (result?.npc) {
          // A move **removes and re-adds** both locally and remotely. Sending only add makes the receiving side's
          // `npc:added` ignore it as "an NPC that already exists", leaving it on the old cell.
          for (const step of placementBroadcastPlan(pendingNpc.wasPlaced)) {
            if (step === "remove") {
              EventBus.emit("npc:remove-local", { npcId: pendingNpc.id });
              if (socket) socket.emit("npc:broadcast-remove", { npcId: pendingNpc.id });
            } else {
              EventBus.emit("npc:spawn-local", result.npc);
              if (socket) socket.emit("npc:broadcast-add", result.npc);
            }
          }
        }
      } catch (err) {
        console.error("Failed to place NPC:", err);
        showToastNotification(
          "npc-place-error",
          err instanceof Error ? err.message : t("errors.failedToCreateNpc"),
        );
      } finally {
        if (!keepPlacementMode) {
          setPlacementMode(false);
          setPendingNpc(null);
          EventBus.emit("placement-mode-end");
        }
      }
    };
    const onPlacementCancel = () => {
      setPlacementMode(false);
      setPendingNpc(null);
    };
    EventBus.on("placement-complete", onPlacementComplete);
    EventBus.on("placement-cancel", onPlacementCancel);
    return () => {
      EventBus.off("scene-ready", restorePlacement);
      EventBus.off("placement-complete", onPlacementComplete);
      EventBus.off("placement-cancel", onPlacementCancel);
    };
  }, [placementMode, pendingNpc, refreshNpcLists, showToastNotification, socket, t]);

  /**
   * The result of the roster toggle arrives over the socket. Success is a channel-wide broadcast (`npc:updated`),
   * and failure goes only to the requesting socket (`npc:set-active:error`) — if being blocked by a meeting
   * is not reported with a toast, the button looks like it did nothing.
   */
  useEffect(() => {
    if (!socket) return;
    const onNpcUpdated = () => {
      void refreshNpcLists();
    };
    const onSetActiveError = (data: { npcId: string; errorCode: string }) => {
      showToastNotification(
        `npc-set-active-${data.npcId}`,
        getLocalizedErrorMessage(t, data, "errors.failedToUpdateNpc"),
      );
    };
    socket.on("npc:updated", onNpcUpdated);
    socket.on("npc:set-active:error", onSetActiveError);
    return () => {
      socket.off("npc:updated", onNpcUpdated);
      socket.off("npc:set-active:error", onSetActiveError);
    };
  }, [socket, refreshNpcLists, showToastNotification, t]);

  /**
   * Count only this channel's kanban events (`kanban:event`) to give the modal a reread signal (R26).
   * They are counted even while the modal is closed, but it reads from scratch the moment it opens anyway, so the accumulation is harmless.
   */
  useEffect(() => {
    if (!socket || !channelId) return;
    const onKanbanEvent = (data: { channelId?: string }) => {
      if (data?.channelId && data.channelId !== channelId) return;
      setKanbanRefreshTick((n) => n + 1);
    };
    socket.on("kanban:event", onKanbanEvent);
    return () => {
      socket.off("kanban:event", onKanbanEvent);
    };
  }, [socket, channelId]);

  /**
   * Unread badges on the employee dialog tabs (T6) — recounted only when the dialog opens and when the existing
   * `kanban:event`/`cron:event` arrive. **No polling**: this query reads the Hermes board on the server.
   */
  useEffect(() => {
    if (!socket || !channelId) return;
    const bump = () => setPanelBadgeTick((n) => n + 1);
    socket.on(CRON_SOCKET_EVENT, bump);
    return () => {
      socket.off(CRON_SOCKET_EVENT, bump);
    };
  }, [socket, channelId]);
  useEffect(() => {
    if (!channelId || !dialogNpcId) {
      setPanelBadges(null);
      return;
    }
    let alive = true;
    fetch(
      `/api/channels/${encodeURIComponent(channelId)}/npcs/${encodeURIComponent(dialogNpcId)}/panel-reads`,
    )
      .then((res) => (res.ok ? (res.json() as Promise<PanelBadgeCounts>) : null))
      .then((badges) => {
        if (alive) setPanelBadges(badges);
      })
      .catch(() => {
        // For badges "unknown means none" is the right answer — failures are not surfaced on screen.
        if (alive) setPanelBadges(null);
      });
    return () => {
      alive = false;
    };
  }, [channelId, dialogNpcId, kanbanRefreshTick, panelBadgeTick]);
  /** A tab was opened — zero that badge first (so the user does not wait) and send the record. */
  const markPanelTabSeen = useCallback(
    (tab: "cron" | "cards") => {
      if (!channelId || !dialogNpcId) return;
      setPanelBadges((prev) => (prev ? { ...prev, [tab]: 0 } : prev));
      void fetch(
        `/api/channels/${encodeURIComponent(channelId)}/npcs/${encodeURIComponent(dialogNpcId)}/panel-reads`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tab }),
        },
      ).catch(() => {
        // If recording fails, the badge comes back on the next read — let it pass quietly.
      });
    },
    [channelId, dialogNpcId],
  );

  /**
   * Artifact events (`artifact:event`) — fold only this channel's into the modal state (the last event is for reflecting
   * deletes and new versions), and add a "결과물 저장됨" chip if it was saved in the open NPC conversation.
   */
  useEffect(() => {
    if (!socket || !channelId) return;
    const onArtifactEvent = (data: ArtifactSocketEvent) => {
      if (data?.channelId && data.channelId !== channelId) return;
      dispatchArtifactsModal({
        type: "event",
        kind: data?.event?.kind,
        artifactId: data?.event?.payload?.artifact_id,
      });
      const openNpcId = dialogNpcRef.current?.npcId;
      if (!openNpcId || !data?.event) return;
      const openProfile = rosterNpcsRef.current.find((npc) => npc.id === openNpcId)?.profile
        ?.profileName;
      setNpcArtifactChips((prev) => nextArtifactChips(prev, data, openProfile));
    };
    socket.on("artifact:event", onArtifactEvent);
    return () => {
      socket.off("artifact:event", onArtifactEvent);
    };
  }, [socket, channelId]);

  /**
   * `npc:working` (R27) — arrives only when the value changes, plus one snapshot on connect. Cleared when the channel
   * changes: the snapshot arrives again for the new channel, so the old channel's display does not linger.
   */
  useEffect(() => {
    setNpcWorking(EMPTY_NPC_WORKING);
    if (!socket || !channelId) return;
    const onWorking = (raw: unknown) => {
      const payload = parseNpcWorkingPayload(raw);
      if (!payload) return;
      setNpcWorking((prev) => reduceNpcWorking(prev, payload));
    };
    socket.on("npc:working", onWorking);
    return () => {
      socket.off("npc:working", onWorking);
    };
  }, [socket, channelId]);

  // Reread the acknowledgment record from the browser. If none, an empty record — on a first visit report everything accumulated.
  // Old string watermarks are read too (`parseReportAck`).
  useEffect(() => {
    if (!channelId) return;
    try {
      setReportAck(parseReportAck(window.localStorage.getItem(reportAckKey(channelId))));
    } catch {
      setReportAck(EMPTY_REPORT_ACK);
    }
  }, [channelId]);

  /** Acknowledge **only this one** report — other employees' reports ahead of it stay. */
  const acknowledgeReports = useCallback(
    (item: ReportItem) => {
      setReportAck((prev) => {
        const next = acknowledgeReport(prev, item.messageId);
        lastReportAckAtRef.current = Date.now();
        if (channelId)
          try {
            window.localStorage.setItem(reportAckKey(channelId), serializeReportAck(next));
          } catch {
            // Even if blocked by privacy mode etc., it stays in state for this session.
          }
        return next;
      });
    },
    [channelId],
  );

  const reportQueue = useMemo(
    () =>
      reportsForChannel({
        rooms: roomState.rooms,
        messages: roomState.messages,
        npcs: rosterNpcs,
        acknowledged: reportAck,
      }),
    [roomState.rooms, roomState.messages, rosterNpcs, reportAck],
  );

  // Room notice links (R29, R30) → open the matching modal at that item.
  //
  // `showKanbanRef` is updated in an effect, so calling this after **closing the board in the same tick** still
  // reads `true` and goes to `focusRequest` — if the modal unmounts meanwhile the target is lost.
  // The current callers (room notices, card tab, `openArtifactSource`) never close the board
  // (the kanban branch is `closeKanban: false` — `artifact-entry.ts:145`), so that path does not exist.
  // To add a caller that closes and opens, change this to take `boardOpen` as an argument.
  const openNoticeCard = useCallback(
    (cardId: string) => {
      setKanbanCard((prev) =>
        openCardTarget({ boardOpen: showKanbanRef.current, taskId: cardId, prev }),
      );
      setShowKanban(true);
      // The user has seen that card's reports — acknowledge only **that card's** reports.
      // Empty ids are not matched so reports without a `cardId` (cron failures) do not mix in.
      if (cardId)
        for (const item of reportQueue) if (item.cardId === cardId) acknowledgeReports(item);
    },
    [reportQueue, acknowledgeReports],
  );
  /**
   * Report calls — **fired by this browser, not the server.** `npc:call` determines `targetPlayerId`
   * from the socket, so automation events have no one to walk to. If nobody is connected it is right
   * that the move is skipped and only the notice stays in the room.
   *
   * If the dialog, kanban or cron modal is open, do not interrupt — the queue stays and continues when they close.
   */
  const reportSignatures = useMemo(() => {
    const snapshot = npcMotionSnapshotRef.current;
    const out: Record<string, string> = {};
    for (const npc of rosterNpcs) {
      const motion = npcMotionUi(snapshot, npc.id, npcMoveStates[npc.id], npcCallers[npc.id]);
      const entry = snapshot?.npcs.find((candidate) => candidate.npcId === npc.id);
      const atHome = !entry || Math.hypot(entry.x - entry.homeX, entry.y - entry.homeY) <= 2;
      out[npc.id] = npcSignature(motion.phase, motion.caller, socket?.id, atHome);
    }
    return out;
  }, [rosterNpcs, npcMoveStates, npcCallers, socket?.id]);

  useEffect(() => {
    if (!socket || !channelId) return;
    // If someone took the employee who was coming on my call (a meeting, etc.), settle that "sent" as refused — otherwise
    // they are never called again until the report is acknowledged.
    // Folded reports become candidates again when another report is acknowledged or after about 10 minutes.
    const revived = reviveDismissedReports(
      reportAttemptsRef.current,
      Date.now(),
      lastReportAckAtRef.current,
    );
    if (revived !== reportAttemptsRef.current) {
      reportAttemptsRef.current = revived;
      setReportAttemptsVersion((v) => v + 1);
    }
    returningNpcsRef.current = settleReturningNpcs(returningNpcsRef.current, reportSignatures);
    reportAttemptsRef.current = reconcileReportAttempts(
      reportAttemptsRef.current,
      reportSignatures,
      reportQueue,
    );
    // If the report being delivered turned into a refusal (auto return, meeting, etc.), do not hold it — on the next render
    // pick again by the chronological rule.
    if (activeReportReleased(reportAttemptsRef.current, reportingMessageId)) {
      setReportingMessageId(null);
      return;
    }
    const blocked = reportCallBlocked({
      dialogOpen: Boolean(dialogNpc),
      kanbanOpen: showKanban,
      cronOpen: showCron,
      inMeeting: mode === "meeting",
    });
    // If an employee who missed the arrival signal is waiting beside me, open the dialog instead (same as the arrival handler).
    const missed = missedReportArrival({
      queue: reportQueue,
      activeMessageId: reportingMessageId,
      attempts: reportAttemptsRef.current,
      signatures: reportSignatures,
      blocked,
    });
    if (missed) {
      reportAttemptsRef.current = reportAttemptsRef.current.map((a) =>
        a.messageId === missed.messageId ? { ...a, opened: true } : a,
      );
      const nextDialogNpc = { npcId: missed.npcId, npcName: missed.npcName };
      setDialogReport(missed);
      dialogNpcRef.current = nextDialogNpc;
      setDialogNpc(nextDialogNpc);
      EventBus.emit("dialog:open");
      EventBus.emit("npc:bubble-clear", { npcId: missed.npcId });
      socket.emit("npc:history", { npcId: missed.npcId });
      return;
    }
    const next = decideReportCall({
      queue: reportQueue,
      activeMessageId: reportingMessageId,
      attempts: reportAttemptsRef.current,
      signatures: reportSignatures,
      blocked,
      returningNpcIds: returningNpcsRef.current,
    });
    if (!next) return;
    const signature = reportSignatures[next.npcId] ?? "unknown:none";
    const record = (outcome: ReportAttempt["outcome"]) => {
      reportAttemptsRef.current = [
        ...reportAttemptsRef.current.filter((a) => a.messageId !== next.messageId).slice(-49),
        { messageId: next.messageId, outcome, signature },
      ];
      setReportAttemptsVersion((v) => v + 1);
    };
    record("sent");
    setReportingMessageId(next.messageId);
    socket.emit("npc:call", { channelId, npcId: next.npcId }, (result: unknown) => {
      // Refusals (in a meeting, occupied by another user) pass quietly **for the user** — the notice and badge
      // remain, and a toast saying they could not walk over gives the user nothing to do. But the trace
      // must not be erased: this line used to be missing so nobody could see the refusal code,
      // and the cause of "the employee does not come" had to be narrowed down by reasoning over code alone.
      if (!isNpcCallRejected(result)) return;
      console.debug("[report] npc:call rejected", {
        npcId: next.npcId,
        messageId: next.messageId,
        signature,
        error: (result as { error?: unknown })?.error,
      });
      // Record the refusal. When that employee's state changes, `decideReportCall` brings them back as a candidate.
      record("rejected");
      setReportingMessageId(null);
    });
  }, [
    socket,
    channelId,
    reportQueue,
    reportingMessageId,
    reportSignatures,
    reportAttemptsVersion,
    reportClock,
    dialogNpc,
    showKanban,
    showCron,
    mode,
  ]);

  const reportingItem = useMemo(
    () => reportQueue.find((item) => item.messageId === reportingMessageId) ?? null,
    [reportQueue, reportingMessageId],
  );
  // The arrival handler lives in an effect registered once at mount, so it reads through a ref.
  const reportingItemRef = useRef<ReportItem | null>(null);
  useEffect(() => {
    reportingItemRef.current = reportingItem;
  }, [reportingItem]);

  // Closing the dialog with an employee who came to report, without acknowledging, folds that report for this session and moves on
  // to the next report. Otherwise the attempt stays "sent" and the whole queue stalls.
  const reportDialogNpcRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = reportDialogNpcRef.current;
    const current = dialogNpc?.npcId ?? null;
    reportDialogNpcRef.current = current;
    if (!prev || prev === current) return;
    setDialogReport(null);
    if (!reportingItem || prev !== reportingItem.npcId) return;
    reportAttemptsRef.current = dismissReport(
      reportAttemptsRef.current,
      reportingItem.messageId,
      Date.now(),
    );
    setReportAttemptsVersion((v) => v + 1);
    setReportingMessageId(null);
  }, [dialogNpc, reportingItem]);

  // The "folded" marker in the report list. The attempt log is a ref, so bump a version when it changes to reread.
  const dismissedReports = useMemo(
    () => dismissedReportIds(reportAttemptsRef.current),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the version signals ref changes instead
    [reportAttemptsVersion],
  );

  const reportAttemptsDiagnostics = useMemo(
    () =>
      reportAttemptsRef.current
        .map((a) => `${a.messageId}:${a.outcome}${a.signature ? `@${a.signature}` : ""}`)
        .join(" "),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the version signals ref changes instead
    [reportAttemptsVersion],
  );

  /** "다시 부르기" — immediately returns a folded report to candidacy. The blocking rules stay as they are. */
  const recallDismissedReport = useCallback((item: ReportItem) => {
    reportAttemptsRef.current = recallReport(reportAttemptsRef.current, item.messageId);
    setReportAttemptsVersion((v) => v + 1);
  }, []);

  // Run the clock only while there are folded reports, to judge revival by elapsed time.
  useEffect(() => {
    if (dismissedReports.size === 0) return;
    const timer = window.setInterval(() => setReportClock((c) => c + 1), 30_000);
    return () => window.clearInterval(timer);
  }, [dismissedReports]);

  // When a report leaves the queue (acknowledged), hand the slot to the next report.
  useEffect(() => {
    if (reportingMessageId && !reportingItem) setReportingMessageId(null);
  }, [reportingMessageId, reportingItem]);

  const openNoticeCronJob = useCallback(
    (jobId: string) => {
      setCronInitialJobId(jobId);
      setShowCron(true);
      // Cron failure reports are closed here too — otherwise the badge would stay forever.
      for (const item of reportQueue) if (item.jobId === jobId) acknowledgeReports(item);
    },
    [reportQueue, acknowledgeReports],
  );
  /** The report list's "열기" — open that card/history and acknowledge **only that one report**. */
  const openReport = useCallback(
    (item: ReportItem) => {
      const target = reportTarget(item);
      if (target?.kind === "cron") {
        setCronInitialJobId(target.jobId);
        setShowCron(true);
      } else if (target?.kind === "card") {
        setKanbanCard((prev) =>
          openCardTarget({ boardOpen: showKanbanRef.current, taskId: target.cardId, prev }),
        );
        setShowKanban(true);
      }
      acknowledgeReports(item);
    },
    [acknowledgeReports],
  );
  const closeKanban = useCallback(() => {
    setChatTaskDraft(null);
    setShowKanban(false);
    setKanbanCard(null);
  }, []);
  const closeCron = useCallback(() => {
    setShowCron(false);
    setCronInitialJobId(null);
  }, []);
  /** Open the artifacts modal — expand a specific artifact or filter to a card's artifacts (Task 11's entry point). */
  const openArtifacts = useCallback((initial?: { artifactId?: string; taskId?: string }) => {
    dispatchArtifactsModal({ type: "open", initial });
  }, []);
  const closeArtifacts = useCallback(() => {
    dispatchArtifactsModal({ type: "close" });
  }, []);
  const openArtifact = useCallback(
    (artifactId: string) => openArtifacts({ artifactId }),
    [openArtifacts],
  );
  // The kanban card's artifacts section. The artifacts modal floats above kanban (kanban is not closed — while covered
  // kanban ignores Escape, `covered`). The api object is recreated only when the channel changes, and events
  // are passed separately as `artifactsRefreshTick` so the drawer rereads with a debounce.
  const kanbanArtifacts = useMemo<TaskDrawerArtifacts | null>(() => {
    if (!channelId) return null;
    const api = createArtifactsApi(channelId);
    return {
      list: (taskId) => api.list({ taskId }).then((page) => page.artifacts),
      open: openArtifact,
    };
  }, [channelId, openArtifact]);
  /** "출처로 이동" — close the artifacts modal and any modal covering the destination, and open that card, conversation or cron job. */
  const openArtifactSource = useCallback(
    (target: SourceTarget) => {
      const plan = planSourceNavigation(
        target,
        rosterNpcs.map((n) => ({ id: n.id, name: n.name, profileName: n.profile?.profileName })),
      );
      // If the channel has no NPC for that profile (fired, etc.) there is nowhere to go, so leave the modal as is.
      if (!plan) return;
      closeArtifacts();
      if (plan.closeKanban) closeKanban();
      if (plan.closeCron) closeCron();
      const { open } = plan;
      if (open.type === "chat") handleSelectNpc(open.npcId, open.npcName);
      else if (open.type === "kanban") openNoticeCard(open.taskId);
      else if (open.jobId) openNoticeCronJob(open.jobId);
      else setShowCron(true);
    },
    [
      rosterNpcs,
      closeArtifacts,
      closeKanban,
      closeCron,
      handleSelectNpc,
      openNoticeCard,
      openNoticeCronJob,
    ],
  );

  // Spawn set mode coordination
  useEffect(() => {
    if (spawnSetMode) {
      EventBus.emit("spawn-set-mode-start");
    }
    const onSpawnSelected = async (data: { col: number; row: number }) => {
      if (!channelId) return;
      try {
        const existingConfig =
          typeof channel?.mapConfig === "string"
            ? JSON.parse(channel.mapConfig as string)
            : channel?.mapConfig || {};
        await fetch(`/api/channels/${channelId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mapConfig: { ...existingConfig, spawnCol: data.col, spawnRow: data.row },
          }),
        });
        setChannel((prev) =>
          prev
            ? {
                ...prev,
                mapConfig: {
                  ...(typeof prev.mapConfig === "object"
                    ? (prev.mapConfig as Record<string, unknown>)
                    : {}),
                  spawnCol: data.col,
                  spawnRow: data.row,
                },
              }
            : prev,
        );
        showToastNotification(
          "spawn-set",
          t("game.spawnSetSuccess", { col: data.col, row: data.row }),
        );
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

  // NPC context menu handlers
  const handleCallNpc = useCallback(() => {
    if (!contextMenu) return;
    handleCallNpcById(contextMenu.npcId);
  }, [contextMenu, handleCallNpcById]);

  const handleContextTalk = useCallback(() => {
    if (!contextMenu) return;
    handleTalkNpcById(contextMenu.npcId, contextMenu.npcName);
  }, [contextMenu, handleTalkNpcById]);

  const handleContextInviteToRoom = useCallback(() => {
    if (!contextMenu) return;
    const currentRoom = roomState.rooms.find((room) => room.id === roomState.currentRoomId);
    const decision = decideContextInvite({
      visible: channelChatVisible,
      currentRoom,
      npcId: contextMenu.npcId,
    });
    if (decision.kind === "invite") {
      handleRoomInvite(decision.roomId, [contextMenu.npcId], []);
    } else if (decision.kind === "already-member") {
      showToastNotification(`room-already-member-${contextMenu.npcId}`, t("room.alreadyMember"));
    } else {
      handleRoomAction({ type: "compose", presetNpcIds: [contextMenu.npcId] });
      setChannelChatOpen(true);
    }
    setContextMenu(null);
  }, [
    contextMenu,
    roomState,
    channelChatVisible,
    handleRoomInvite,
    handleRoomAction,
    showToastNotification,
    t,
  ]);

  const handleReturnNpc = useCallback(
    (npcId: string) => {
      if (!socket?.connected) {
        showToastNotification("npc-return-disconnected", t("errors.connectionFailed"));
        return;
      }
      socket
        .timeout(3000)
        .emit(
          "npc:return-home",
          { channelId, npcId },
          (error: Error | null, result?: { ok: boolean; error?: string }) => {
            // If the return is refused the employee does not go back — clear the returning marker so they can be called again.
            if (error || !result?.ok)
              returningNpcsRef.current = withoutNpc(returningNpcsRef.current, npcId);
            if (error || !result?.ok)
              showToastNotification(
                `npc-return-${npcId}`,
                t(
                  error
                    ? "errors.connectionFailed"
                    : result?.error === "not_owner" || result?.error === "forbidden"
                      ? "errors.forbidden"
                      : "errors.notFound",
                ),
              );
          },
        );
      mapChatParticipantsRef.current.dismiss(npcId);
      // Exclude them from report call candidates until they reach their seat (`settleReturningNpcs` clears it on confirmed arrival).
      returningNpcsRef.current = new Set([...returningNpcsRef.current, npcId]);
      // Sending back an employee who came to report = treat that report as received (Dante's decision, 2026-09-21).
      // Otherwise the moment they reach home they are called back for the same report. The room notice stays.
      const report = reportingItemRef.current;
      if (report && report.npcId === npcId) {
        acknowledgeReports(report);
        setReportingMessageId(null);
      }
      setContextMenu(null);
      closeRosterMenus();
    },
    [socket, channelId, closeRosterMenus, showToastNotification, t, acknowledgeReports],
  );

  // ESC key to close context menu
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (contextMenu) setContextMenu(null);
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
      <div className="min-h-screen flex items-center justify-center bg-bg text-text">
        <div className="text-center">
          <div className="text-xl mb-2">{t("common.loadingGame")}</div>
          <div className="text-text-muted">{t("common.preparingCharacter")}</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg text-text">
        <div className="text-center">
          <div className="text-xl mb-4 text-danger">{error}</div>
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

  const dialogMotion = npcMotionUi(
    npcMotionSnapshotRef.current,
    dialogNpc?.npcId,
    dialogNpc ? npcMoveStates[dialogNpc.npcId] : undefined,
    dialogNpc ? npcCallers[dialogNpc.npcId] : undefined,
  );

  const npcResponsePhases = npcPresentationPhases(chatResponses);
  // NPC candidates for the cron screen — only active ones from the roster, names are profile display names (the roster already has them).
  const cronNpcs = rosterNpcs
    .filter((npc) => npc.active)
    .map((npc) => ({ npcId: npc.id, npcName: npc.name }));
  // The NPC filter for the artifacts modal — the same roster as cron but sleeping NPCs are included too (matches the server list scope).
  const artifactNpcs = rosterNpcs.flatMap((npc) =>
    npc.profile?.profileName
      ? [{ npcId: npc.id, npcName: npc.name, profileName: npc.profile.profileName }]
      : [],
  );
  const navigatorNpcs: NavigatorNpc[] = rosterNpcs.map((npc) => {
    const motion = npcMotionUi(
      npcMotionSnapshotRef.current,
      npc.id,
      npcMoveStates[npc.id],
      npcCallers[npc.id],
    );
    return {
      ...npc,
      motion: navigatorMotion({ active: npc.active, placed: npc.placed, phase: motion.phase }),
      response: npcResponsePhases[npc.id],
      calledByViewer: motion.caller === socket?.id,
    };
  });

  // DM lines to draw in the list. The roster is the source of truth for names and clock-in status, and lines for employees not on the roster are dropped.
  const dmThreadEntries = buildDmThreadEntries(
    dmThreads,
    rosterNpcs.map((npc) => ({ id: npc.id, name: npc.name, active: npc.active })),
  );

  const handleNavigatorNpcAction = (npcId: string, action: NpcNavigatorAction) => {
    if (action === "call") handleCallNpcById(npcId);
    else if (action === "return") handleReturnNpc(npcId);
    else if (action === "place") handleMoveNpcById(npcId);
    else if (action === "profile") openProfileSettings();
    else if (action === "reset-chat") handleResetNpcChatById(npcId);
    else if (action === "sleep") handleSleepNpcById(npcId);
    else if (action === "wake") setNpcActiveById(npcId, true);
  };

  const activeConversationRoom = roomState.rooms.find(
    (room) => room.id === roomState.currentRoomId,
  );
  const conversationLabel = dialogNpc
    ? `${dialogNpc.npcName} ${t("chat.title")}`
    : roomState.view === "compose"
      ? t("room.new")
      : activeConversationRoom?.kind === "office"
        ? t("room.office")
        : (activeConversationRoom?.name ?? t("room.list"));

  const conversationPanel = (
    <ConversationPane label={conversationLabel}>
      <ChatPanel
        presentation="workspace"
        approvalSocket={socket}
        width={conversationPanelWidth}
        onWidthChange={setConversationPanelWidth}
        dialogNpc={dialogNpc}
        npcMessages={npcMessages}
        npcActivityKey={npcActivityKey}
        isNpcStreaming={isNpcStreaming}
        npcResponses={responsesForScope(chatResponses, "npc", dialogNpc?.npcId ?? null)}
        roomResponses={responsesForScope(chatResponses, "room", currentRoomId)}
        npcChatInputDisabled={!socketConnected}
        npcChatDisabledPlaceholder={t("chat.disconnected")}
        onSend={handleDialogSend}
        onClose={handleDialogClose}
        npcSelectList={npcSelectList}
        onSelectNpc={handleSelectNpc}
        isOwner={isOwner}
        onEditNpc={handleMoveNpcById}
        onFireNpc={handleSleepNpcById}
        onResetNpcChat={handleResetNpcChatById}
        roomState={roomState}
        channelChatOpen={channelChatOpen}
        channelChatInputDisabled={channelChatInputDisabled || !socketConnected}
        onChannelChatVisibleChange={setChannelChatVisible}
        mentionCandidatesFor={mentionCandidatesFor}
        onlinePlayers={channelPlayers.flatMap((player) => {
          const userId = player.id === "__self__" ? roomState.viewerUserId : player.userId;
          return userId ? [{ id: userId, name: player.name }] : [];
        })}
        onRoomSend={handleRoomSend}
        onRoomAction={handleRoomAction}
        onRoomCreate={handleRoomCreate}
        onRoomInvite={handleRoomInvite}
        onRoomLeave={handleRoomLeave}
        onRoomRename={handleRoomRename}
        onRoomDelete={handleRoomDelete}
        currentPlayerName={character?.name}
        avatarFor={avatarFor}
        npcMoveState={dialogMotion.phase}
        onReturnNpc={dialogNpc && dialogMotion.caller === socket?.id ? handleReturnNpc : undefined}
        dialogReport={dialogReport}
        cron={channelId ? { channelId, socket, onToast: cronToast } : null}
        onOpenNoticeCard={openNoticeCard}
        onOpenNoticeCronJob={openNoticeCronJob}
        onOpenNoticeApproval={() => setShowAttention(true)}
        onOpenNoticeMinutes={setNoticeMinutesId}
        badges={panelBadges}
        onMarkSeen={markPanelTabSeen}
        cardsRefreshTick={kanbanRefreshTick}
        onOpenAssignedCard={openNoticeCard}
        onOpenSkillManager={(npcId, skillName) =>
          setSkillManagerNpc({
            npcId,
            skillName: skillName ?? null,
            npcName:
              rosterNpcs.find((npc) => npc.id === npcId)?.name ??
              (dialogNpc?.npcId === npcId ? dialogNpc.npcName : ""),
          })
        }
        onOpenConnectorManager={(npcId, server) =>
          setConnectorManagerNpc({
            npcId,
            server,
            npcName:
              rosterNpcs.find((npc) => npc.id === npcId)?.name ??
              (dialogNpc?.npcId === npcId ? dialogNpc.npcName : ""),
          })
        }
        onOpenApprovalPolicy={(npcId) =>
          setApprovalPolicyNpc({
            npcId,
            npcName:
              rosterNpcs.find((npc) => npc.id === npcId)?.name ??
              (dialogNpc?.npcId === npcId ? dialogNpc.npcName : ""),
          })
        }
        onCreateTaskFromChat={(draft) => {
          if (!channelId) return;
          setChatTaskDraft({ ...draft, channelId, seq: Date.now() });
          setKanbanCard(null);
          setShowKanban(true);
        }}
        npcArtifactChips={npcArtifactChips}
        onOpenArtifact={openArtifact}
      />
    </ConversationPane>
  );

  const page = (
    <div
      data-game-meeting={mode === "meeting"}
      className="theme-game ui2-game h-screen w-screen overflow-hidden bg-bg text-text"
    >
      <SocketConnectionNotice socket={socket} />
      <ConversationWorkspace
        conversationWidth={conversationPanelWidth}
        navigator={
          <WorkspaceNavigator
            workspaceName={channel?.name || "DeskRPG"}
            rooms={roomState.rooms}
            currentRoomId={dialogNpc ? null : roomState.currentRoomId}
            dmThreads={dmThreadEntries}
            onSelectDm={handleSelectNpc}
            players={channelPlayers.map((player) => ({
              id: player.id,
              name: player.name,
              online: true,
              self: player.id === "__self__",
              appearance: player.appearance,
            }))}
            npcs={navigatorNpcs}
            selectedNpcId={dialogNpc?.npcId}
            isOwner={isOwner}
            onSelectRoom={(roomId) => {
              if (dialogNpc) handleDialogClose();
              handleRoomAction({ type: "open", roomId });
              setChannelChatOpen(true);
            }}
            onSelectNpc={handleTalkNpcById}
            onSelectPlayer={() => handleOpenPlayerChat()}
            onCompose={(presetNpcIds) => {
              if (dialogNpc) handleDialogClose();
              handleRoomAction({ type: "compose", presetNpcIds });
              setChannelChatOpen(true);
            }}
            onNpcAction={handleNavigatorNpcAction}
            onInvitePeople={() => setShowSharePopup(true)}
            onEditSelf={handleEditCharacter}
            onSetStartPosition={isOwner ? handleStartPositionSetting : undefined}
            onAddNpc={isOwner ? handleHireNpc : undefined}
            addNpcDisabled={!gatewayId}
          />
        }
        conversation={conversationPanel}
      >
        {/* Game canvas remains mounted while the meeting workspace is visible. */}
        <div>
          {character && gameChannelData && (
            <ThreeGame
              socket={socket}
              characterId={character.id}
              characterName={character.name}
              appearance={character.appearance}
              channelInitData={gameChannelData}
              onFatal={handleGameFatal}
            />
          )}
        </div>
      </ConversationWorkspace>

      {/* Spawn set mode banner */}
      {spawnSetMode && (
        <div
          style={{ top: "var(--game-header-height, 48px)" }}
          className="fixed left-1/2 -translate-x-1/2 z-20 flex items-center gap-3 px-4 py-2 bg-primary/95 border border-primary-light rounded-lg text-white text-sm shadow-lg"
        >
          <Footprints className="w-4 h-4 text-white" />
          <span>{t("game.spawnSetMode")}</span>
          <button
            onClick={() => {
              setSpawnSetMode(false);
              EventBus.emit("spawn-set-mode-end");
            }}
            className="ml-2 px-2 py-0.5 bg-primary-hover hover:bg-primary-light rounded text-xs"
          >
            {t("common.closeEsc")}
          </button>
        </div>
      )}

      {/* Top bar — floating over game */}
      <div className="fixed top-0 left-0 right-0 z-10 px-4 py-2 ui2-game-header">
        <style jsx>{`
          .ui2-game-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            height: var(--game-header-height, 48px);
          }
          .ui2-game-header h1 {
            min-width: 0;
            max-width: none;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }
          .header-controls {
            display: flex;
            flex-shrink: 0;
            align-items: center;
            gap: 6px;
          }
          .header-controls :global(button) {
            white-space: nowrap;
          }
          .header-mobile-label {
            display: none;
          }
          @media (max-width: 1000px) {
            .ui2-game-header {
              display: grid;
              grid-template-columns: minmax(0, 1fr);
              grid-template-rows: 24px 36px;
              gap: 4px;
              height: var(--game-header-height, 48px);
              min-height: var(--game-header-height, 48px);
              padding: 8px;
            }
            .ui2-game-header h1 {
              font-size: 13px;
              line-height: 24px;
            }
            .header-controls {
              min-width: 0;
              width: 100%;
              justify-content: space-between;
              gap: 4px;
            }
            .header-controls > button,
            .header-controls > div > button,
            .header-controls > div > div:first-child > button {
              height: 36px;
              flex-shrink: 0;
              padding: 0 8px;
              gap: 5px;
            }
            .header-full-label,
            .header-separator {
              display: none;
            }
            .header-mobile-label {
              display: inline;
            }
            .header-roster-buttons {
              gap: 4px;
            }
            .header-controls :global(svg) {
              flex-shrink: 0;
            }
            .header-menu {
              position: fixed;
              top: calc(var(--game-header-height, 48px) + 4px);
              right: 8px;
              left: auto;
              max-width: calc(100vw - 16px);
              max-height: calc(100dvh - var(--game-header-height, 48px) - 20px);
              overflow-y: auto;
              margin-top: 0;
            }
            .header-roster-menu {
              position: fixed;
              top: calc(var(--game-header-height, 48px) + 4px);
              left: 8px;
              right: 8px;
              width: auto;
              max-height: calc(100dvh - var(--game-header-height, 48px) - 20px);
              margin-top: 0;
              overflow-y: auto;
            }
          }
          @media (max-width: 360px) {
            .header-controls > button,
            .header-controls > div > button,
            .header-controls > div > div:first-child > button {
              padding: 0 5px;
              gap: 3px;
            }
          }
        `}</style>
        {/* Left: Channel name — Character name */}
        <h1
          className="text-lg font-bold"
          title={`${channel?.name || "DeskRPG"} — ${character?.name || ""}`}
        >
          {channel?.name || "DeskRPG"} &mdash; {character?.name}
        </h1>

        {/* Right: grouped controls */}
        <div className="header-controls">
          {/* Gateway status */}
          {channel?.hasGateway ? (
            <button
              onClick={() => openChannelSettings("gateway")}
              title={t(channel?.hasGateway ? "game.aiGateway" : "game.gatewayConnect")}
              aria-label={t(channel?.hasGateway ? "game.aiGateway" : "game.gatewayConnect")}
              className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-sky-500/10 border border-sky-400/20 text-caption text-sky-700 hover:bg-sky-500/20"
            >
              <span className="w-2 h-2 rounded-full bg-sky-300" />
              <span className="header-full-label">{t("game.aiGateway")}</span>
              <span className="header-mobile-label" aria-hidden="true">
                AI
              </span>
            </button>
          ) : (
            <button
              onClick={() => openChannelSettings("gateway")}
              title={t(channel?.hasGateway ? "game.aiGateway" : "game.gatewayConnect")}
              aria-label={t(channel?.hasGateway ? "game.aiGateway" : "game.gatewayConnect")}
              className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-amber-500/10 border border-amber-400/20 text-caption text-amber-700 hover:bg-amber-500/20"
            >
              <span className="w-2 h-2 rounded-full bg-amber-300" />
              <span className="header-full-label">{t("game.gatewayConnect")}</span>
              <span className="header-mobile-label" aria-hidden="true">
                AI +
              </span>
            </button>
          )}

          {/* Counts remain in the header; the full roster now lives in the workspace navigator. */}
          <div
            className="header-roster-buttons flex items-center gap-1.5"
            aria-label={t("workspace.people")}
          >
            <span className="flex items-center gap-1.5 rounded-md border border-border bg-surface-raised px-2.5 py-1 text-caption text-text-secondary">
              <span className="h-2 w-2 rounded-full bg-sky-400" />
              <span className="header-full-label">
                {t("game.playersOnlineCount", { count: channelPlayers.length })}
              </span>
              <span className="header-mobile-label" aria-hidden="true">
                {channelPlayers.length}
              </span>
            </span>
            <span className="flex items-center gap-1.5 rounded-md border border-border bg-surface-raised px-2.5 py-1 text-caption text-text-secondary">
              <span className="h-2 w-2 rounded-full bg-violet-400" />
              <span className="header-full-label">
                {t("game.npcsAtWorkCount", {
                  count: rosterNpcs.filter((npc) => npc.active).length,
                })}
              </span>
              <span className="header-mobile-label" aria-hidden="true">
                NPC {rosterNpcs.filter((npc) => npc.active).length}
              </span>
            </span>
            {/* Report queue diagnostics — defects in this queue show only on screen and console.debug is not
                captured by automation tools. Measurements read the state from the DOM (values are ids and states only, no content). */}
            <span
              hidden
              data-testid="report-diagnostics"
              data-active={reportingMessageId ?? ""}
              data-attempts={reportAttemptsDiagnostics}
              data-returning={[...returningNpcsRef.current].join(",")}
            />
            <ReportBadge
              queue={reportQueue}
              current={reportingItem}
              dismissedIds={dismissedReports}
              onOpen={openReport}
              onRecall={recallDismissedReport}
            />
          </div>

          <button
            type="button"
            data-testid="attention-entry"
            onClick={() => setShowAttention(true)}
            title={t("attention.title")}
            aria-label={t("attention.title")}
            className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-caption font-semibold text-text-secondary hover:bg-surface-raised"
          >
            <span className="header-full-label">{t("attention.title")}</span>
            <span className="header-mobile-label" aria-hidden="true">
              !
            </span>
          </button>

          {/* Enter the meeting room — hidden on the meeting screen. The leave button is on the map (ThreeGame). */}
          {mode === "office" && (
            <button
              data-meeting-entry="navbar"
              onClick={() => meetingEntry.request()}
              title={t("game.meetingRoomWithMinutes", { count: meetingMinutesCount })}
              aria-label={t("game.meetingRoom")}
              className="flex items-center gap-1 px-2.5 py-1 rounded-md text-caption font-semibold bg-meeting/80 hover:bg-meeting text-white"
            >
              <Users className="w-3 h-3" />
              <span className="header-full-label">{t("game.meetingRoom")}</span>
              <span className="bg-white/20 px-1.5 rounded-full text-micro">
                {meetingMinutesCount}
              </span>
            </button>
          )}

          {/* Kanban board (T8) — where the old task board button was */}
          <button
            onClick={() => setShowKanban(true)}
            title={t("kanban.title")}
            aria-label={t("kanban.title")}
            className="flex items-center gap-1 px-2.5 py-1 bg-primary/80 hover:bg-primary text-white rounded-md text-caption font-semibold"
          >
            <KanbanSquare className="w-3 h-3" />
            <span className="header-full-label">{t("kanban.open")}</span>
          </button>

          {/* Channel cron screen (T10, R15) */}
          <button
            onClick={() => setShowCron(true)}
            title={t("cron.title")}
            aria-label={t("cron.title")}
            className="flex items-center gap-1 px-2.5 py-1 bg-primary/80 hover:bg-primary text-white rounded-md text-caption font-semibold"
          >
            <AlarmClock className="w-3 h-3" />
            <span className="header-full-label">{t("cron.open")}</span>
          </button>

          {/* Channel artifacts */}
          <button
            onClick={() => openArtifacts()}
            title={t("artifacts.title")}
            aria-label={t("artifacts.title")}
            className="flex items-center gap-1 px-2.5 py-1 bg-primary/80 hover:bg-primary text-white rounded-md text-caption font-semibold"
          >
            <Package className="w-3 h-3" />
            <span className="header-full-label">{t("artifacts.open")}</span>
          </button>

          <GrowthStarButton
            stars={appMeta.stars}
            clicked={appMeta.starClicked}
            onClick={appMeta.markStarClicked}
          />

          {/* Separator */}
          <div className="header-separator w-px h-5 bg-border" />

          {/* Unified menu dropdown */}
          <div className="relative">
            <button
              onClick={() => {
                setShowUserMenu(!showUserMenu);
                setShowSharePopup(false);
              }}
              title={t("game.menuSettings")}
              aria-label={t("game.menuSettings")}
              aria-expanded={showUserMenu}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-surface-raised border border-border text-caption text-text-secondary hover:text-text hover:bg-surface relative"
            >
              <Settings className="w-3.5 h-3.5" />
              <span className="header-full-label">{t("game.menuSettings")}</span>
              {(notifications.some((n) => !n.read) || appMeta.hasUpdate) && (
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-danger rounded-full" />
              )}
              <ChevronDown className="header-full-label w-3 h-3" />
            </button>
            {showUserMenu && (
              <div className="header-menu absolute right-0 top-full mt-1 bg-surface border border-border rounded-lg shadow-xl w-56 z-50 py-1">
                {isOwner && (
                  <button
                    onClick={() => {
                      openChannelSettings("settings");
                      setShowUserMenu(false);
                    }}
                    className="w-full text-left px-4 py-2 text-body text-text-secondary hover:bg-surface-raised hover:text-text flex items-center gap-2"
                  >
                    <Settings className="w-3.5 h-3.5" />
                    {t("game.settings")}
                  </button>
                )}
                {/* View settings are for everyone — a personal setting that applies only to this browser. */}
                <button
                  data-menu-item="view-settings"
                  onClick={() => {
                    setShowViewSettings(true);
                    setShowUserMenu(false);
                  }}
                  className="w-full text-left px-4 py-2 text-body text-text-secondary hover:bg-surface-raised hover:text-text flex items-center gap-2"
                >
                  <Eye className="w-3.5 h-3.5" />
                  {t("viewSettings.menu")}
                </button>

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
                            onClick={() =>
                              setNotifications((prev) => prev.map((n) => ({ ...n, read: true })))
                            }
                            className="text-micro text-primary-light hover:text-primary"
                          >
                            {t("game.markAllRead")}
                          </button>
                        </div>
                      )}
                      {notifications.length === 0 ? (
                        <div className="text-caption text-text-dim py-2 text-center">
                          {t("game.noNotifications")}
                        </div>
                      ) : (
                        <div className="max-h-40 overflow-y-auto -mx-1 px-1">
                          {notifications.slice(0, 5).map((n) => (
                            <div
                              key={n.id}
                              className={`py-1.5 text-caption ${n.read ? "text-text-dim" : "text-text-secondary"}`}
                            >
                              <div className="truncate">{n.message}</div>
                              <div className="text-micro text-text-dim">
                                {new Date(n.timestamp).toLocaleTimeString()}
                              </div>
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
                      <option key={l.code} value={l.code}>
                        {l.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="border-t border-border my-1" />
                <button
                  onClick={() => {
                    setShowUserMenu(false);
                    setShowBugReport(true);
                  }}
                  className="w-full text-left px-4 py-2 text-body text-text-secondary hover:bg-surface-raised hover:text-text flex items-center gap-2"
                >
                  <Bug className="w-3.5 h-3.5" />
                  {t("game.reportBug")}
                </button>
                {appMeta.updateAvailable && appMeta.latestVersion && (
                  <button
                    onClick={() => {
                      setShowUserMenu(false);
                      setShowUpdateNotice(true);
                    }}
                    className="w-full text-left px-4 py-2 text-body text-text-secondary hover:bg-surface-raised hover:text-text flex items-center gap-2"
                  >
                    <ArrowUpCircle className="w-3.5 h-3.5" />
                    {t("growth.newVersion", { version: `v${appMeta.latestVersion}` })}
                    {appMeta.hasUpdate && (
                      <span className="ml-auto w-2 h-2 bg-danger rounded-full" />
                    )}
                  </button>
                )}

                {/* Exit section */}
                <div className="border-t border-border my-1" />
                <button
                  onClick={async () => {
                    setShowUserMenu(false);
                    // Save position via API before leaving (socket disconnect may not fire)
                    try {
                      const channelId = new URLSearchParams(window.location.search).get(
                        "channelId",
                      );
                      if (channelId && socketRef.current) {
                        // Ask the simulation for the position through the EventBus
                        const pos = await new Promise<{ x: number; y: number } | null>(
                          (resolve) => {
                            let resolved = false;
                            const handler = (data: { x: number; y: number }) => {
                              resolved = true;
                              EventBus.off("player-position-response", handler);
                              resolve(data);
                            };
                            EventBus.on("player-position-response", handler);
                            EventBus.emit("request-player-position");
                            setTimeout(() => {
                              if (!resolved) {
                                EventBus.off("player-position-response", handler);
                                resolve(null);
                              }
                            }, 200);
                          },
                        );
                        if (pos) {
                          await fetch(`/api/channels/${channelId}/save-position`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ x: Math.round(pos.x), y: Math.round(pos.y) }),
                          }).catch(() => {});
                        }
                      }
                    } catch {
                      /* best effort */
                    }
                    window.location.href = "/channels";
                  }}
                  className="w-full text-left px-4 py-2 text-body text-text-secondary hover:bg-surface-raised hover:text-text flex items-center gap-2"
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
                  className="w-full text-left px-4 py-2 text-body text-text-secondary hover:bg-surface-raised hover:text-text flex items-center gap-2"
                >
                  <Info className="w-3.5 h-3.5" />
                  {t("game.aboutDeskRpg")}
                </button>
              </div>
            )}
          </div>

          {/* Share popup (positioned independently) */}
          {showSharePopup && channel?.inviteCode && (
            <div
              style={{ top: "calc(var(--game-header-height, 48px) + 4px)" }}
              className="header-menu fixed right-4 bg-surface border border-border rounded-lg p-3 shadow-xl w-72 z-50"
            >
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs text-text-muted">{t("game.inviteLink")}</p>
                <button
                  onClick={() => setShowSharePopup(false)}
                  className="text-text-dim hover:text-text-secondary text-xs"
                >
                  {t("common.close")}
                </button>
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
                {t("game.inviteCodeLabel")}{" "}
                <span className="text-text-secondary font-mono">{channel.inviteCode}</span>
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Click outside to close dropdowns */}
      {showUserMenu && (
        <div className="fixed inset-0 z-[9]" onClick={() => setShowUserMenu(false)} />
      )}

      {showBugReport && (
        <BugReportModal feedbackUrl={appMeta.feedbackUrl} onClose={() => setShowBugReport(false)} />
      )}

      {surveyPrompt.survey && appMeta.feedbackUrl && (
        <SurveyModal
          survey={surveyPrompt.survey}
          locale={locale}
          feedbackUrl={appMeta.feedbackUrl}
          consentNeeded={surveyPrompt.consentNeeded}
          onDone={surveyPrompt.finish}
        />
      )}

      {showUpdateNotice && appMeta.latestVersion && (
        <UpdateNoticeModal
          version={appMeta.version}
          latestVersion={appMeta.latestVersion}
          onSeen={appMeta.markUpdateSeen}
          onClose={() => setShowUpdateNotice(false)}
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

      {showAttention && channelId && (
        <Modal open onClose={() => setShowAttention(false)} title={t("attention.title")} size="lg">
          <Modal.Body>
            <AttentionInboxPanel
              channelId={channelId}
              onOpenCard={(taskId) => {
                setShowAttention(false);
                openNoticeCard(taskId);
              }}
              onOpenCronJob={(jobId) => {
                setShowAttention(false);
                openNoticeCronJob(jobId);
              }}
              onOpenApprovalPolicy={(npcId) => {
                setShowAttention(false);
                setApprovalPolicyNpc({
                  npcId,
                  npcName: rosterNpcs.find((npc) => npc.id === npcId)?.name ?? "",
                });
              }}
            />
          </Modal.Body>
        </Modal>
      )}
      {noticeMinutesId && channelId && (
        <MinutesModal
          channelId={channelId}
          npcs={rosterNpcs.map((npc) => ({ id: npc.id, name: npc.name }))}
          initialMinutesId={noticeMinutesId}
          onClose={() => setNoticeMinutesId(null)}
        />
      )}
      {showKanban && channelId && (
        <KanbanBoardModal
          key={`${channelId}:${chatTaskDraft?.seq ?? "board"}`}
          initialCreateDraft={chatTaskDraft?.channelId === channelId ? chatTaskDraft : undefined}
          channelId={channelId}
          refreshTick={kanbanRefreshTick}
          initialTaskId={kanbanCard?.initialTaskId ?? null}
          focusRequest={kanbanCard?.focusRequest ?? null}
          artifacts={kanbanArtifacts}
          artifactsRefreshTick={artifactsModal.eventSeq}
          covered={artifactsModal.show}
          onClose={closeKanban}
          onConnectGateway={
            isOwner
              ? () => {
                  returnToKanbanRef.current = true;
                  setShowKanban(false);
                  openChannelSettings("gateway");
                }
              : undefined
          }
        />
      )}

      {showCron && channelId && (
        <CronModal
          channelId={channelId}
          npcs={cronNpcs}
          socket={socket}
          onToast={cronToast}
          initialJobId={cronInitialJobId}
          onClose={closeCron}
        />
      )}

      {artifactsModal.show && channelId && (
        <ArtifactsModal
          channelId={channelId}
          npcs={artifactNpcs}
          refreshTick={artifactsModal.refreshTick}
          lastEvent={artifactsModal.lastEvent}
          initialArtifactId={artifactsModal.initial?.artifactId ?? null}
          initialTaskId={artifactsModal.initial?.taskId ?? null}
          onOpenSource={openArtifactSource}
          onClose={closeArtifacts}
        />
      )}

      {skillManagerNpc && channelId && (
        <SkillManagerModal
          channelId={channelId}
          npcId={skillManagerNpc.npcId}
          npcName={skillManagerNpc.npcName}
          initialSkill={skillManagerNpc.skillName}
          onClose={() => setSkillManagerNpc(null)}
        />
      )}

      {connectorManagerNpc && channelId && (
        <ConnectorManagerModal
          channelId={channelId}
          npcId={connectorManagerNpc.npcId}
          npcName={connectorManagerNpc.npcName}
          initialServer={connectorManagerNpc.server}
          copyTargets={rosterNpcs
            .filter((npc) => npc.active && npc.id !== connectorManagerNpc.npcId)
            .map((npc) => ({ npcId: npc.id, name: npc.name }))}
          onClose={() => setConnectorManagerNpc(null)}
        />
      )}

      {approvalPolicyNpc && channelId && (
        <ApprovalPolicyModal
          channelId={channelId}
          npcId={approvalPolicyNpc.npcId}
          npcName={approvalPolicyNpc.npcName}
          onClose={() => setApprovalPolicyNpc(null)}
        />
      )}

      {showPasswordModal && channelId && (
        <PasswordModal
          channelName={channel?.name || t("channels.privateChannel")}
          onSubmit={handleGamePasswordSubmit}
          onClose={() => router.push("/channels")}
        />
      )}

      {showViewSettings && <ViewSettingsModal onClose={() => setShowViewSettings(false)} />}
      {showChannelSettings && channel && (
        <ChannelSettingsModal
          channelId={channel.id}
          channelName={channel.name}
          channelDescription={channel.description}
          isPublic={channel.isPublic}
          inviteCode={channel.inviteCode}
          motionConfig={channel.motionConfig}
          initialTab={channelSettingsInitialTab}
          onClose={() => {
            setShowChannelSettings(false);
            if (returnToKanbanRef.current) {
              returnToKanbanRef.current = false;
              setShowKanban(true);
            }
          }}
          onUpdated={(data) => {
            if (data.gatewayConfig) void refreshNpcLists();
            if (
              returnToKanbanRef.current &&
              (data.gatewayConfig?.gatewayId || data.gatewayConfig?.url)
            ) {
              returnToKanbanRef.current = false;
              setShowChannelSettings(false);
              setShowKanban(true);
            }
            setChannel((prev) => {
              if (!prev) return prev;
              return {
                ...prev,
                ...data,
                hasGateway: data.gatewayConfig
                  ? Boolean(
                      (typeof data.gatewayConfig.gatewayId === "string" &&
                        data.gatewayConfig.gatewayId.trim()) ||
                      (typeof data.gatewayConfig.url === "string" &&
                        data.gatewayConfig.url.trim()) ||
                      prev.gatewayConfig?.gatewayId ||
                      prev.gatewayConfig?.url,
                    )
                  : prev.hasGateway,
                gatewayConfig: data.gatewayConfig
                  ? { ...(prev.gatewayConfig || {}), ...data.gatewayConfig }
                  : prev.gatewayConfig,
              };
            });
          }}
        />
      )}

      {/* Placement mode indicator */}
      {placementMode && (
        <div
          style={{ top: "calc(var(--game-header-height, 48px) + 16px)" }}
          className="fixed left-1/2 -translate-x-1/2 z-50 bg-primary text-white px-4 py-2 rounded-lg shadow-lg text-body font-medium"
        >
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
                <div className="text-center text-caption text-text-muted px-3 py-1 mb-1">
                  {t("game.whoToTalkTo")}
                </div>
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
                    <span
                      className={`w-2 h-2 rounded-full ${target.type === "npc" ? "bg-npc" : "bg-info"}`}
                    />
                    {target.name}
                    <span className="text-caption text-text-dim ml-auto">
                      {target.type === "npc" ? t("game.typeNpc") : t("game.typePlayer")}
                    </span>
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
        </>
      )}

      {/* NPC Context Menu */}
      {contextMenu &&
        (() => {
          const currentMoveState = npcMoveStates[contextMenu.npcId] || contextMenu.moveState;
          const isCaller = npcCallers[contextMenu.npcId] === socket?.id;
          return (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setContextMenu(null)} />
              <div className="fixed z-50" style={{ left: contextMenu.x, top: contextMenu.y }}>
                <div className="bg-surface border border-border rounded-lg shadow-xl py-1 min-w-[140px]">
                  {currentMoveState === "idle" && (
                    <button
                      onClick={handleCallNpc}
                      className="w-full text-left px-3 py-2 text-body text-npc hover:bg-surface-raised"
                    >
                      <PhoneCall className="w-3.5 h-3.5 inline mr-1" />
                      {t("context.call")}
                    </button>
                  )}
                  {currentMoveState === "waiting" && isCaller && (
                    <button
                      onClick={() => {
                        handleReturnNpc(contextMenu.npcId);
                        setContextMenu(null);
                      }}
                      className="w-full text-left px-3 py-2 text-body text-npc hover:bg-surface-raised"
                    >
                      <Undo2 className="w-3.5 h-3.5 inline mr-1" />
                      {t("context.return")}
                    </button>
                  )}
                  {currentMoveState === "waiting" && !isCaller && (
                    <button
                      disabled
                      className="w-full text-left px-3 py-2 text-body text-text-dim cursor-not-allowed"
                    >
                      <Clock className="w-3.5 h-3.5 inline mr-1" />
                      {t("context.calledByOther")}
                    </button>
                  )}
                  {currentMoveState !== "idle" && currentMoveState !== "waiting" && (
                    <button
                      disabled
                      className="w-full text-left px-3 py-2 text-body text-text-dim cursor-not-allowed"
                    >
                      <Footprints className="w-3.5 h-3.5 inline mr-1" />
                      {t("npc.moving")}
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
                    <MessageSquare className="w-3.5 h-3.5 inline mr-1" />
                    {t("context.talk")}
                  </button>
                  <button
                    onClick={handleContextInviteToRoom}
                    className="w-full text-left px-3 py-2 text-body text-text hover:bg-surface-raised"
                  >
                    <Users className="w-3.5 h-3.5 inline mr-1" />
                    {t("npc.inviteToRoom")}
                  </button>
                  {isOwner && (
                    <>
                      <button
                        onClick={() => handleMoveNpcById(contextMenu.npcId)}
                        className="w-full text-left px-3 py-2 text-body text-text hover:bg-surface-raised"
                      >
                        <Footprints className="w-3.5 h-3.5 inline mr-1" />
                        {t("npc.move")}
                      </button>
                      <button
                        onClick={openProfileSettings}
                        disabled={!gatewayId}
                        title={!gatewayId ? t("game.roster.needsGateway") : undefined}
                        className="w-full text-left px-3 py-2 text-body text-text hover:bg-surface-raised disabled:text-text-dim disabled:cursor-not-allowed"
                      >
                        <Pencil className="w-3.5 h-3.5 inline mr-1" />
                        {t("npc.profileSettings")}
                      </button>
                    </>
                  )}
                  <button
                    onClick={() => handleResetNpcChatById(contextMenu.npcId)}
                    className="w-full text-left px-3 py-2 text-body text-text hover:bg-surface-raised"
                  >
                    <RotateCcw className="w-3.5 h-3.5 inline mr-1" />
                    {t("context.resetChat")}
                  </button>
                  {isOwner && (
                    <button
                      onClick={() => handleSleepNpcById(contextMenu.npcId)}
                      className="w-full text-left px-3 py-2 text-body text-danger hover:bg-surface-raised"
                    >
                      <UserMinus className="w-3.5 h-3.5 inline mr-1" />
                      {t("npc.sleep")}
                    </button>
                  )}
                </div>
              </div>
            </>
          );
        })()}

      {(meetingEntry.state.status === "walking" || meetingEntry.state.status === "failed") && (
        <div
          data-meeting-entry-status={meetingEntry.state.status}
          role="status"
          className="fixed bottom-20 left-1/2 -translate-x-1/2 z-40 rounded bg-surface p-3 text-text shadow-lg"
        >
          <p>
            {meetingEntry.state.status === "walking"
              ? t("meeting.entryWalking")
              : t("meeting.entryFailed", {
                  reason:
                    t(`meeting.reason.${meetingEntry.state.reasonCode ?? "unknown"}`) ===
                    `meeting.reason.${meetingEntry.state.reasonCode ?? "unknown"}`
                      ? (meetingEntry.state.reasonCode ?? t("common.unknown"))
                      : t(`meeting.reason.${meetingEntry.state.reasonCode}`),
                })}
          </p>
          {meetingEntry.state.status === "failed" && (
            <button type="button" onClick={meetingEntry.request}>
              {t("common.retry")}
            </button>
          )}
          <button type="button" onClick={meetingEntry.cancel}>
            {t("common.cancel")}
          </button>
        </div>
      )}
      {mode === "meeting" && character && (
        <MeetingWorkspace
          channelId={channelId!}
          character={{
            id: character.id,
            name: character.name,
            appearance: character.appearance,
          }}
          socket={socket}
          npcs={channelNpcs}
          onLeave={meetingEntry.cancel}
        />
      )}
    </div>
  );
  // Approval cards outlive whichever chat is shown — see ToolApprovalsProvider.
  return <ToolApprovalsProvider socket={socket}>{page}</ToolApprovalsProvider>;
}
