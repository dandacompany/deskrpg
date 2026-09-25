type Translator = (key: string, params?: Record<string, string | number>) => string;

const NPC_RESPONSE_MESSAGE_KEYS = {
  no_agent: "npc.noAgent",
  gateway_not_connected: "npc.gatewayNotConnected",
  /**
   * A backward-compatibility fallback. Not removed because it's a catch-all code that old
   * servers and old clients exchanged — new code uses one of the specific codes below
   * (classify-gateway-failure.ts).
   */
  gateway_error: "npc.gatewayError",
  /** Nothing answers at the gateway address — check whether the process is even up. */
  gateway_unreachable: "npc.gatewayUnreachable",
  /** The gateway responded but rejected the key — fix the key in the channel settings. */
  gateway_auth_failed: "npc.gatewayAuthFailed",
  /** Reached and authenticated, but no response came — the model/tool may have frozen. */
  gateway_timeout: "npc.gatewayTimeout",
  /** A failure that fits none of the three above. Details are in the server log. */
  gateway_unknown_error: "npc.gatewayUnknownError",
  /** The gateway ran the request but the model provider rejected the sign-in — sign in again on the gateway. */
  provider_auth_expired: "npc.providerAuthExpired",
  /** The model provider account hit its usage or rate limit. */
  provider_usage_limit: "npc.providerUsageLimit",
  /** The model provider does not serve the configured model. */
  provider_model_error: "npc.providerModelError",
  unsupported_adapter: "npc.unsupportedAdapter",
  wait_before_sending: "npc.waitBeforeSending",
  npc_not_found: "npc.notFound",
  unsupported_file_type: "npc.unsupportedFileType",
  file_too_large: "npc.fileTooLarge",
  too_many_files: "npc.tooManyFiles",
  npc_unbound: "npc.unbound",
  hermes_image_unsupported: "npc.hermesImageUnsupported",
} as const;

export type NpcResponseMessageCode = keyof typeof NPC_RESPONSE_MESSAGE_KEYS;

export interface NpcResponsePayload {
  npcId: string;
  chunk: string;
  done: boolean;
  messageCode?: NpcResponseMessageCode;
  /** Upgraded clients render this request through npc:response-state. */
  responseRequestId?: string;
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
