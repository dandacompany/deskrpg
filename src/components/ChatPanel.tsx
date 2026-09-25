"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import type { ReportItem } from "@/game/report-queue";
import DialogReportSummary from "./chat/DialogReportSummary";
import { Pencil, UserMinus, RotateCcw, Undo2 } from "lucide-react";
import type { NpcChatMessage } from "./NpcDialog";
import ChatInput from "./ChatInput";
import type { ChatTaskDraft } from "./kanban/kanban-view-model";
import ChatBubble from "./ui/ChatBubble";
import RosterAvatar from "./RosterAvatar";
import RoomList from "./rooms/RoomList";
import RoomHeader from "./rooms/RoomHeader";
import RoomComposer from "./rooms/RoomComposer";
import SystemMessage from "./rooms/SystemMessage";
import { candidatesForInvite } from "./rooms/compose-candidates";
import type { RoomAction, RoomState } from "@/app/game/room-state";
import type { ChatResponse } from "@/lib/chat-response";
import type { RoomMessage } from "@/lib/chat-rooms-policy";
import type { AvatarLookup } from "@/app/game/avatar-lookup";
import {
  isActiveChatResponse,
  responsesForSource,
  visibleResponseReplies,
} from "@/app/game/chat-response-state";
import ResponseProgress from "./chat/ResponseProgress";
import { ConversationSessionStore } from "@/app/game/conversation-session";
import CronPanel, { type CronEventSource } from "./cron/CronPanel";
import RoomNoticeMessage from "./chat/RoomNoticeMessage";
import NpcCardsTab from "./chat/NpcCardsTab";
import NpcConnectorsTab from "./connectors/NpcConnectorsTab";
import NpcSkillsTab from "./skills/NpcSkillsTab";
import { tabFor, type NpcPanelTab, type NpcTabState } from "./chat/npc-tab-state";
import { createKanbanApi, KanbanApiError, type BoardResponse } from "./kanban/kanban-api";

/**
 * How long the cards tab coalesces bursts of `kanban:event` so it doesn't reread the board
 * once per event. Matches the kanban modal's `KANBAN_EVENT_DEBOUNCE_MS` — both listen to the
 * same event stream. Kept here to avoid pulling in that module (the modal is a heavy client component).
 */
const CARDS_EVENT_DEBOUNCE_MS = 400;

/** What the NPC chat's cron tab (T9) needs. Passed in by the wiring (GamePageClient) — without it, there's no tab. */
/** Unread count for an employee chat tab (`GET .../panel-reads`). */
export type PanelBadgeCounts = { cards: number; cron: number };

export type ChatPanelCronContext = {
  channelId: string;
  socket?: CronEventSource | null;
  onToast?: (message: string) => void;
};

