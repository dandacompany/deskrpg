// src/lib/adapters/openclaw-adapter.ts
// Wraps the existing OpenClawGateway as an NpcAdapter.
// The gateway instance is resolved externally (by socket-handlers)
// and passed to executeWithGateway / abortWithGateway.

import type {
  NpcAdapter,
  AdapterExecuteOptions,
  AdapterSessionInfo,
  AdapterHealthResult,
} from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Gateway = any;

export class OpenClawAdapter implements NpcAdapter {
  readonly type = "openclaw";

  async execute(_options: AdapterExecuteOptions): Promise<{
    response: string;
    session: AdapterSessionInfo;
  }> {
    throw new Error(
      "OpenClawAdapter.execute() requires a gateway instance. Use executeWithGateway() instead.",
    );
  }

  async executeWithGateway(
    gateway: Gateway,
    options: AdapterExecuteOptions,
    agentId: string,
  ): Promise<{ response: string; session: AdapterSessionInfo }> {
    const { sessionKey, prompt, onDelta, attachments } = options;

    const response = await gateway.chatSend(
      agentId,
      sessionKey,
      prompt,
      onDelta ?? (() => {}),
      attachments,
    );

    return {
      response: response || "",
      session: { sessionRef: sessionKey },
    };
  }

  async abort(_sessionKey: string): Promise<void> {
    throw new Error(
      "OpenClawAdapter.abort() requires a gateway instance. Use abortWithGateway() instead.",
    );
  }

  async abortWithGateway(
    gateway: Gateway,
    agentId: string,
    sessionKey: string,
  ): Promise<void> {
    await gateway.chatAbort(agentId, sessionKey);
  }

  async testConnection(_config: Record<string, unknown>): Promise<AdapterHealthResult> {
    return { status: "error", message: "Use /api/gateways/[id]/test for OpenClaw" };
  }
}
