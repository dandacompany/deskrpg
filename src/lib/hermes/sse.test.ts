import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createSseParser } from "./sse";

describe("createSseParser", () => {
  test("parses a single complete frame", () => {
    const parser = createSseParser();
    const events = parser.push('event: assistant.delta\ndata: {"delta":"안녕","seq":1}\n\n');
    assert.equal(events.length, 1);
    assert.equal(events[0].event, "assistant.delta");
    assert.deepEqual(events[0].data, { delta: "안녕", seq: 1 });
  });

  test("parses two frames in one chunk", () => {
    const parser = createSseParser();
    const events = parser.push(
      'event: run.started\ndata: {"seq":1}\n\n' + 'event: message.started\ndata: {"seq":2}\n\n',
    );
    assert.deepEqual(
      events.map((e) => e.event),
      ["run.started", "message.started"],
    );
  });

  test("buffers a frame split across chunks", () => {
    const parser = createSseParser();
    assert.deepEqual(parser.push('event: assistant.delta\ndata: {"del'), []);
    assert.deepEqual(parser.push('ta":"세계"}\n'), []);
    const events = parser.push("\n");
    assert.equal(events.length, 1);
    assert.equal(events[0].data.delta, "세계");
  });

  test("defaults the event name to 'message' when no event line is present", () => {
    const parser = createSseParser();
    const events = parser.push('data: {"ok":true}\n\n');
    assert.equal(events[0].event, "message");
  });

  test("skips a frame whose data is not valid JSON instead of throwing", () => {
    const parser = createSseParser();
    const events = parser.push("event: x\ndata: not-json\n\n" + 'event: y\ndata: {"a":1}\n\n');
    assert.deepEqual(
      events.map((e) => e.event),
      ["y"],
    );
  });

  test("flush drops an incomplete trailing frame", () => {
    const parser = createSseParser();
    parser.push('event: assistant.delta\ndata: {"delta":"잘림"');
    assert.deepEqual(parser.flush(), []);
  });
});

// Measured regression — frames copied verbatim from /v1/runs/<id>/events (Hermes v0.20.2).
// This endpoint does not use SSE `event:` lines and puts the name inside the data JSON.
describe("SSE — /v1/runs dialect", () => {
  test("uses the payload's event field as the name when there is no event: line", () => {
    const parser = createSseParser();
    const events = parser.push(
      'data: {"event": "message.delta", "run_id": "run_1", "delta": "S"}\n\n' +
        'data: {"event": "run.completed", "run_id": "run_1"}\n\n',
    );
    assert.deepEqual(
      events.map((e) => e.event),
      ["message.delta", "run.completed"],
    );
    assert.equal(events[0].data.delta, "S");
  });

  test("an event: line takes precedence — the 1:1 dialect keeps working", () => {
    const parser = createSseParser();
    const [e] = parser.push('event: assistant.delta\ndata: {"event": "ignored", "delta": "x"}\n\n');
    assert.equal(e.event, "assistant.delta", "명시적 event: 줄을 payload 필드가 덮으면 안 된다");
  });

  test("with neither an event field nor an event: line, it is message as before", () => {
    const parser = createSseParser();
    const [e] = parser.push('data: {"delta": "x"}\n\n');
    assert.equal(e.event, "message");
  });
});
