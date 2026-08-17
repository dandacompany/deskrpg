// Profile-scoped HTTP client for the Hermes API Server.
// Knows URLs, auth and error shapes. Knows nothing about DeskRPG's DB.

import { createSseParser, type SseEvent } from "./sse";
import { isTerminalEvent, type HermesCapabilities } from "./types";

export type HermesErrorCode = "unauthorized" | "unknown_profile" | "unreachable" | "http_error";

export class HermesError extends Error {
  readonly code: HermesErrorCode;
  readonly status: number;

  constructor(code: HermesErrorCode, message: string, status: number) {
    super(message);
    this.name = "HermesError";
    this.code = code;
    this.status = status;
  }
}

export type HermesClientConfig = {
  baseUrl: string;
  /** null = the gateway's default profile (no /p/ prefix). */
  profileName: string | null;
  token: string;
  fetchImpl?: typeof fetch;
};

function errorCodeForStatus(status: number): HermesErrorCode {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "unknown_profile";
  return "http_error";
}

export class HermesClient {
  private readonly baseUrl: string;
  private readonly profileName: string | null;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: HermesClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.profileName = config.profileName;
    this.token = config.token;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  url(path: string): string {
    const prefix = this.profileName ? `/p/${encodeURIComponent(this.profileName)}` : "";
    return `${this.baseUrl}${prefix}${path}`;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  private async request(path: string, init: RequestInit & { sessionKey?: string } = {}): Promise<Response> {
    const { sessionKey, ...rest } = init;
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path), {
        ...rest,
        headers: this.headers(sessionKey ? { "X-Hermes-Session-Key": sessionKey } : undefined),
      });
    } catch (err) {
      throw new HermesError("unreachable", err instanceof Error ? err.message : "Gateway unreachable", 0);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new HermesError(errorCodeForStatus(res.status), text || `HTTP ${res.status}`, res.status);
    }
    return res;
  }

  async getCapabilities(): Promise<HermesCapabilities> {
    const res = await this.request("/v1/capabilities", { method: "GET" });
    return (await res.json()) as HermesCapabilities;
  }

  async createSession(title: string): Promise<{ sessionId: string }> {
    const res = await this.request("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ title }),
    });
    const json = (await res.json()) as { session_id?: string; id?: string };
    const sessionId = json.session_id ?? json.id;
    if (!sessionId) throw new HermesError("http_error", "Session create returned no id", 200);
    return { sessionId };
  }

  /**
   * Drain an SSE body, feeding every event to onEvent and folding the text.
   *
   * On a terminal event we stop reading the underlying stream entirely and
   * cancel the reader. A real Hermes server can keep the HTTP connection
   * open past `run.completed`/`done`/etc — if we only broke the inner
   * `for...of` over parsed events, the outer `reader.read()` loop would
   * keep awaiting the next chunk forever.
   */
  private async drain(
    res: Response,
    onEvent: (event: SseEvent) => void,
  ): Promise<{ text: string; runId: string | null; sessionId: string | null }> {
    const parser = createSseParser();
    const decoder = new TextDecoder();
    const reader = res.body?.getReader();

    let accumulated = "";
    let completed: string | null = null;
    let runId: string | null = null;
    let sessionId: string | null = null;
    let failure: string | null = null;

    if (reader) {
      outer: for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        for (const event of parser.push(decoder.decode(value, { stream: true }))) {
          onEvent(event);

          if (typeof event.data.run_id === "string") runId = event.data.run_id;
          if (typeof event.data.session_id === "string") sessionId = event.data.session_id;

          if (event.event === "assistant.delta" && typeof event.data.delta === "string") {
            accumulated += event.data.delta;
          } else if (event.event === "assistant.completed" && typeof event.data.content === "string") {
            completed = event.data.content;
          } else if (event.event === "run.failed" || event.event === "error") {
            failure = typeof event.data.message === "string" ? event.data.message : "Hermes run failed";
          }

          if (isTerminalEvent(event.event)) {
            await reader.cancel().catch(() => {});
            break outer;
          }
        }
      }
    }
    parser.flush();

    if (failure) throw new HermesError("http_error", failure, 200);
    return { text: completed ?? accumulated, runId, sessionId };
  }

  async streamSessionChat(args: {
    sessionId: string;
    message: string;
    sessionKey?: string;
    onEvent: (event: SseEvent) => void;
  }): Promise<{ text: string; runId: string | null; sessionId: string }> {
    const res = await this.request(`/api/sessions/${encodeURIComponent(args.sessionId)}/chat/stream`, {
      method: "POST",
      body: JSON.stringify({ message: args.message }),
      sessionKey: args.sessionKey,
    });
    const drained = await this.drain(res, args.onEvent);
    return { text: drained.text, runId: drained.runId, sessionId: drained.sessionId ?? args.sessionId };
  }

  async startRun(args: {
    input: string;
    conversationHistory?: Array<{ role: string; content: string }>;
    instructions?: string;
    sessionKey?: string;
  }): Promise<{ runId: string }> {
    const body: Record<string, unknown> = { input: args.input };
    if (args.conversationHistory?.length) body.conversation_history = args.conversationHistory;
    if (args.instructions) body.instructions = args.instructions;

    const res = await this.request("/v1/runs", {
      method: "POST",
      body: JSON.stringify(body),
      sessionKey: args.sessionKey,
    });
    const json = (await res.json()) as { run_id?: string };
    if (!json.run_id) throw new HermesError("http_error", "Run submission returned no run_id", 202);
    return { runId: json.run_id };
  }

  async streamRunEvents(runId: string, onEvent: (event: SseEvent) => void): Promise<{ text: string }> {
    const res = await this.request(`/v1/runs/${encodeURIComponent(runId)}/events`, { method: "GET" });
    const drained = await this.drain(res, onEvent);
    return { text: drained.text };
  }

  async stopRun(runId: string): Promise<void> {
    await this.request(`/v1/runs/${encodeURIComponent(runId)}/stop`, { method: "POST", body: "{}" });
  }

  async steerRun(runId: string, text: string): Promise<void> {
    await this.request(`/v1/runs/${encodeURIComponent(runId)}/steer`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
  }
}
