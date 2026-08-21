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

// 실측 회귀 — /v1/runs/<id>/events 프레임을 그대로 옮긴 것이다(Hermes v0.20.2).
// 이 엔드포인트는 SSE `event:` 줄을 쓰지 않고 이름을 data JSON 안에 넣는다.
describe("SSE — /v1/runs 방언", () => {
  test("event: 줄이 없으면 payload 의 event 필드를 이름으로 쓴다", () => {
    const parser = createSseParser();
    const events = parser.push(
      'data: {"event": "message.delta", "run_id": "run_1", "delta": "S"}\n\n'
      + 'data: {"event": "run.completed", "run_id": "run_1"}\n\n',
    );
    assert.deepEqual(events.map((e) => e.event), ["message.delta", "run.completed"]);
    assert.equal(events[0].data.delta, "S");
  });

  test("event: 줄이 있으면 그쪽이 우선한다 — 1:1 방언은 그대로 동작한다", () => {
    const parser = createSseParser();
    const [e] = parser.push('event: assistant.delta\ndata: {"event": "ignored", "delta": "x"}\n\n');
    assert.equal(e.event, "assistant.delta", "명시적 event: 줄을 payload 필드가 덮으면 안 된다");
  });

  test("event 필드도 event: 줄도 없으면 기존대로 message 다", () => {
    const parser = createSseParser();
    const [e] = parser.push('data: {"delta": "x"}\n\n');
    assert.equal(e.event, "message");
  });
});
