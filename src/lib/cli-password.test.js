"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { resolvePassword } = require("./cli-password");

function deps(overrides) {
  return Object.assign(
    {
      readStdin: async () => {
        throw new Error("readStdin 을 부르면 안 되는 갈래입니다.");
      },
      promptPassword: async () => {
        throw new Error("promptPassword 를 부르면 안 되는 갈래입니다.");
      },
    },
    overrides,
  );
}

test("--password 를 주면 그대로 쓴다 — 기존 호출을 깨지 않는다", async () => {
  const got = await resolvePassword(deps({ passwordArg: "hunter2", isTty: true }));
  assert.equal(got, "hunter2");
});

test("--password-stdin 은 인자보다 우선한다", async () => {
  // 둘 다 준 것은 호출자의 실수지만, 더 안전한 쪽을 고르는 편이 낫다.
  const got = await resolvePassword(
    deps({ passwordArg: "from-arg", fromStdin: true, readStdin: async () => "from-pipe\n" }),
  );
  assert.equal(got, "from-pipe");
});

test("파이프의 마지막 개행만 뗀다", async () => {
  // `echo pw | …` 는 개행을 붙인다. 그러나 비밀번호 안의 공백은 비밀번호의 일부다.
  const got = await resolvePassword(
    deps({ fromStdin: true, readStdin: async () => "  spaced pw  \n" }),
  );
  assert.equal(got, "  spaced pw  ");
});

test("CRLF 로 끝나도 개행만 뗀다", async () => {
  const got = await resolvePassword(deps({ fromStdin: true, readStdin: async () => "pw\r\n" }));
  assert.equal(got, "pw");
});

test("아무것도 없고 TTY 면 물어본다", async () => {
  let asked = 0;
  const got = await resolvePassword(
    deps({
      isTty: true,
      promptPassword: async () => {
        asked++;
        return "typed";
      },
    }),
  );
  assert.equal(got, "typed");
  assert.equal(asked, 1);
});

test("아무것도 없고 TTY 가 아니면 멈추지 않고 에러를 낸다", async () => {
  // 여기서 프롬프트를 띄우면 스크립트가 입력을 기다리며 조용히 멈춘다 — CI 에서
  // 타임아웃까지 매달리는 최악의 실패 형태다.
  await assert.rejects(() => resolvePassword(deps({ isTty: false })), /password required/);
});

test("빈 문자열 인자도 인자로 친다 — 프롬프트로 새지 않는다", async () => {
  // `--password ""` 는 잘못된 입력이지만, 그 판정은 길이 검사가 할 일이다.
  // 여기서 프롬프트로 흘려보내면 비대화형 스크립트가 멈춘다.
  const got = await resolvePassword(deps({ passwordArg: "", isTty: true }));
  assert.equal(got, "");
});
