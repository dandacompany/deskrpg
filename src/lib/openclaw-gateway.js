/**
 * OpenClaw WebSocket RPC Gateway Client (CommonJS, Node.js)
 * Ported from claws-office/src/lib/openclaw-client.ts
 */

/* eslint-disable @typescript-eslint/no-require-imports */

const WebSocket = require("ws");
const { randomUUID } = require("crypto");

const PROTOCOL_MIN = 1;
const PROTOCOL_MAX = 3;

class OpenClawGatewayError extends Error {
  constructor({
    errorCode,
    error,
    requestId = null,
    details = null,
  }) {
    super(error);
    this.name = "OpenClawGatewayError";
    this.errorCode = errorCode || "gateway_error";
    this.requestId = requestId;
    this.details = details;
  }
}

function createGatewayError(error, fallbackErrorCode = "gateway_error", fallbackError = "Gateway error") {
  if (error instanceof OpenClawGatewayError) return error;

  const message = error && typeof error === "object" && typeof error.message === "string"
    ? error.message
    : fallbackError;
  const errorCode = error && typeof error === "object"
    ? (typeof error.errorCode === "string"
      ? error.errorCode
      : typeof error.code === "string"
        ? error.code
        : fallbackErrorCode)
    : fallbackErrorCode;
  const requestId = error && typeof error === "object" && typeof error.requestId === "string"
    ? error.requestId
    : null;
  const details = error && typeof error === "object" && "details" in error
    ? error.details ?? null
    : null;

  return new OpenClawGatewayError({
    errorCode,
    error: message,
    requestId,
    details,
  });
}

function buildGatewayErrorPayload(
  error,
  {
    ok = false,
    fallbackErrorCode = "gateway_error",
    fallbackError = "Gateway error",
  } = {},
) {
  const normalized = createGatewayError(error, fallbackErrorCode, fallbackError);
  const responseErrorCode = normalized.errorCode === "PAIRING_REQUIRED"
    ? "gateway_pairing_required"
    : normalized.errorCode;
  const payload = {
    ok,
    errorCode: responseErrorCode,
    error: normalized.message || fallbackError,
  };

  if (normalized.requestId) payload.requestId = normalized.requestId;
  if (normalized.details != null) payload.details = normalized.details;

  return payload;
}

function getGatewayErrorStatus(error, fallbackStatus = 500) {
  const normalized = createGatewayError(error);
  if (
    normalized.errorCode === "PAIRING_REQUIRED"
    || normalized.errorCode === "gateway_pairing_required"
  ) return 409;
  return fallbackStatus;
}

async function testGatewayConnection(url, token, GatewayClass = OpenClawGateway) {
  const gateway = new GatewayClass();
  try {
    await gateway.connect(url, token);
    const agents = await gateway.agentsList();
    return { agents };
  } finally {
    gateway.disconnect();
  }
}

class OpenClawGateway {
  constructor() {
    this._ws = null;
    this._closed = false;
    this._backoffMs = 1000;
    this._lastSeq = null;
    this._connectSent = false;
    this._connectTimer = null;
    this._connectRequestId = null;
    this._lastTick = null;
    this._tickIntervalMs = 30000;
    this._tickTimer = null;
    this._status = "disconnected";
    this._url = null;
    this._token = null;

    // RPC pending requests
    this._pending = new Map();
    this._rpcTimeout = 30000;

    // Event listeners
    this._eventHandlers = new Map(); // event name → Set<handler>
    this._statusHandlers = new Set();

    // Chat streaming: sessionKey → { onDelta, resolve, reject }
    this._chatStreams = new Map();
  }

  // ── Public API ──────────────────────────────────────────────

  connect(url, token) {
    return new Promise((resolve, reject) => {
      this._url = url;
      this._token = token;
      this._closed = false;
      this._connectResolve = resolve;
      this._connectReject = reject;
      this._setStatus("connecting");
      this._start();
    });
  }

