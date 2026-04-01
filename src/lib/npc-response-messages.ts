type Translator = (key: string, params?: Record<string, string | number>) => string;

const NPC_RESPONSE_MESSAGE_KEYS = {
  no_agent: "npc.noAgent",
  gateway_not_connected: "npc.gatewayNotConnected",
  gateway_error: "npc.gatewayError",
  wait_before_sending: "npc.waitBeforeSending",
  npc_not_found: "npc.notFound",
} as const;

export type NpcResponseMessageCode = keyof typeof NPC_RESPONSE_MESSAGE_KEYS;

export interface NpcResponsePayload {
  npcId: string;
  chunk: string;
  done: boolean;
  messageCode?: NpcResponseMessageCode;
}

export function isNpcResponseMessageCode(value: unknown): value is NpcResponseMessageCode {
  return typeof value === "string" && value in NPC_RESPONSE_MESSAGE_KEYS;
}

export function getNpcResponseMessageKey(code: NpcResponseMessageCode): string {
  return NPC_RESPONSE_MESSAGE_KEYS[code];
}

export function resolveNpcResponseChunk(
  payload: Pick<NpcResponsePayload, "chunk" | "messageCode">,
  t: Translator,
): string {
  if (payload.messageCode && isNpcResponseMessageCode(payload.messageCode)) {
    return t(getNpcResponseMessageKey(payload.messageCode));
  }

  return payload.chunk;
}
