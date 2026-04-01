import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  OpenClawGateway,
  buildGatewayErrorPayload,
  getGatewayErrorStatus,
  testGatewayConnection,
} = require("./openclaw-gateway.js");

test("gateway surfaces connect handshake errors from the server", async () => {
  const gateway = new OpenClawGateway();
  gateway._connectRequestId = "req-1";

  const connectPromise = new Promise((resolve, reject) => {
    gateway._connectResolve = resolve;
    gateway._connectReject = reject;
  });

  gateway._handleMessage(JSON.stringify({
    type: "res",
    id: "req-1",
    ok: false,
    error: {
      code: "PAIRING_REQUIRED",
      message: "control ui requires device identity (use HTTPS or localhost secure context)",
      requestId: "pair-123",
      details: { pairUrl: "https://gateway.example.com/pair/pair-123" },
    },
  }));

  await assert.rejects(
    connectPromise,
    (err) => {
      assert.equal(err.errorCode, "PAIRING_REQUIRED");
      assert.equal(err.requestId, "pair-123");
      assert.deepEqual(err.details, { pairUrl: "https://gateway.example.com/pair/pair-123" });
      assert.match(err.message, /device identity/);
      return true;
    },
  );
});

test("gateway surfaces structured RPC errors from the server", async () => {
  const gateway = new OpenClawGateway();
  const sentFrames = [];

  gateway._ws = {
    readyState: 1,
    send(payload) {
      sentFrames.push(JSON.parse(payload));
    },
  };

  gateway._status = "connected";

  const listPromise = gateway.agentsList();
  const listFrame = sentFrames.at(-1);

  gateway._handleMessage(JSON.stringify({
    type: "res",
    id: listFrame.id,
    ok: false,
    error: {
      code: "PAIRING_REQUIRED",
      message: "Pair this workspace before using agents.list",
      requestId: "pair-456",
      details: { pairUrl: "https://gateway.example.com/pair/pair-456" },
    },
  }));

  await assert.rejects(
    listPromise,
    (err) => {
      assert.equal(err.errorCode, "PAIRING_REQUIRED");
      assert.equal(err.requestId, "pair-456");
      assert.deepEqual(err.details, { pairUrl: "https://gateway.example.com/pair/pair-456" });
      assert.match(err.message, /Pair this workspace/);
      return true;
    },
  );
});

test("buildGatewayErrorPayload preserves pairing metadata", () => {
  const error = new Error("Pair before continuing");
  error.errorCode = "PAIRING_REQUIRED";
  error.requestId = "pair-789";
  error.details = { pairUrl: "https://gateway.example.com/pair/pair-789" };

  assert.deepEqual(
    buildGatewayErrorPayload(error, {
      ok: false,
      fallbackErrorCode: "connection_failed",
      fallbackError: "Connection failed",
    }),
    {
      ok: false,
      errorCode: "PAIRING_REQUIRED",
      error: "Pair before continuing",
      requestId: "pair-789",
      details: { pairUrl: "https://gateway.example.com/pair/pair-789" },
    },
  );
  assert.equal(getGatewayErrorStatus(error, 500), 409);
});

test("testGatewayConnection does a connect and list round-trip", async () => {
  class FakeGateway {
    constructor() {
      this.calls = [];
    }

    async connect(url, token) {
      this.calls.push(["connect", url, token]);
    }

    async agentsList() {
      this.calls.push(["agents.list"]);
      return [{ id: "main", name: "main", workspace: "/workspace/main" }];
    }

    disconnect() {
      this.calls.push(["disconnect"]);
    }
  }

  const result = await testGatewayConnection(
    "https://gateway.example.com",
    "secret-token",
    FakeGateway,
  );

  assert.deepEqual(result, {
    agents: [{ id: "main", name: "main", workspace: "/workspace/main" }],
  });
});

test("gateway can resolve agents.list and agents.create RPCs after connect", async () => {
  const gateway = new OpenClawGateway();
  const sentFrames = [];

  gateway._ws = {
    readyState: 1,
    send(payload) {
      sentFrames.push(JSON.parse(payload));
    },
  };

  gateway._status = "connected";

  const listPromise = gateway.agentsList();
  const listFrame = sentFrames.at(-1);
  assert.equal(listFrame.method, "agents.list");
  gateway._handleMessage(JSON.stringify({
    type: "res",
    id: listFrame.id,
    ok: true,
    payload: { agents: [{ id: "main", name: "main", workspace: "/workspace/main" }] },
  }));

  const agents = await listPromise;
  assert.equal(agents.length, 1);
  assert.equal(agents[0].id, "main");

  const createPromise = gateway.agentsCreate("npc-worker", "/workspace/npc-worker");
  const createFrame = sentFrames.at(-1);
  assert.equal(createFrame.method, "agents.create");
  assert.deepEqual(createFrame.params, {
    name: "npc-worker",
    workspace: "/workspace/npc-worker",
  });

  gateway._handleMessage(JSON.stringify({
    type: "res",
    id: createFrame.id,
    ok: true,
    payload: { ok: true, agentId: "npc-worker" },
  }));

  const created = await createPromise;
  assert.equal(created.ok, true);
  assert.equal(created.agentId, "npc-worker");
});
