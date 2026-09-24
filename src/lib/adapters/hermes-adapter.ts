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
      // The two endpoints use different delta event names (measured live, v0.20.2):
      //   1:1     /api/sessions/<id>/chat/stream → assistant.delta
      //   meeting /v1/runs/<id>/events           → message.delta
      // Because only assistant.* was being watched, onDelta was never called even once in
      // meetings. The response itself arrived via execute()'s return value, so the NPC spoke
      // fine, but with no streaming chunks the client's stream buffer stayed empty and there
      // was no bubble to finalize even when done:true arrived — the meeting ran completely
      // normally while the screen stayed blank.
      if (
        (event.event === "assistant.delta" || event.event === "message.delta") &&
        typeof event.data.delta === "string"
      ) {
        options.onDelta?.(event.data.delta);
      }
      // Real tool use comes through as tool.started / tool.completed. Looking only at
      // tool.progress shows almost nothing — measured live (2026-08-28, 3 tool uses):
      // started 3, completed 3, progress was `_thinking` only once.
      //
      // preview isn't passed through. tool.progress's `_thinking` preview is the entire
      // finished answer, and streaming that as a chat chunk used to make the answer show up
      // twice. Consumers get **only the name**.
      if (event.event === "tool.started" || event.event === "tool.progress") {
        const name = typeof event.data.tool_name === "string" ? event.data.tool_name : "";
        options.onToolProgress?.(name, "");
      }
      // Not cleared by tool.completed. If started and completed cross paths in an instant,
      // the two state updates get batched together and the intermediate state never
      // renders — measured live (2026-08-28), web_search was used 3 times and nothing showed
      // up on screen. Leaving the last tool name in place and clearing it all at once when
      // the stream ends lets the user see "something's happening" with no gaps.
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
        instructions: options.instructions,
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
      systemMessage: options.instructions,
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
