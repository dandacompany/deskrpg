import type { ChatResponse } from "@/lib/chat-response";
import type { NpcChatMessage } from "@/components/NpcDialog";

export type ResponseScope = "room" | "npc";

export type ChatResponseState = {
  rooms: Record<string, ChatResponse[]>;
  npcs: Record<string, ChatResponse[]>;
};

export type ChatResponseAction =
  | { type: "state"; scope: ResponseScope; scopeId: string; response: ChatResponse }
  | { type: "snapshot"; scope: ResponseScope; scopeId: string; responses: ChatResponse[] }
  | { type: "disconnect" };

export const initialChatResponseState: ChatResponseState = { rooms: {}, npcs: {} };

const isActive = (response: ChatResponse) =>
  response.status === "queued" || response.status === "thinking" || response.status === "streaming";

function keyFor(scope: ResponseScope): "rooms" | "npcs" {
  return scope === "room" ? "rooms" : "npcs";
}

const MAX_TERMINAL_PER_SCOPE = 100;

function normalize(responses: ChatResponse[]): ChatResponse[] {
  const byRequest = new Map<string, ChatResponse>();
  for (const response of responses) {
    const previous = byRequest.get(response.requestId);
    if (!previous || response.updatedAt >= previous.updatedAt)
      byRequest.set(response.requestId, response);
  }
  const unique = [...byRequest.values()];
  const terminal = unique.filter((response) => !isActive(response));
  if (terminal.length <= MAX_TERMINAL_PER_SCOPE) return unique;
  const retainedTerminal = new Set(
    terminal.slice(-MAX_TERMINAL_PER_SCOPE).map((response) => response.requestId),
  );
  return unique.filter(
    (response) => isActive(response) || retainedTerminal.has(response.requestId),
  );
}

export function reduceChatResponseState(
  state: ChatResponseState,
  action: ChatResponseAction,
): ChatResponseState {
  if (action.type === "disconnect") {
    const clearActive = (scopes: Record<string, ChatResponse[]>) =>
      Object.fromEntries(
        Object.entries(scopes).map(([id, responses]) => [
          id,
          responses.filter((item) => !isActive(item)),
        ]),
      );
    return { rooms: clearActive(state.rooms), npcs: clearActive(state.npcs) };
  }

  const key = keyFor(action.scope);
  const responses =
    action.type === "snapshot"
      ? normalize(action.responses)
      : normalize([...(state[key][action.scopeId] ?? []), action.response]);
  return { ...state, [key]: { ...state[key], [action.scopeId]: responses } };
}

export function responsesForScope(
  state: ChatResponseState,
  scope: ResponseScope,
  scopeId: string | null,
): ChatResponse[] {
  if (!scopeId) return [];
  return state[keyFor(scope)][scopeId] ?? [];
}

export function visibleResponseReplies(
  responses: ChatResponse[],
  present: { persistedMessageIds?: ReadonlySet<string>; responseRequestIds?: ReadonlySet<string> },
): ChatResponse[] {
  return responses.filter((response) => {
    if (response.messageId && present.persistedMessageIds?.has(response.messageId)) return false;
    if (present.responseRequestIds?.has(response.requestId)) return false;
    return (
      isActive(response) ||
      response.status === "failed" ||
      response.status === "cancelled" ||
      !!response.content
    );
  });
}

export function responsesForSource(
  responses: ChatResponse[],
  sourceMessageId?: string,
): ChatResponse[] {
  return sourceMessageId
    ? responses.filter((response) => response.sourceMessageId === sourceMessageId)
    : [];
}

/** Add missing tracked DM replies next to their source while preserving persisted history rows. */
export function reconcileNpcResponseMessages(
  messages: NpcChatMessage[],
  responses: ChatResponse[],
  options: { replaceTransient?: boolean } = {},
): NpcChatMessage[] {
  const snapshotIds = new Set(responses.map((response) => response.requestId));
  const next = options.replaceTransient
    ? messages.filter(
        (message) =>
          !message.responseTransient ||
          (!!message.responseRequestId && snapshotIds.has(message.responseRequestId)),
      )
    : [...messages];
  const represented = new Set(
    next.map((message) => message.responseRequestId).filter((id): id is string => !!id),
  );
  for (const response of responses) {
    if (represented.has(response.requestId)) {
      const existingIndex = next.findIndex(
        (message) => message.responseRequestId === response.requestId,
      );
      if (existingIndex >= 0 && next[existingIndex].responseTransient) {
        next[existingIndex] = {
          ...next[existingIndex],
          content: response.content,
          responseTransient: response.status !== "complete",
        };
      }
      continue;
    }
    const placeholder: NpcChatMessage = {
      id: response.requestId,
      responseRequestId: response.requestId,
      responseTransient: response.status !== "complete",
      role: "npc",
      content: response.content,
    };
    const sourceIndex = next.findIndex((message) => message.id === response.sourceMessageId);
    if (sourceIndex < 0) {
      next.push(placeholder);
    } else {
      let insertAt = sourceIndex + 1;
      while (
        insertAt < next.length &&
        next[insertAt].responseRequestId &&
        responses.some(
          (candidate) =>
            candidate.requestId === next[insertAt].responseRequestId &&
            candidate.sourceMessageId === response.sourceMessageId,
        )
      ) {
        insertAt += 1;
      }
      next.splice(insertAt, 0, placeholder);
    }
    represented.add(response.requestId);
  }
  return next;
}

export function upsertLegacyNpcChunk(
  messages: NpcChatMessage[],
  content: string,
  continuing: boolean,
): NpcChatMessage[] {
  const last = messages[messages.length - 1];
  if (continuing && last?.role === "npc") {
    const updated = [...messages];
    updated[updated.length - 1] = { ...last, content };
    return updated;
  }
  return [...messages, { role: "npc", content }];
}

export { isActive as isActiveChatResponse };

/** Latest record per request, then strongest active phase across rooms and DM. */
/**
 * Employees whose **latest** response failed. A new request replaces it as the latest, so the mark clears the
 * moment the person tries again — no separate acknowledgement to keep in sync.
 */
export function npcResponseFailures(state: ChatResponseState): Set<string> {
  const latestByNpc = new Map<string, ChatResponse>();
  for (const responses of [...Object.values(state.rooms), ...Object.values(state.npcs)])
    for (const response of responses) {
      const prior = latestByNpc.get(response.npcId);
      if (!prior || response.updatedAt >= prior.updatedAt)
        latestByNpc.set(response.npcId, response);
    }
  const failed = new Set<string>();
  for (const [npcId, response] of latestByNpc) if (response.status === "failed") failed.add(npcId);
  return failed;
}

export function npcPresentationPhases(state: ChatResponseState) {
  const latest = new Map<string, ChatResponse>();
  for (const responses of [...Object.values(state.rooms), ...Object.values(state.npcs)])
    for (const response of responses) {
      const prior = latest.get(response.requestId);
      if (!prior || response.updatedAt >= prior.updatedAt) latest.set(response.requestId, response);
    }
  const phases: Record<string, "queued" | "thinking" | "streaming"> = {};
  const priority = { queued: 1, thinking: 2, streaming: 3 };
  for (const response of latest.values()) {
    const status = response.status;
    if (status !== "queued" && status !== "thinking" && status !== "streaming") continue;
    if (!phases[response.npcId] || priority[status] > priority[phases[response.npcId]])
      phases[response.npcId] = status;
  }
  return phases;
}
