import { describe, test, mock } from "node:test";
import assert from "node:assert/strict";
import { OpenClawAdapter } from "./openclaw-adapter";

describe("OpenClawAdapter", () => {
  test("type is 'openclaw'", () => {
    const adapter = new OpenClawAdapter();
    assert.equal(adapter.type, "openclaw");
  });

  test("execute throws without gateway", async () => {
    const adapter = new OpenClawAdapter();
    await assert.rejects(
      () => adapter.execute({ sessionKey: "s", prompt: "p" }),
      /Use executeWithGateway/,
    );
  });

  test("executeWithGateway delegates to gateway.chatSend", async () => {
    const adapter = new OpenClawAdapter();

    const mockGateway = {
      chatSend: mock.fn(
        async (_agentId: string, _sessionKey: string, _msg: string, onDelta: (d: string) => void) => {
          onDelta("Hello ");
          onDelta("world");
          return "Hello world";
        },
      ),
    };

    const chunks: string[] = [];
    const result = await adapter.executeWithGateway(
      mockGateway,
      {
        sessionKey: "test-dm-user1",
        prompt: "Hi",
        onDelta: (chunk) => chunks.push(chunk),
      },
      "agent-1",
    );

    assert.equal(result.response, "Hello world");
    assert.equal(result.session.sessionRef, "test-dm-user1");
    assert.deepEqual(chunks, ["Hello ", "world"]);
    assert.equal(mockGateway.chatSend.mock.callCount(), 1);

    const call = mockGateway.chatSend.mock.calls[0];
    assert.equal(call.arguments[0], "agent-1");
    assert.equal(call.arguments[1], "test-dm-user1");
    assert.equal(call.arguments[2], "Hi");
  });

  test("abortWithGateway delegates to gateway.chatAbort", async () => {
    const adapter = new OpenClawAdapter();
    const mockGateway = {
      chatAbort: mock.fn(async () => {}),
    };

    await adapter.abortWithGateway(mockGateway, "agent-1", "test-session");
    assert.equal(mockGateway.chatAbort.mock.callCount(), 1);
  });

  test("testConnection returns error without gateway", async () => {
    const adapter = new OpenClawAdapter();
    const result = await adapter.testConnection({});
    assert.equal(result.status, "error");
  });
});