interface ChatPanelProps {
  /** Overlay keeps the legacy floating panel; workspace embeds it in the right column. */
  presentation?: "overlay" | "workspace";
  width?: number;
  onWidthChange?: (width: number) => void;
  dialogNpc: { npcId: string; npcName: string } | null;
  npcMessages: NpcChatMessage[];
  /** Translation key describing what the NPC is doing right now. When absent, nothing is shown. */
  npcActivityKey?: string | null;
  isNpcStreaming: boolean;
  npcResponses?: ChatResponse[];
  roomResponses?: ChatResponse[];
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
  /** The report, when this dialog belongs to the employee who came to report. Shows a summary at the top. */
  dialogReport?: ReportItem | null;
  // Channel chat — per room. Three screens: the list, inside a room, and new room/invite.
  roomState: RoomState;
  channelChatOpen?: boolean;
  channelChatInputDisabled?: boolean;
  onRoomSend: (message: string) => void;
  onRoomAction: (action: RoomAction) => void;
  onRoomCreate: (name: string, npcIds: string[], userIds: string[]) => void;
  onRoomInvite: (roomId: string, npcIds: string[], userIds: string[]) => void;
  onRoomLeave: (roomId: string) => void;
  onRoomRename: (roomId: string, name: string) => void;
  onRoomDelete: (roomId: string) => void;
  /** NPCs that can be `@`-mentioned — differs by room (office is everyone clocked in, group is its members). */
  mentionCandidatesFor: (roomId: string | null) => { id: string; name: string }[];
  /** People currently online — candidates for the new room/invite screen. */
  onlinePlayers: { id: string; name: string }[];
  /** Whether the inside-a-room screen (panel open, not DM/select list) is visible — the map's NPC waiting rule reads this. */
  onChannelChatVisibleChange?: (visible: boolean) => void;
  currentPlayerName?: string;
  /** Attaches a "cron" tab to an NPC DM — only that NPC's (R15). Without it, only chat shows. */
  cron?: ChatPanelCronContext | null;
  /** "Open card" from a room notice (R29) — opens the kanban modal to that card. Without it, there's no link. */
  onOpenNoticeCard?: (cardId: string, boardSlug: string) => void;
  /** Unread count per tab. 0 means no badge is drawn. Without it, there's no badge. */
  badges?: PanelBadgeCounts | null;
  /** The cron/cards tab was selected — the wiring records the view (`POST .../panel-reads`). */
  onMarkSeen?: (tab: "cron" | "cards") => void;
  /** "Open management" in the skills tab — opens that employee's skill management modal. Without it, the button does nothing. */
  onOpenSkillManager?: (npcId: string, skillName?: string) => void;
  /** "Manage" in the connectors tab — opens that employee's connector manager, optionally on one server. */
  onOpenConnectorManager?: (npcId: string, serverName?: string) => void;
  /** Opens an NPC's unattended run policy modal (from the [Connectors] tab, owner only). */
  onOpenApprovalPolicy?: (npcId: string) => void;
  /** A card was clicked in the cards tab — points kanban at that card. Without it, it can't be clicked. */
  onOpenAssignedCard?: (taskId: string) => void;
  onCreateTaskFromChat?: (draft: ChatTaskDraft) => void;
  /**
   * A value that rises on every `kanban:event` (the wiring's `kanbanRefreshTick`). The board
   * is reread only while the cards tab is open — this prop's whole job is to let the badge and
   * the list share the same trigger.
   */
  cardsRefreshTick?: number;
  /** Debounce (ms) from event to refetch. Same value as the kanban modal (shortened in tests). */
  cardsDebounceMs?: number;
  /** "Open history" from a room notice (R30) — opens the channel cron screen to that job. Without it, there's no link. */
  onOpenNoticeCronJob?: (jobId: string) => void;
  /** "Open approval" from an approval-request notice — opens the judgment queue. Without it, there's no button. */
  onOpenNoticeApproval?: (approvalId: string) => void;
  /** "Register as project" from a meeting-result notice — opens those minutes. Without it, there's no button. */
  onOpenNoticeMinutes?: (minutesId: string) => void;
  /** Artifacts the NPC saved in this conversation — drawn as chips under the last reply. */
  npcArtifactChips?: Array<{ artifactId: string; title: string }>;
  /** Clicking an artifact chip opens the artifact modal to that artifact. Without it, there's no chip. */
  onOpenArtifact?: (artifactId: string) => void;
  /**
   * Looks up a speaker's appearance — used for the round avatar in bubbles and the header. Takes
   * a lookup function instead of carrying the appearance on every message (it's already in the
   * channel roster). Returns `null` on a miss (default display). Without it, no avatar is drawn.
   */
  avatarFor?: AvatarLookup;
}

/**
 * Is this the same speaker as the immediately preceding message — checked so avatar/name
 * aren't repeated. A notice or system message breaks the flow, so the bubble after it gets an avatar again.
 */
function sameSpeaker(previous: RoomMessage | undefined, current: RoomMessage): boolean {
  if (!previous || previous.notice || previous.senderKind === "system") return false;
  if (previous.senderKind !== current.senderKind) return false;
  return previous.senderId && current.senderId
    ? previous.senderId === current.senderId
    : previous.senderName === current.senderName;
}

const MIN_WIDTH = 250;
const MAX_WIDTH = 600;
const DEFAULT_WIDTH = 320;

/** Is a modal layer floating above the chat panel? */
function modalLayerOpen(): boolean {
  return document.querySelector('[aria-modal="true"], [data-modal-overlay]') !== null;
}

