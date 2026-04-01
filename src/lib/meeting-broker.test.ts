import assert from "node:assert/strict";
import test from "node:test";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { MeetingBroker } = require("./meeting-broker.js") as typeof import("./meeting-broker.js");

test("MeetingBroker strips SPEAK prefix from streamed and final response text", async () => {
  const streamedChunks: string[] = [];

  const broker = new MeetingBroker(
    {
      topic: "우선순위 회의",
      participants: [
        { agentId: "dev-b", displayName: "으뉴", role: "Participant" },
      ],
      gateway: {
        async chatSend(
          _agentId: string,
          _sessionKey: string,
          _message: string,
          onChunk: (chunk: string) => void,
        ) {
          onChunk("SPE");
          onChunk("AK:");
          onChunk(" 안");
          onChunk("녕하세요");
          return "SPEAK: 안녕하세요";
        },
      },
      sessionKeyPrefix: "sess-1",
      meetingId: "meet-1",
      quota: {
        maxTotalTurns: 5,
      },
    },
    {
      onTurnChunk: (_agentId: string, chunk: string) => {
        streamedChunks.push(chunk);
      },
    },
  );

  const response = await broker._speakWithAbort({
    agentId: "dev-b",
    displayName: "으뉴",
    role: "Participant",
  });

  assert.deepEqual(streamedChunks, ["안", "녕하세요"]);
  assert.equal(response, "안녕하세요");
});
