// src/lib/adapters/hermes-adapter.ts
// NpcAdapter over a profile-scoped HermesClient.
// Two call paths: persisted session chat (1:1) and runs + history (multi-party).
// The client is injected — this adapter knows nothing about the DB or profile
// resolution (that's getProfileClientForNpc's job), which keeps it testable
// with no gateway and no database.

import { HermesClient } from "@/lib/hermes/hermes-client";
import type { SseEvent } from "@/lib/hermes/sse";
import type {
  AdapterExecuteOptions,
  AdapterHealthResult,
  AdapterSessionInfo,
  NpcAdapter,
} from "./types";

export class HermesAdapter implements NpcAdapter {
  readonly type = "hermes";

  private readonly client: HermesClient;
  private sessionId: string | null;
  private lastRunId: string | null = null;

  constructor(client: HermesClient, opts?: { sessionId?: string }) {
    this.client = client;
    this.sessionId = opts?.sessionId ?? null;
  }

  private relay(options: AdapterExecuteOptions) {
    return (event: SseEvent) => {
      if (typeof event.data.run_id === "string" && event.data.run_id !== this.lastRunId) {
        this.lastRunId = event.data.run_id;
        options.onRunStarted?.(event.data.run_id);
      }
      // 두 엔드포인트가 델타 이벤트 이름을 달리 쓴다(실측 v0.20.2):
      //   1:1  /api/sessions/<id>/chat/stream → assistant.delta
      //   회의 /v1/runs/<id>/events          → message.delta
      // assistant.* 만 보던 탓에 회의에서는 onDelta 가 한 번도 불리지 않았다. 응답 자체는
      // execute() 의 반환값으로 왔으므로 NPC 는 멀쩡히 발언했지만, 스트리밍 청크가 없으니
      // 클라이언트의 스트림 버퍼가 비었고 done:true 를 받아도 확정할 말풍선이 없었다 —
      // 회의는 완전히 돌아가는데 화면만 비어 있었다.
      if (
        (event.event === "assistant.delta" || event.event === "message.delta") &&
        typeof event.data.delta === "string"
      ) {
        options.onDelta?.(event.data.delta);
      }
      if (event.event === "tool.progress") {
        const name = typeof event.data.tool_name === "string" ? event.data.tool_name : "";
        const preview = typeof event.data.delta === "string" ? event.data.delta : "";
        options.onToolProgress?.(name, preview);
      }
    };
  }

  async execute(options: AdapterExecuteOptions): Promise<{
    response: string;
    session: AdapterSessionInfo;
  }> {
    const onEvent = this.relay(options);

    // Runs path: the caller (ConversationEngine) owns and passes the full
    // transcript, so there is no persisted Hermes session to reuse.
    // Branch on the explicit multiParty flag, never on "is the history array non-empty":
    // polls carry no history and the first turn of a meeting has an empty transcript, and
    // both of those must still stay off the NPC's persisted session.
    if (options.multiParty) {
      const { runId } = await this.client.startRun({
        input: options.prompt,
        conversationHistory: options.conversationHistory ?? [],
        sessionKey: options.sessionKey,
      });
      this.lastRunId = runId;
      options.onRunStarted?.(runId);

      const { text } = await this.client.streamRunEvents(runId, onEvent);
      return { response: text, session: { sessionRef: options.sessionKey, displayId: runId } };
    }

    // Session path: 1:1 DM conversations reuse a persisted Hermes session,
    // creating one on first use.
    if (!this.sessionId) {
      const created = await this.client.createSession(options.sessionKey);
      this.sessionId = created.sessionId;
    }

    const result = await this.client.streamSessionChat({
      sessionId: this.sessionId,
      message: options.prompt,
      sessionKey: options.sessionKey,
      onEvent,
    });
    this.sessionId = result.sessionId;
    this.lastRunId = result.runId;

    return { response: result.text, session: { sessionRef: result.sessionId } };
  }

  async abort(_sessionKey: string): Promise<void> {
    if (!this.lastRunId) return;
    await this.client.stopRun(this.lastRunId);
  }

  async steer(text: string): Promise<void> {
    if (!this.lastRunId) return;
    await this.client.steerRun(this.lastRunId, text);
  }

  async testConnection(_config: Record<string, unknown>): Promise<AdapterHealthResult> {
    try {
      await this.client.getCapabilities();
      return { status: "ok" };
    } catch (err) {
      return { status: "error", message: err instanceof Error ? err.message : "unknown" };
    }
  }
}
