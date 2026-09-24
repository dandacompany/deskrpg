import { test } from "node:test";
import assert from "node:assert/strict";
import { GREETINGS, NpcSmalltalk } from "./npc-smalltalk";
const actors = () => [
  { id: "a", name: "노아", x: 1, y: 1, walking: true, available: true },
  { id: "b", name: "미나 · 기획", x: 2, y: 1, walking: false, available: true },
];
test("named exchange is staggered, expires, and avoids immediate template repetition", () => {
  const talk = new NpcSmalltalk();
  talk.update(
    actors(),
    0,
    () => true,
    () => 0,
  );
  const first = talk.text("a", 0);
  assert.match(first!, /미나님/);
  assert.equal(talk.text("b", 0), undefined);
  assert.match(talk.text("b", 2000)!, /노아님/);
  assert.equal(talk.text("a", 6500), undefined);
  talk.update(
    actors(),
    50000,
    () => true,
    () => 0,
  );
  assert.equal(talk.text("a", 50000), undefined);
  talk.update(
    actors(),
    90000,
    () => true,
    () => 0,
  );
  assert.notEqual(talk.text("a", 90000), first);
});
test("busy staff, stationary pairs, distant staff and walls do not trigger greetings", () => {
  for (const condition of ["busy", "still", "far", "wall"]) {
    const talk = new NpcSmalltalk(),
      people = actors();
    if (condition === "busy") people[1].available = false;
    if (condition === "still") people[0].walking = false;
    if (condition === "far") people[1].x = 20;
    talk.update(people, 0, () => condition !== "wall");
    assert.equal(talk.text("a", 0), undefined);
  }
});
test("real conversations cancel pending replies", () => {
  const talk = new NpcSmalltalk(),
    people = actors();
  talk.update(people, 0, () => true);
  people[1].available = false;
  talk.update(people, 1000, () => true);
  assert.equal(talk.text("b", 2000), undefined);
});
test("both participants stay through the reply and resume together after 7.5 seconds", () => {
  const talk = new NpcSmalltalk(),
    people = actors();
  talk.update(people, 0, () => true);
  assert.equal(talk.partner("a", 0), "b");
  assert.equal(talk.partner("b", 0), "a");
  people[0].walking = false;
  talk.update(people, 6500, () => true);
  assert.equal(talk.text("b", 6500), undefined);
  assert.equal(talk.partner("a", 7499), "b");
  assert.equal(talk.partner("b", 7499), "a");
  talk.update(people, 7500, () => true);
  assert.equal(talk.partner("a", 7500), undefined);
  assert.equal(talk.partner("b", 7500), undefined);
});
test("a call or removal releases both participants immediately, including delayed reply", () => {
  for (const removed of [false, true]) {
    const talk = new NpcSmalltalk(),
      people = actors();
    talk.update(people, 0, () => true);
    if (removed) people.pop();
    else people[1].available = false;
    talk.update(people, 1000, () => true);
    assert.equal(talk.partner("a", 1000), undefined);
    assert.equal(talk.partner("b", 1000), undefined);
    assert.equal(talk.text("a", 1000), undefined);
    assert.equal(talk.text("b", 2000), undefined);
  }
});

// Pin the Korean lines exactly (order included) before they move into a per-locale table.
const KO_LINES_BEFORE_I18N = [
  ["{name}님, 좋은 하루예요!", "{name}님도 좋은 하루 보내세요!"],
  ["{name}님, 잠깐 스트레칭 어때요?", "좋아요, {name}님! 어깨 좀 풀어야겠어요."],
  ["{name}님, 커피 한 잔 하셨어요?", "아직요! {name}님 덕분에 생각났네요."],
  ["{name}님, 오늘도 반가워요!", "저도요, {name}님. 오늘도 힘내요!"],
  ["{name}님, 점심 맛있게 드셨어요?", "네! {name}님도 식사 잘 챙기세요."],
  ["{name}님, 잠깐 바람 쐬러 가세요?", "네, {name}님. 잠깐 걸으니 좋네요."],
  ["{name}님, 오늘 컨디션 어떠세요?", "좋아요! {name}님은 어떠세요?"],
  ["{name}님, 오늘도 수고 많으세요.", "고마워요, {name}님. 같이 힘내요!"],
  ["{name}님, 물 한 잔 챙기세요!", "감사해요, {name}님도요!"],
  ["{name}님, 잠깐 쉬어 가요.", "좋은 생각이에요, {name}님!"],
  ["{name}님, 창가 쪽이 참 좋네요.", "맞아요, {name}님. 눈도 잠깐 쉬어 가요."],
  ["{name}님, 오후도 파이팅이에요!", "{name}님도요! 천천히 하나씩 해봐요."],
  ["{name}님, 오늘 옷 멋지네요!", "고마워요, {name}님! 기분 좋네요."],
  ["{name}님, 간식 생각 안 나세요?", "마침 생각했어요, {name}님!"],
  ["{name}님, 산책하니 머리가 맑아져요.", "그러게요, {name}님. 좋은 휴식이네요."],
  ["{name}님, 반가워요. 잘 지내시죠?", "네, {name}님! 안부 고마워요."],
];

test("the Korean smalltalk lines stay exactly as they were", () => {
  assert.deepEqual(GREETINGS, KO_LINES_BEFORE_I18N);
});
