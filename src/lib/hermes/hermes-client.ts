import { streamDiagnostic } from "./stream-diagnostics";
import { transportFetch } from "./setup/transport";
// Profile-scoped HTTP client for the Hermes API Server.
// Knows URLs, auth and error shapes. Knows nothing about DeskRPG's DB.

import { createSseParser, type SseEvent } from "./sse";
import { isTerminalEvent, type HermesCapabilities } from "./types";

export type HermesErrorCode =
  "unauthorized" | "unknown_profile" | "unreachable" | "http_error" | "run_failed";

import { parseRetryAfterMs, retryDelayMs, shouldRetryStatus } from "./retry-policy";

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
  /** Injection point so tests don't actually wait. */
  sleepImpl?: (ms: number) => Promise<void>;
};

/** How many more attempts after the first. Chosen with the time a single meeting turn is held up in mind. */
const MAX_RETRIES = 2;

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
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(config: HermesClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.profileName = config.profileName;
    this.token = config.token;
    this.fetchImpl = config.fetchImpl ?? transportFetch;
    this.sleepImpl = config.sleepImpl ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
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

  /**
   * When the gateway rejects with 429 for exceeding the concurrent run limit, wait briefly and retry.
   *
   * Previously that rejection became an exception straight up to the caller, and meeting polling silently skipped
   * the failed participant — that NPC vanished, in neither raises nor passes.
   * Hermes even provides `Retry-After`, so there's no reason to throw it away.
   */
  private async request(
    path: string,
    init: RequestInit & { sessionKey?: string } = {},
  ): Promise<Response> {
    const { sessionKey, ...rest } = init;

    for (let attempt = 0; ; attempt += 1) {
      let res: Response;
      try {
        res = await this.fetchImpl(this.url(path), {
          ...rest,
          headers: this.headers(sessionKey ? { "X-Hermes-Session-Key": sessionKey } : undefined),
        });
      } catch (err) {
        throw new HermesError(
          "unreachable",
          err instanceof Error ? err.message : "Gateway unreachable",
          0,
        );
      }

      if (res.ok) return res;

      if (shouldRetryStatus(res.status) && attempt < MAX_RETRIES) {
        // Read the body to drain the socket — discarding it unread prevents connection reuse.
        await res.text().catch(() => "");
        await this.sleepImpl(
          retryDelayMs(attempt, parseRetryAfterMs(res.headers.get("Retry-After"))),
        );
        continue;
      }

      const text = await res.text().catch(() => "");
      throw new HermesError(
        errorCodeForStatus(res.status),
        text || `HTTP ${res.status}`,
        res.status,
      );
    }
  }

  async getCapabilities(): Promise<HermesCapabilities> {
    const res = await this.request("/v1/capabilities", { method: "GET" });
    return (await res.json()) as HermesCapabilities;
  }

  /** Finds an existing session by title. null if none. */
  private async findSessionByTitle(title: string): Promise<string | null> {
    try {
      const res = await this.request("/api/sessions", { method: "GET" });
      const json = (await res.json()) as { data?: { id?: string; title?: string | null }[] };
      const hit = (json.data ?? []).find((s) => s.title === title && s.id);
      return hit?.id ?? null;
    } catch {
      return null;
    }
  }

  async createSession(title: string): Promise<{ sessionId: string }> {
    let res: Response;
    try {
      res = await this.request("/api/sessions", {
        method: "POST",
        body: JSON.stringify({ title }),
      });
    } catch (err) {
      // Hermes enforces title uniqueness — if already taken it rejects with `invalid_title` and
      // even says which session holds it. Our titles are NPC×user context keys, so
      // a collision means "that conversation already exists" — it should be continued, not created anew.
      // (Orphan sessions left only on the Hermes side by a previous version that failed to parse the response are
      //  exactly this case — every retry collided on the same title.)
      const isTitleTaken =
        err instanceof HermesError && /invalid_title|Title already in use/i.test(err.message);
      if (!isTitleTaken) throw err;
      const existing = await this.findSessionByTitle(title);
      if (!existing) throw err;
      return { sessionId: existing };
    }
    // Measured (v0.20.2): POST /api/sessions returns the id **nested** —
    //   { "object": "hermes.session", "session": { "id": "api_…", … } }
    // Looking only at top-level session_id/id made 1:1 conversations die with "Session create returned no id".
    // Both flat shapes are still accepted (for older versions / other deployments).
    const json = (await res.json()) as {
      session_id?: string;
      id?: string;
      session?: { id?: string; session_id?: string };
    };
    const sessionId = json.session?.id ?? json.session?.session_id ?? json.session_id ?? json.id;
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
    // The text of a turn Hermes gave up on (`assistant.completed` with `completed: false`).
    let failedTurn: string | null = null;

    if (reader) {
      outer: for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        streamDiagnostic({ stage: "sse-read", runId, bytes: value.byteLength });

        for (const event of parser.push(decoder.decode(value, { stream: true }))) {
          streamDiagnostic({
            stage: "sse-event",
            runId: typeof event.data.run_id === "string" ? event.data.run_id : runId,
            event: event.event,
            length:
              typeof event.data.delta === "string"
                ? event.data.delta.length
                : typeof event.data.content === "string"
                  ? event.data.content.length
                  : 0,
          });
          onEvent(event);

          if (typeof event.data.run_id === "string") runId = event.data.run_id;
          if (typeof event.data.session_id === "string") sessionId = event.data.session_id;

          // The two endpoints use different delta event names (measured v0.20.2):
          //   1:1  /api/sessions/<id>/chat/stream → assistant.delta / assistant.completed
          //   meeting /v1/runs/<id>/events       → message.delta   / message.completed
          // Looking only at assistant.* meant not a single character accumulated on the meeting path,
          // the poll response became an empty string, and every NPC was tallied as PASS.
          if (
            (event.event === "assistant.delta" || event.event === "message.delta") &&
            typeof event.data.delta === "string"
          ) {
            accumulated += event.data.delta;
          } else if (
            (event.event === "assistant.completed" || event.event === "message.completed") &&
            typeof event.data.content === "string"
          ) {
            completed = event.data.content;
            if (event.data.completed === false) failedTurn = event.data.content;
          } else if (
            // The meeting path (/v1/runs) doesn't emit message.completed and carries the final answer in
            // run.completed's output (final_response). Deltas aren't rolled back, so when a model call is retried,
            // text from the earlier attempt piles up too — use this as the body instead of the accumulation. If
            // empty, keep the accumulation.
            event.event === "run.completed" &&
            typeof event.data.output === "string" &&
            event.data.output.trim()
          ) {
            completed = event.data.output;
          } else if (event.event === "run.failed" || event.event === "error") {
            // Measured (0.21.2, 1:1 chat stream): run.failed carries no message; the reason was
            // the unfinished assistant.completed just before it ("rejected your sign-in …").
            // The /v1/runs dialect (api_server_runs, 0.21.2) puts the provider's reason in `error`.
            failure =
              typeof event.data.message === "string"
                ? event.data.message
                : typeof event.data.error === "string" && event.data.error
                  ? event.data.error
                  : (failedTurn ?? "Hermes run failed");
          }

          if (isTerminalEvent(event.event)) {
            // **Don't wait** for the cancel. What we want here is "stop reading", not
            // "cancel cleanup finishes". Measured (v0.20.2): the meeting path
            // (/v1/runs/<id>/events) keeps the connection open even after sending run.completed, and
            // in that state await reader.cancel() neither resolves nor rejects and hangs
            // forever — .catch() only catches rejections, so it didn't prevent this deadlock. The meeting
            // gathers poll responses with Promise.allSettled, so one participant stuck here stalls the whole
            // meeting. On the 1:1 path (/api/sessions/<id>/chat/stream) the server closes the stream
            // right away, so this trap never surfaced.
            void reader.cancel().catch(() => {});
            break outer;
          }
        }
      }
    }
    parser.flush();

    // A run.failed/error SSE event is a healthy 200 stream reporting that the
    // agent run itself failed — not an HTTP-layer error. Callers (e.g. NPC
    // chat surfaces) need to tell the two apart to render a useful message.
    if (failure) throw new HermesError("run_failed", failure, 200);
    return { text: completed ?? accumulated, runId, sessionId };
  }

  async streamSessionChat(args: {
    sessionId: string;
    message: string;
    /**
     * System instructions for this turn. Hermes looks at `system_message` before `instructions`
     * (`body.get("system_message") or body.get("instructions")` in api_server),
     * and both flow into the same ephemeral system prompt. Empty values don't create the field.
     */
    systemMessage?: string;
    sessionKey?: string;
    onEvent: (event: SseEvent) => void;
  }): Promise<{ text: string; runId: string | null; sessionId: string }> {
    const chatBody: Record<string, unknown> = { message: args.message };
    if (args.systemMessage) chatBody.system_message = args.systemMessage;
    const res = await this.request(
      `/api/sessions/${encodeURIComponent(args.sessionId)}/chat/stream`,
      {
        method: "POST",
        body: JSON.stringify(chatBody),
        sessionKey: args.sessionKey,
      },
    );
    const drained = await this.drain(res, args.onEvent);
    return {
      text: drained.text,
      runId: drained.runId,
      sessionId: drained.sessionId ?? args.sessionId,
    };
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

  async streamRunEvents(
    runId: string,
    onEvent: (event: SseEvent) => void,
  ): Promise<{ text: string }> {
    const res = await this.request(`/v1/runs/${encodeURIComponent(runId)}/events`, {
      method: "GET",
    });
    const drained = await this.drain(res, onEvent);
    return { text: drained.text };
  }

  /**
   * The Hermes session a run belongs to. It is not the run id: a session key keeps one session across
   * runs, and plugin tools (`deskrpg_ask_user`) report this id. null when the run is unknown.
   */
  async getRunSessionId(runId: string): Promise<string | null> {
    const res = await this.request(`/v1/runs/${encodeURIComponent(runId)}`, { method: "GET" });
    const json = (await res.json().catch(() => null)) as { session_id?: unknown } | null;
    return typeof json?.session_id === "string" && json.session_id ? json.session_id : null;
  }

  async stopRun(runId: string): Promise<void> {
    await this.request(`/v1/runs/${encodeURIComponent(runId)}/stop`, {
      method: "POST",
      body: "{}",
    });
  }

  /** Answers a pending tool approval of a run (`POST /v1/runs/{id}/approval`). `always` is never sent. */
  async resolveRunApproval(
    runId: string,
    body: { choice: "once" | "session" | "deny"; request_id?: string },
  ): Promise<{ resolved: number }> {
    const res = await this.request(`/v1/runs/${encodeURIComponent(runId)}/approval`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    const parsed = (await res.json().catch(() => ({}))) as { resolved?: unknown };
    return { resolved: typeof parsed.resolved === "number" ? parsed.resolved : 0 };
  }

  async steerRun(runId: string, text: string): Promise<void> {
    await this.request(`/v1/runs/${encodeURIComponent(runId)}/steer`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
  }
}