export default function ChatPanel({
  presentation = "overlay",
  width: controlledWidth,
  onWidthChange,
  dialogNpc,
  npcMessages,
  npcActivityKey = null,
  isNpcStreaming,
  npcResponses = [],
  roomResponses = [],
  npcChatInputDisabled,
  npcChatDisabledPlaceholder,
  onSend,
  onClose,
  npcSelectList,
  onSelectNpc,
  isOwner,
  onEditNpc,
  onFireNpc,
  onResetNpcChat,
  roomState,
  channelChatOpen,
  channelChatInputDisabled,
  onRoomSend,
  onRoomAction,
  onRoomCreate,
  onRoomInvite,
  onRoomLeave,
  onRoomRename,
  onRoomDelete,
  mentionCandidatesFor,
  onlinePlayers,
  onChannelChatVisibleChange,
  currentPlayerName,
  npcMoveState,
  onReturnNpc,
  dialogReport,
  cron = null,
  onOpenNoticeCard,
  onOpenNoticeCronJob,
  onOpenNoticeApproval,
  onOpenNoticeMinutes,
  badges = null,
  onMarkSeen,
  onOpenAssignedCard,
  onOpenSkillManager,
  onOpenConnectorManager,
  onOpenApprovalPolicy,
  onCreateTaskFromChat,
  cardsRefreshTick = 0,
  cardsDebounceMs = CARDS_EVENT_DEBOUNCE_MS,
  npcArtifactChips = [],
  onOpenArtifact,
  avatarFor,
}: ChatPanelProps) {
  const [internalWidth, setInternalWidth] = useState(DEFAULT_WIDTH);
  // The NPC DM's tab — remembers which NPC the selection is for too, and returns to the chat tab
  // when the NPC changes (derived during render, not reset via an effect).
  const [npcTabState, setNpcTabState] = useState<NpcTabState>({ npcId: null, tab: "chat" });
  const dialogNpcId = dialogNpc?.npcId ?? null;
  const npcTab = tabFor(npcTabState, dialogNpcId);
  const setNpcTab = (tab: NpcPanelTab) => {
    setNpcTabState({ npcId: dialogNpcId, tab });
    if (tab === "cron" || tab === "cards") onMarkSeen?.(tab);
  };
  // The cards tab's board — read when the tab opens and when `kanban:event` arrives. On failure,
  // **the server's code must be carried through as-is** so `NpcCardsTab` can pick the right 428/409/503
  // guidance (never wrapped or rewritten). The fetch key travels with the result, so switching
  // employees/channels discards the stale result during render (not reset via an effect —
  // no other person's cards are ever visible for a single frame).
  const [cardsFetch, setCardsFetch] = useState<{
    key: string;
    board: BoardResponse | null;
    error: string | null;
  } | null>(null);
  const cardsChannelId = cron?.channelId ?? null;
  const cardsKey =
    npcTab === "cards" && cardsChannelId && dialogNpcId ? `${cardsChannelId}:${dialogNpcId}` : null;
  // A generation number so a late response can't overwrite a newer fetch's result. Once debounced
  // refetches exist, fetches can overlap, and a local `alive` flag inside the effect isn't enough.
  const cardsRequestRef = useRef(0);
  const loadCards = useCallback(() => {
    if (!cardsKey || !cardsChannelId) return;
    const seq = ++cardsRequestRef.current;
    createKanbanApi(cardsChannelId)
      .board(false)
      .then((board) => {
        if (seq === cardsRequestRef.current) setCardsFetch({ key: cardsKey, board, error: null });
      })
      .catch((err: unknown) => {
        if (seq !== cardsRequestRef.current) return;
        setCardsFetch({
          key: cardsKey,
          board: null,
          error: err instanceof KanbanApiError ? err.code : "unknown_error",
        });
      });
  }, [cardsKey, cardsChannelId]);
  useEffect(() => {
    loadCards();
    return () => {
      // Discard an in-flight fetch's result when the employee/channel changes.
      cardsRequestRef.current += 1;
    };
  }, [loadCards]);
  /**
   * Reread the list on `kanban:event` — eliminates the state where only the badge rises while
   * the list goes stale.
   *
   * **Must react to "the tick rose," not "the tick is nonzero."** `kanbanRefreshTick` only ever
   * rises during a session, so opening the tab after an event has already passed makes the initial
   * fetch above and this timer overlap and read the board twice — even though no new event happened
   * in between. This fetch reads the Hermes board on the server, so it's doubly expensive per tab open.
   * So it carries the last-applied tick and takes the value at the moment the tab opened as the
   * baseline (opening = up to date).
   *
   * Runs **only while the tab is open** — what actually blocks the fetch is `loadCards`'s `cardsKey`
   * check; the same condition is repeated here just so no timer is set on a closed tab. The fetch
   * key stays the same, so the previous list remains visible during a refetch — the cards tab's
   * invariant of never treating an unsettled state as an empty list (`6b2fb198`) is preserved here too.
   */
  const cardsAppliedRef = useRef<{ key: string | null; tick: number }>({
    key: null,
    tick: cardsRefreshTick,
  });
  useEffect(() => {
    if (!cardsKey) {
      // The tab closed — discard the baseline. Keeping it would read as "the tick rose in between"
      // when the same employee's tab reopens, causing one extra fetch on top of the open-time fetch.
      cardsAppliedRef.current = { key: null, tick: cardsRefreshTick };
      return;
    }
    if (cardsAppliedRef.current.key !== cardsKey) {
      // The tab opened or the employee changed — the effect above just fetched, so only align the baseline here.
      cardsAppliedRef.current = { key: cardsKey, tick: cardsRefreshTick };
      return;
    }
    if (cardsAppliedRef.current.tick === cardsRefreshTick) return;
    const timer = setTimeout(() => {
      cardsAppliedRef.current = { key: cardsKey, tick: cardsRefreshTick };
      loadCards();
    }, cardsDebounceMs);
    return () => clearTimeout(timer);
  }, [cardsRefreshTick, cardsDebounceMs, cardsKey, loadCards]);
  const cardsLoaded = cardsFetch?.key === cardsKey ? cardsFetch : null;
  const cardsBoard = cardsLoaded?.board ?? null;
  const cardsError = cardsLoaded?.error ?? null;
  const cardsNpcProfile =
    cardsBoard?.npcs.find((npc) => npc.npcId === dialogNpcId)?.profileName ?? "";
  const width = controlledWidth ?? internalWidth;
  const setWidth = useCallback(
    (next: number) => {
      if (controlledWidth === undefined) setInternalWidth(next);
      onWidthChange?.(next);
    },
    [controlledWidth, onWidthChange],
  );
  const [manualOpen, setManualOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [showGearMenu, setShowGearMenu] = useState(false);
  const [sessions] = useState(() => new ConversationSessionStore());
  const [, setSessionRevision] = useState(0);
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const channelScrollRef = useRef<HTMLDivElement>(null);
  const conversationKey = dialogNpc
    ? `npc:${dialogNpc.npcId}`
    : roomState.view === "compose"
      ? `compose:${roomState.compose?.inviteTo ?? "new"}`
      : roomState.currentRoomId
        ? `room:${roomState.currentRoomId}`
        : "room:list";
  const conversationDraft = sessions.get(conversationKey).draft;
  const updateConversationDraft = (draft: string) => {
    sessions.setDraft(conversationKey, draft);
    setSessionRevision((revision) => revision + 1);
  };
  const isWorkspace = presentation === "workspace";
  const isOpen = isWorkspace || manualOpen || !!dialogNpc || !!npcSelectList || !!channelChatOpen;
  // The NPC only stays around "while the room is visible" — the list and new-room screens aren't a conversation.
  const channelChatVisible = isOpen && !dialogNpc && !npcSelectList && roomState.view === "room";
  useEffect(() => {
    onChannelChatVisibleChange?.(channelChatVisible);
  }, [channelChatVisible, onChannelChatVisibleChange]);

  // Auto-scroll NPC messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [npcMessages]);
  useEffect(() => {
    const container = scrollRef.current;
    if (container && container.scrollHeight - container.clientHeight - container.scrollTop <= 80) {
      container.scrollTop = container.scrollHeight;
    }
  }, [npcResponses]);

  const currentRoom = roomState.rooms.find((room) => room.id === roomState.currentRoomId) ?? null;
  // Wrapped in useMemo — if the ternary created a new array on every render, the scroll useEffect would keep firing.
  const roomMessages = useMemo(
    () => (roomState.currentRoomId ? (roomState.messages[roomState.currentRoomId] ?? []) : []),
    [roomState.currentRoomId, roomState.messages],
  );

  // ---- Card proposal resolution (T7) ---------------------------------------
  //
  // The notice's `resolved` field is the source of truth for whether the button shows, and that
  // source of truth lives on the server. But since there's no socket path that refreshes room
  // messages (no new event is added), right after success this screen overlays its remembered
  // decision on the notice for rendering — a refresh replaces it with what the server carries.
  const [proposalResolved, setProposalResolved] = useState<
    Record<string, { choice: "card" | "inline"; taskId?: string }>
  >({});
  const [proposalCalls, setProposalCalls] = useState<
    Record<string, { pending: boolean; error: string | null }>
  >({});

  const handleResolveProposal = useCallback(
    async (proposalId: string, choice: "card" | "inline") => {
      if (!cardsChannelId) return;
      setProposalCalls((prev) => ({ ...prev, [proposalId]: { pending: true, error: null } }));
      try {
        const result = await createKanbanApi(cardsChannelId).resolveProposal(proposalId, choice);
        setProposalResolved((prev) => ({
          ...prev,
          [proposalId]: { choice, ...(result.taskId ? { taskId: result.taskId } : {}) },
        }));
        setProposalCalls((prev) => ({ ...prev, [proposalId]: { pending: false, error: null } }));
        // A card that lost its assignee goes into triage — let the user know.
        if (result.assigneeDropped) cron?.onToast?.(t("notice.cardProposal.assigneeDropped"));
        // If handling it here was chosen, send a follow-up message to that employee — the existing room-send path.
        if (choice === "inline") {
          const notice = roomMessages.find(
            (message) =>
              message.notice?.kind === "card_proposal" && message.notice.proposalId === proposalId,
          )?.notice;
          const npcName = notice?.kind === "card_proposal" ? notice.npcName : "";
          onRoomSend(
            npcName
              ? `@[${npcName}] ${t("notice.cardProposal.inlineFollowUp")}`
              : t("notice.cardProposal.inlineFollowUp"),
          );
        }
      } catch (err) {
        // A failure doesn't remove the button — show the reason and let them choose again.
        setProposalCalls((prev) => ({
          ...prev,
          [proposalId]: {
            pending: false,
            error: err instanceof KanbanApiError ? err.code : "unknown_error",
          },
        }));
      }
    },
    [cardsChannelId, cron, onRoomSend, roomMessages, t],
  );

  /** Overlays this screen's remembered decision onto the notice. If the server already carries `resolved`, that wins. */
  const withLocalResolution = useCallback(
    (message: RoomMessage): RoomMessage => {
      const notice = message.notice;
      if (notice?.kind !== "card_proposal" || notice.resolved) return message;
      const local = proposalResolved[notice.proposalId];
      if (!local) return message;
      return {
        ...message,
        notice: {
          ...notice,
          // `by`/`at` aren't used on screen — the server's value is the source of truth.
          resolved: {
            choice: local.choice,
            by: "",
            at: "",
            ...(local.taskId ? { taskId: local.taskId } : {}),
          },
        },
      };
    },
    [proposalResolved],
  );

  // Auto-scroll channel messages
  useEffect(() => {
    if (channelScrollRef.current) {
      channelScrollRef.current.scrollTop = channelScrollRef.current.scrollHeight;
    }
  }, [roomMessages]);
  useEffect(() => {
    const container = channelScrollRef.current;
    if (container && container.scrollHeight - container.clientHeight - container.scrollTop <= 80) {
      container.scrollTop = container.scrollHeight;
    }
  }, [roomResponses]);

  useEffect(() => {
    const container = dialogNpc ? scrollRef.current : channelScrollRef.current;
    if (container) container.scrollTop = sessions.get(conversationKey).scrollTop;
  }, [conversationKey, dialogNpc, sessions]);

  // ESC to close NPC dialog (return to channel chat)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only the topmost layer consumes Esc. When a modal like kanban or cron is open, that modal
      // closes and the chat panel behind it stays open — it used to close both, and for a report
      // dialog that collapsed the report as "closed without confirming" (observed on staging).
      // An Esc already consumed by a layer above is not handled again here.
      if (e.defaultPrevented) return;
      if (e.key === "Escape" && dialogNpc && !modalLayerOpen()) {
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

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsDragging(true);
      const startX = e.clientX;
      const startWidth = widthRef.current;

      const handleMouseMove = (e: MouseEvent) => {
        const delta = isWorkspace ? startX - e.clientX : e.clientX - startX;
        setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + delta)));
      };

      const handleMouseUp = () => {
        setIsDragging(false);
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [isWorkspace, setWidth],
  );

  if (!isOpen && !isWorkspace) {
    return (
      <button
        onClick={() => setManualOpen(true)}
        className="fixed left-0 top-1/2 -translate-y-1/2 z-20 bg-surface/80 hover:bg-surface-raised text-text px-1 py-4 rounded-r-lg"
        title={t("chat.openChat")}
      >
        &#9654;
      </button>
    );
  }

  const inNpcDialog = !!dialogNpc;
  const inNpcSelect = !!npcSelectList && !dialogNpc;

  const composeMode: "create" | "invite" = roomState.compose?.inviteTo ? "invite" : "create";
  // The invite screen excludes people already in that room from the candidates — they could still be picked, but nothing would happen.
  const inviteCandidates = candidatesForInvite(
    roomState.rooms.find((room) => room.id === roomState.compose?.inviteTo) ?? null,
    mentionCandidatesFor(null),
    onlinePlayers.map((player) => ({ ...player, online: true })),
    roomState.viewerUserId,
  );

  /** The list is the entry point for creating a new room, even for a single office channel. */
  const backFromRoom = () => onRoomAction({ type: "showList" });
  // The list is the top-level screen — above it is "closed." Even with multiple rooms, the panel must be collapsible here.
  const backFromList = () => {
    if (!isWorkspace) setManualOpen(false);
  };

  return (
    <div
      ref={panelRef}
      data-chat-panel={presentation}
      className={
        isWorkspace
          ? "relative flex h-full min-h-0 max-w-full flex-row-reverse"
          : "fixed left-0 bottom-0 z-20 flex"
      }
      style={isWorkspace ? { width } : { width, top: "var(--game-header-height, 48px)" }}
    >
      {/* Panel content */}
      <div
        className={`flex min-w-0 flex-1 flex-col bg-bg/95 backdrop-blur ${
          isWorkspace ? "" : "border-r border-border"
        }`}
      >
        {/* Panel header — inside a room, RoomHeader takes this spot instead (so the arrow doesn't wrap to two lines). */}
        {!inNpcDialog && !inNpcSelect && roomState.view === "room" && currentRoom ? (
          <RoomHeader
            room={currentRoom}
            avatarFor={avatarFor}
            fallbackParticipants={[
              ...onlinePlayers.map((player) => ({ kind: "user" as const, ...player })),
              ...mentionCandidatesFor(currentRoom.id).map((npc) => ({
                kind: "npc" as const,
                ...npc,
              })),
            ]}
            canManage={!!roomState.viewerUserId && currentRoom.createdBy === roomState.viewerUserId}
            onBack={backFromRoom}
            onClose={() => (isWorkspace ? backFromRoom() : setManualOpen(false))}
            onInvite={() =>
              onRoomAction({ type: "compose", presetNpcIds: [], inviteTo: currentRoom.id })
            }
            onRename={(name) => onRoomRename(currentRoom.id, name)}
            onLeave={() => onRoomLeave(currentRoom.id)}
            onDelete={() => onRoomDelete(currentRoom.id)}
          />
        ) : (
          <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-surface/80">
            <button
              onClick={() => {
                if (inNpcDialog) {
                  onClose(); // Return to channel chat
                } else if (inNpcSelect) {
                  setManualOpen(false);
                } else if (roomState.view === "compose") {
                  onRoomAction({ type: "showList" });
                } else {
                  backFromList();
                }
              }}
              className="text-text-muted hover:text-text text-sm"
            >
              &#9664;
            </button>
            <span className="flex items-center gap-2 text-sm font-bold text-text-secondary">
              {inNpcDialog && avatarFor && (
                <span data-chat-header-avatar>
                  <RosterAvatar
                    appearance={avatarFor({
                      kind: "npc",
                      id: dialogNpc.npcId,
                      name: dialogNpc.npcName,
                    })}
                    size={24}
                  />
                </span>
              )}
              {inNpcDialog
                ? dialogNpc.npcName
                : inNpcSelect
                  ? t("chat.title")
                  : roomState.view === "compose"
                    ? composeMode === "invite"
                      ? t("room.invite")
                      : t("room.new")
                    : t("room.list")}
            </span>
            {inNpcDialog ? (
              <>
                {npcMoveState === "waiting" && onReturnNpc && (
                  <button
                    onClick={() => onReturnNpc(dialogNpc!.npcId)}
                    className="text-xs px-2 py-1 rounded bg-surface-raised hover:brightness-125 text-npc font-medium"
                    title={t("chat.returnNpcToOrigin")}
                  >
                    <Undo2 className="w-3.5 h-3.5 inline mr-1" />
                    {t("npc.return")}
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
                            onClick={() => {
                              setShowGearMenu(false);
                              onEditNpc?.(dialogNpc!.npcId);
                            }}
                            className="w-full text-left px-3 py-2 text-sm text-text hover:bg-surface-raised"
                          >
                            <Pencil className="w-3.5 h-3.5 inline mr-1" />
                            {t("npc.move")}
                          </button>
                          <button
                            onClick={() => {
                              setShowGearMenu(false);
                              onFireNpc?.(dialogNpc!.npcId);
                            }}
                            className="w-full text-left px-3 py-2 text-sm text-danger hover:bg-surface-raised"
                          >
                            <UserMinus className="w-3.5 h-3.5 inline mr-1" />
                            {t("npc.sleep")}
                          </button>
                        </>
                      )}
                      <button
                        onClick={() => {
                          setShowGearMenu(false);
                          onResetNpcChat?.(dialogNpc!.npcId);
                        }}
                        className="w-full text-left px-3 py-2 text-sm text-npc hover:bg-surface-raised"
                      >
                        <RotateCcw className="w-3.5 h-3.5 inline mr-1" />
                        {t("context.resetChat")}
                      </button>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="w-4" />
            )}
          </div>
        )}

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
            {cron && (
              <div
                role="tablist"
                data-testid="npc-dialog-tabs"
                className="flex border-b border-border bg-surface/60 text-xs"
              >
                {(["chat", "cron", "cards", "skills", "connectors"] as const).map((tab) => {
                  const unseen = tab === "cron" || tab === "cards" ? (badges?.[tab] ?? 0) : 0;
                  return (
                    <button
                      key={tab}
                      type="button"
                      role="tab"
                      data-tab={tab}
                      aria-selected={npcTab === tab}
                      onClick={() => setNpcTab(tab)}
                      className={`px-3 py-1.5 ${
                        npcTab === tab
                          ? "text-text border-b-2 border-primary"
                          : "text-text-muted hover:text-text"
                      }`}
                    >
                      {t(`cron.tab.${tab}`)}
                      {unseen > 0 && (
                        <span
                          data-badge={tab}
                          className="ml-1 inline-block min-w-[1.1rem] rounded-full bg-primary/20 px-1 text-center text-[10px] leading-4 text-primary"
                        >
                          {unseen}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
            {cron && npcTab === "connectors" ? (
              <div className="flex-1 min-h-0">
                <NpcConnectorsTab
                  channelId={cron.channelId}
                  npcId={dialogNpc!.npcId}
                  onOpenManager={(serverName) =>
                    onOpenConnectorManager?.(dialogNpc!.npcId, serverName)
                  }
                  onOpenPolicy={
                    onOpenApprovalPolicy ? () => onOpenApprovalPolicy(dialogNpc!.npcId) : undefined
                  }
                />
              </div>
            ) : cron && npcTab === "skills" ? (
              <div className="flex-1 min-h-0">
                <NpcSkillsTab
                  channelId={cron.channelId}
                  npcId={dialogNpc!.npcId}
                  onOpenManager={(skillName) => onOpenSkillManager?.(dialogNpc!.npcId, skillName)}
                />
              </div>
            ) : cron && npcTab === "cards" ? (
              <div className="flex-1 min-h-0">
                <NpcCardsTab
                  npcProfile={cardsNpcProfile}
                  board={cardsBoard}
                  error={cardsError}
                  onOpenCard={(taskId) => onOpenAssignedCard?.(taskId)}
                />
              </div>
            ) : cron && npcTab === "cron" ? (
              <div className="flex-1 min-h-0">
                <CronPanel
                  channelId={cron.channelId}
                  npcs={[dialogNpc!]}
                  npc={dialogNpc}
                  socket={cron.socket ?? null}
                  onToast={cron.onToast}
                />
              </div>
            ) : (
              <>
                {dialogReport && dialogReport.npcId === dialogNpc?.npcId && (
                  <DialogReportSummary
                    report={dialogReport}
                    onOpenCard={
                      onOpenNoticeCard
                        ? (cardId) => onOpenNoticeCard(cardId, dialogReport.boardSlug ?? "")
                        : undefined
                    }
                    onOpenCronJob={onOpenNoticeCronJob}
                  />
                )}
                <div
                  ref={scrollRef}
                  onScroll={(event) =>
                    sessions.setScroll(conversationKey, event.currentTarget.scrollTop)
                  }
                  className="flex-1 overflow-y-auto px-3 py-2 space-y-2"
                >
                  {npcMessages.length === 0 && (
                    <div className="text-text-dim text-sm italic py-4">
                      {t("chat.npcPlaceholder", { name: dialogNpc!.npcName })}
                    </div>
                  )}
                  {npcMessages.map((msg, i) => (
                    <div key={msg.id ?? `${msg.role}-${i}`}>
                      {msg.responseRequestId &&
                      npcResponses.some(
                        (response) => response.requestId === msg.responseRequestId,
                      ) ? (
                        <ResponseProgress
                          responses={npcResponses.filter(
                            (response) => response.requestId === msg.responseRequestId,
                          )}
                          avatarFor={avatarFor}
                        />
                      ) : (
                        <ChatBubble
                          sender={msg.role === "player" ? "player" : "npc"}
                          avatar={
                            avatarFor && dialogNpc
                              ? avatarFor({
                                  kind: "npc",
                                  id: dialogNpc.npcId,
                                  name: dialogNpc.npcName,
                                })
                              : undefined
                          }
                          continued={i > 0 && npcMessages[i - 1].role === msg.role}
                          streaming={
                            msg.role === "npc" && isNpcStreaming && i === npcMessages.length - 1
                          }
                        >
                          {msg.content}
                        </ChatBubble>
                      )}
                      {onCreateTaskFromChat &&
                        dialogNpc &&
                        msg.role === "npc" &&
                        msg.content.trim() &&
                        !msg.responseTransient &&
                        !(isNpcStreaming && i === npcMessages.length - 1) && (
                          <button
                            type="button"
                            className="text-xs text-primary underline underline-offset-2"
                            onClick={() => {
                              const response = npcResponses.find(
                                (entry) =>
                                  entry.requestId === msg.responseRequestId &&
                                  entry.npcId === dialogNpc.npcId,
                              );
                              const request = response
                                ? npcMessages.find(
                                    (entry) =>
                                      entry.role === "player" &&
                                      entry.id === response.sourceMessageId,
                                  )?.content
                                : undefined;
                              onCreateTaskFromChat({
                                title: (request || msg.content).split("\n")[0].slice(0, 140),
                                body: `${t("chat.taskSourceRequest")}\n${request ?? t("chat.taskSourceUnknown")}\n\n${t("chat.taskSourceReply", { name: dialogNpc.npcName })}\n${msg.content}`,
                                assigneeNpcId: dialogNpc.npcId,
                              });
                            }}
                          >
                            {t("chat.createTask")}
                          </button>
                        )}
                      {msg.role === "player" && (
                        <ResponseProgress
                          responses={responsesForSource(npcResponses, msg.id)}
                          receipt
                          receiptOnly
                        />
                      )}
                    </div>
                  ))}
                  {onOpenArtifact && npcArtifactChips.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {npcArtifactChips.map((chip) => (
                        <button
                          key={chip.artifactId}
                          type="button"
                          className="rounded-full bg-surface-raised px-2.5 py-1 text-[11px]"
                          onClick={() => onOpenArtifact(chip.artifactId)}
                        >
                          {t("artifacts.chip", { title: chip.title })}
                        </button>
                      ))}
                    </div>
                  )}
                  <ResponseProgress
                    responses={visibleResponseReplies(npcResponses, {
                      responseRequestIds: new Set(
                        npcMessages
                          .map((message) => message.responseRequestId)
                          .filter((id): id is string => !!id),
                      ),
                    })}
                  />
                </div>
                {/* Progress state — a separate line, not mixed into the reply body.
                    It used to stream tool.progress into chat chunks, which made the reply show up twice. */}
                {/* Doesn't also check isStreaming — that value only becomes true once **the first reply
                    chunk** arrives, but tools run before that. Observed (2026-08-28): web_search ran
                    3 times with nothing showing on screen. Having an activity key at all already means
                    "still in progress," so that alone is enough. */}
                {npcActivityKey && !npcResponses.some(isActiveChatResponse) && (
                  <div
                    className="flex items-center gap-2 px-3 pb-1 text-xs text-text-dim"
                    role="status"
                    aria-live="polite"
                  >
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                    {t(npcActivityKey)}
                  </div>
                )}
                <ChatInput
                  onSend={onSend}
                  value={conversationDraft}
                  onValueChange={updateConversationDraft}
                  placeholder={t("chat.npcPlaceholder", { name: dialogNpc!.npcName })}
                  disabled={!!npcChatInputDisabled}
                  scope="npc"
                  disabledPlaceholder={
                    npcChatInputDisabled
                      ? (npcChatDisabledPlaceholder ?? t("chat.disconnected"))
                      : t("chat.responding")
                  }
                  autoFocus
                  showFileUpload
                />
              </>
            )}
          </>
        ) : roomState.view === "list" ? (
          <RoomList
            rooms={roomState.rooms}
            currentRoomId={roomState.currentRoomId}
            onOpen={(roomId) => onRoomAction({ type: "open", roomId })}
            onNew={() => onRoomAction({ type: "compose", presetNpcIds: [] })}
          />
        ) : roomState.view === "compose" ? (
          <RoomComposer
            mode={composeMode}
            npcCandidates={inviteCandidates.npcs}
            userCandidates={inviteCandidates.users}
            presetNpcIds={roomState.compose?.presetNpcIds ?? []}
            onSubmit={({ name, npcIds, userIds }) => {
              const inviteTo = roomState.compose?.inviteTo;
              if (inviteTo) {
                onRoomInvite(inviteTo, npcIds, userIds);
                // Inviting is something someone already in that room does — return to the room, not the list.
                onRoomAction({ type: "open", roomId: inviteTo });
              } else {
                onRoomCreate(name, npcIds, userIds);
                // For a new room, navigate there once the server's `room:created` arrives.
                onRoomAction({ type: "showList" });
              }
            }}
            onCancel={() => onRoomAction({ type: "showList" })}
          />
        ) : (
          // Inside a room — messages + input
          <>
            <div
              ref={channelScrollRef}
              onScroll={(event) =>
                sessions.setScroll(conversationKey, event.currentTarget.scrollTop)
              }
              className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5"
            >
              {roomMessages.length === 0 && (
                <div className="text-text-dim text-sm italic py-4 text-center">
                  {t("room.empty")}
                </div>
              )}
              {roomMessages.map((msg, index) => {
                // A structured notice (R29/R30) is drawn by the notice renderer regardless of sender type.
                if (msg.notice) {
                  return (
                    <RoomNoticeMessage
                      key={msg.id}
                      message={withLocalResolution(msg)}
                      onOpenCard={onOpenNoticeCard}
                      onOpenCronJob={onOpenNoticeCronJob}
                      onOpenApproval={onOpenNoticeApproval}
                      onOpenMinutes={onOpenNoticeMinutes}
                      onResolveProposal={cardsChannelId ? handleResolveProposal : undefined}
                      proposalPending={
                        msg.notice?.kind === "card_proposal"
                          ? (proposalCalls[msg.notice.proposalId]?.pending ?? false)
                          : false
                      }
                      proposalError={
                        msg.notice?.kind === "card_proposal"
                          ? (proposalCalls[msg.notice.proposalId]?.error ?? null)
                          : null
                      }
                    />
                  );
                }
                if (msg.senderKind === "system") {
                  return <SystemMessage key={msg.id} content={msg.content} />;
                }
                const isMe = msg.senderKind === "user" && msg.senderName === currentPlayerName;
                return (
                  <div key={msg.id}>
                    <ChatBubble
                      sender={isMe ? "player" : "npc"}
                      name={!isMe ? msg.senderName : undefined}
                      avatar={
                        avatarFor
                          ? avatarFor({
                              kind: msg.senderKind,
                              id: msg.senderId,
                              name: msg.senderName,
                            })
                          : undefined
                      }
                      continued={sameSpeaker(roomMessages[index - 1], msg)}
                    >
                      {msg.content}
                    </ChatBubble>
                    {
                      <ResponseProgress
                        responses={responsesForSource(roomResponses, msg.id)}
                        receipt
                        receiptOnly
                      />
                    }
                  </div>
                );
              })}
              <ResponseProgress
                responses={visibleResponseReplies(roomResponses, {
                  persistedMessageIds: new Set(roomMessages.map((message) => message.id)),
                })}
              />
            </div>
            <ChatInput
              onSend={onRoomSend}
              value={conversationDraft}
              onValueChange={updateConversationDraft}
              placeholder={t("chat.placeholder")}
              disabledPlaceholder={t("chat.moveCloser")}
              disabled={!!channelChatInputDisabled}
              scope="room"
              mentionCandidates={mentionCandidatesFor(roomState.currentRoomId)}
              autoFocus
            />
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