  disconnect() {
    this._closed = true;
    this._setStatus("disconnected");
    if (this._tickTimer) { clearInterval(this._tickTimer); this._tickTimer = null; }
    if (this._connectTimer) { clearTimeout(this._connectTimer); this._connectTimer = null; }
    if (this._ws) { this._ws.close(); this._ws = null; }
    // Reject all pending
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(new Error("Gateway disconnected"));
    }
    this._pending.clear();
    for (const [, stream] of this._chatStreams) {
      stream.reject(new Error("Gateway disconnected"));
    }
    this._chatStreams.clear();
  }

  isConnected() {
    return this._status === "connected";
  }

  on(event, handler) {
    if (!this._eventHandlers.has(event)) this._eventHandlers.set(event, new Set());
    this._eventHandlers.get(event).add(handler);
  }

  off(event, handler) {
    this._eventHandlers.get(event)?.delete(handler);
  }

  // ── Chat ────────────────────────────────────────────────────

  /**
   * Send a chat message and stream the response.
   * @param {string} agentId
   * @param {string} sessionKey
   * @param {string} message
   * @param {(delta: string) => void} onDelta - called for each streaming chunk
   * @returns {Promise<string>} full response text
   */
  chatSend(agentId, sessionKey, message, onDelta) {
    return new Promise((resolve, reject) => {
      // sessionKey format: agent:{agentId}:{sessionName}
      const fullSessionKey = sessionKey.startsWith("agent:") ? sessionKey : `agent:${agentId}:${sessionKey}`;
      const id = this._sendRequest("chat.send", {
        sessionKey: fullSessionKey,
        message,
        idempotencyKey: randomUUID(),
      });

      this._chatStreams.set(fullSessionKey, {
        requestId: id,
        onDelta,
        resolve: (text) => { this._chatStreams.delete(fullSessionKey); resolve(text); },
        reject: (err) => { this._chatStreams.delete(fullSessionKey); reject(err); },
        fullText: "",
      });

      // Timeout for chat (3 minutes)
      const timer = setTimeout(() => {
        const stream = this._chatStreams.get(fullSessionKey);
        if (stream) {
          this._chatStreams.delete(fullSessionKey);
          stream.reject(new Error("Chat timeout"));
        }
      }, 180000);
      this._chatStreams.get(fullSessionKey)._timer = timer;
    });
  }

  chatAbort(agentId, sessionKey) {
    const fullKey = sessionKey.startsWith("agent:") ? sessionKey : `agent:${agentId}:${sessionKey}`;
    return this._rpcRequest("chat.abort", { sessionKey: fullKey });
  }

  // ── Agents ──────────────────────────────────────────────────

  async agentsList() {
    const res = await this._rpcRequest("agents.list", {});
    return res.agents || [];
  }

  async agentsCreate(name, workspace, emoji) {
    const params = { name };
    if (workspace) params.workspace = workspace;
    if (emoji) params.emoji = emoji;
    return this._rpcRequest("agents.create", params);
  }

  async agentsDelete(agentId, deleteFiles = false) {
    return this._rpcRequest("agents.delete", { agentId, deleteFiles });
  }

  async agentsFileGet(agentId, name) {
    return this._rpcRequest("agents.files.get", { agentId, name });
  }

  async agentsFileSet(agentId, name, content) {
    return this._rpcRequest("agents.files.set", { agentId, name, content });
  }

  async agentsFilesList(agentId) {
    const res = await this._rpcRequest("agents.files.list", { agentId });
    return res.files || [];
  }

  // ── RPC ─────────────────────────────────────────────────────

  _rpcRequest(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.isConnected()) {
        return reject(new Error("Gateway not connected"));
      }
      const id = this._sendRequest(method, params);
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, this._rpcTimeout);
      this._pending.set(id, { resolve, reject, timer });
    });
  }

  _sendRequest(method, params) {
    const id = randomUUID();
    const frame = { type: "req", id, method, params };
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(frame));
    }
    return id;
  }

  // ── WebSocket internals ─────────────────────────────────────

  _setStatus(s) {
    if (this._status === s) return;
    this._status = s;
    for (const h of this._statusHandlers) h(s);
  }

  _start() {
    if (this._closed || !this._url) return;

    // Convert http(s) to ws(s)
    let wsUrl = this._url;
    if (wsUrl.startsWith("https://")) wsUrl = "wss://" + wsUrl.slice(8);
    else if (wsUrl.startsWith("http://")) wsUrl = "ws://" + wsUrl.slice(7);
    else if (!wsUrl.startsWith("ws://") && !wsUrl.startsWith("wss://")) wsUrl = "ws://" + wsUrl;

    // Set origin to localhost — always in OpenClaw's default allowedOrigins
    try {
      this._ws = new WebSocket(wsUrl, { headers: { Origin: "http://localhost:18789" } });
    } catch (err) {
      console.error("[OpenClawGW] WebSocket creation failed:", err.message);
      this._scheduleReconnect();
      return;
    }

    this._ws.on("open", () => this._queueConnect());

    this._ws.on("message", (data) => {
      this._handleMessage(data.toString());
    });

    this._ws.on("close", () => {
      this._ws = null;
      if (!this._closed) {
        this._setStatus("reconnecting");
        this._scheduleReconnect();
      }
    });

    this._ws.on("error", (err) => {
      console.warn("[OpenClawGW] WebSocket error:", err.message);
    });
  }

  _queueConnect() {
    this._connectSent = false;
    if (this._connectTimer) clearTimeout(this._connectTimer);
    this._connectTimer = setTimeout(() => this._sendConnect(), 750);
  }

  _sendConnect() {
    if (this._connectSent) return;
    this._connectSent = true;
    if (this._connectTimer) { clearTimeout(this._connectTimer); this._connectTimer = null; }

    const id = randomUUID();
    const frame = {
      type: "req",
      id,
      method: "connect",
      params: {
        minProtocol: PROTOCOL_MIN,
        maxProtocol: PROTOCOL_MAX,
        client: { id: "openclaw-control-ui", version: "1.0.0", platform: "node", mode: "ui" },
        caps: ["tool-events"],
        scopes: ["operator.admin"],
        auth: this._token ? { token: this._token } : undefined,
      },
    };
    this._ws.send(JSON.stringify(frame));
    this._connectRequestId = id;
  }

  _handleMessage(raw) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return; }

    // Event frame
    if (parsed.type === "event") {
      // Challenge
      if (parsed.event === "connect.challenge") {
        this._connectSent = false;
        this._sendConnect();
        return;
      }

      // Tick keepalive
      if (parsed.event === "tick") {
        this._lastTick = Date.now();
        return;
      }

      // Agent streaming events (delta text chunks)
      if (parsed.event === "agent" && parsed.payload) {
        const p = parsed.payload;
        const sessionKey = p.sessionKey;
        const stream = sessionKey ? this._chatStreams.get(sessionKey) : null;
        if (stream && p.stream === "assistant" && p.data?.delta) {
          stream.fullText = (stream.fullText || "") + p.data.delta;
          stream.onDelta(p.data.delta);
        }
        return;
      }

      // Chat events (final state)
      if (parsed.event === "chat" && parsed.payload) {
        const p = parsed.payload;
        const sessionKey = p.sessionKey;
        const stream = sessionKey ? this._chatStreams.get(sessionKey) : null;

        if (!stream) {
          const handlers = this._eventHandlers.get("chat");
          if (handlers) for (const h of handlers) h(parsed);
          return;
        }

        if (p.state === "final") {
          // Extract text from message.content array
          let finalText = stream.fullText || "";
          if (!finalText && p.message?.content) {
            for (const c of p.message.content) {
              if (c.type === "text") finalText += c.text;
            }
          }
          if (stream._timer) clearTimeout(stream._timer);
          stream.resolve(finalText);
        } else if (p.state === "error") {
          if (stream._timer) clearTimeout(stream._timer);
          stream.reject(new Error(p.error || p.errorMessage || "Chat error"));
        }
        return;
      }

      // Generic event handlers
      const handlers = this._eventHandlers.get(parsed.event);
      if (handlers) for (const h of handlers) h(parsed);
      return;
    }

    // Response frame
    if (parsed.type === "res") {
      // Connect response
      if (parsed.id === this._connectRequestId && parsed.ok) {
        this._backoffMs = 1000;
        const policy = parsed.payload?.policy;
        this._tickIntervalMs = policy?.tickIntervalMs || 30000;
        this._lastTick = Date.now();
        this._startTickWatch();
        this._setStatus("connected");
        this._connectRequestId = null;
        if (this._connectResolve) {
          this._connectResolve();
          this._connectResolve = null;
          this._connectReject = null;
        }
        return;
      }

      // Connect error
      if (parsed.id === this._connectRequestId && !parsed.ok) {
        if (this._connectReject) {
          this._connectReject(createGatewayError(parsed.error, "connect_failed", "Connect failed"));
          this._connectResolve = null;
          this._connectReject = null;
        }
        return;
      }

      // RPC response
      const p = this._pending.get(parsed.id);
      if (p) {
        this._pending.delete(parsed.id);
        clearTimeout(p.timer);
        if (parsed.ok) p.resolve(parsed.payload || {});
        else p.reject(createGatewayError(parsed.error, "rpc_error", "RPC error"));
      }
    }
  }

  _scheduleReconnect() {
    if (this._closed) return;
    if (this._tickTimer) { clearInterval(this._tickTimer); this._tickTimer = null; }
    const delay = this._backoffMs + Math.random() * 500;
    this._backoffMs = Math.min(this._backoffMs * 2, 30000);
    setTimeout(() => this._start(), delay);
  }

  _startTickWatch() {
    if (this._tickTimer) clearInterval(this._tickTimer);
    this._tickTimer = setInterval(() => {
      if (this._closed || !this._lastTick) return;
      if (Date.now() - this._lastTick > this._tickIntervalMs * 2) {
        console.warn("[OpenClawGW] Tick timeout, reconnecting");
        this._ws?.close(4000, "tick timeout");
      }
    }, Math.max(this._tickIntervalMs, 1000));
  }
}

module.exports = {
  OpenClawGateway,
  OpenClawGatewayError,
  buildGatewayErrorPayload,
  createGatewayError,
  getGatewayErrorStatus,
  testGatewayConnection,
};
