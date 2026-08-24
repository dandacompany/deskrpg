import assert from "node:assert/strict";
import test from "node:test";

import { MapChatWalkers } from "./map-chat-walkers";

test("맵 채팅으로 부른 NPC 는 도착해도 1:1 대화창을 열지 않는다", () => {
  const w = new MapChatWalkers();
  w.noteCall("danvi", "map-chat");
  assert.equal(w.takeOnArrival("danvi"), true);
});

test("컨텍스트 메뉴로 부른 NPC 는 도착하면 대화창을 연다", () => {
  const w = new MapChatWalkers();
  w.noteCall("danvi"); // reason 없음
  assert.equal(w.takeOnArrival("danvi"), false);
});

test("컨텍스트 메뉴 호출이 이전 맵 채팅 대기를 무효화한다", () => {
  // 사용자가 맵 채팅으로 부른 뒤, 도착 전에 우클릭으로 다시 부른 경우. 게임 장면은
  // 이미 걷고 있는 NPC 의 재호출을 조용히 무시하므로 도착은 원래 걷기로 일어난다.
  // 지우지 않으면 그 도착이 맵 채팅 것으로 읽혀, 방금 명시적으로 요청한 대화창이 삼켜진다.
  const w = new MapChatWalkers();
  w.noteCall("danvi", "map-chat");
  w.noteCall("danvi");
  assert.equal(w.takeOnArrival("danvi"), false, "대화창이 삼켜집니다.");
});

test("도착은 한 번만 소비한다", () => {
  // 같은 NPC 를 나중에 컨텍스트 메뉴로 부르면 그때는 대화창이 열려야 한다.
  const w = new MapChatWalkers();
  w.noteCall("danvi", "map-chat");
  assert.equal(w.takeOnArrival("danvi"), true);
  assert.equal(w.takeOnArrival("danvi"), false, "대기가 소비되지 않고 남았습니다.");
});

test("도착 없이 끝난 걷기는 대기를 남기지 않는다", () => {
  // 자리로 복귀하면 도착 이벤트가 오지 않는다. 남겨 두면 그 NPC 의 다음 도착이
  // 엉뚱하게 맵 채팅 것으로 읽힌다.
  const w = new MapChatWalkers();
  w.noteCall("danvi", "map-chat");
  w.forget("danvi");
  assert.equal(w.takeOnArrival("danvi"), false, "복귀 후에도 대기가 남았습니다.");
});

test("NPC 별로 따로 센다", () => {
  const w = new MapChatWalkers();
  w.noteCall("danvi", "map-chat");
  w.noteCall("mia");
  assert.equal(w.takeOnArrival("mia"), false);
  assert.equal(w.takeOnArrival("danvi"), true, "다른 NPC 의 호출이 대기를 지웠습니다.");
});
