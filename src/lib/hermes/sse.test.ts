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
      'event: run.started\ndata: {"seq":1}\n\n' +
      'event: message.started\ndata: {"seq":2}\n\n',
    );
    assert.deepEqual(events.map((e) => e.event), ["run.started", "message.started"]);
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
    const events = parser.push('event: x\ndata: not-json\n\n' + 'event: y\ndata: {"a":1}\n\n');
    assert.deepEqual(events.map((e) => e.event), ["y"]);
  });

  test("flush drops an incomplete trailing frame", () => {
    const parser = createSseParser();
    parser.push('event: assistant.delta\ndata: {"delta":"잘림"');
    assert.deepEqual(parser.flush(), []);
  });
});
