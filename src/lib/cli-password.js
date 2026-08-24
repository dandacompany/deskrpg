"use strict";

/**
 * `deskrpg create-user` 의 비밀번호 입력 경로를 고른다.
 *
 * 왜 갈래를 나누는가: `--password PW` 만 있으면 비밀번호가 셸 히스토리와 `ps` 출력에
 * 평문으로 남는다. 공유 셸이나 다중 사용자 서버에서는 다른 사용자에게도 보인다.
 * 그렇다고 인자를 없앨 수는 없다 — 스크립트와 CI 가 그 형태로 부른다.
 *
 * 그래서 우선순위를 둔다: 명시적 stdin > 명시적 인자 > 대화형 프롬프트. 앞의 둘은
 * 호출자가 의도를 밝힌 것이므로 그대로 따르고, 아무것도 없을 때만 물어본다.
 *
 * 입출력은 전부 주입받는다 — 이 결정 자체는 TTY 도 스트림도 몰라야 테스트할 수 있다.
 */
async function resolvePassword(options) {
  const {
    passwordArg = null,
    fromStdin = false,
    readStdin,
    promptPassword,
    isTty = false,
  } = options || {};

  if (fromStdin) {
    const piped = await readStdin();
    // 파이프는 개행으로 끝나는 것이 정상이다(`echo pw | deskrpg …`). 마지막 개행만
    // 떼고 나머지는 건드리지 않는다 — 비밀번호에 공백이 있을 수 있다.
    return String(piped).replace(/\r?\n$/, "");
  }

  if (passwordArg !== null && passwordArg !== undefined) return passwordArg;

  if (!isTty) {
    // 비대화형인데 아무 경로도 주지 않았다. 여기서 프롬프트를 띄우면 스크립트가
    // 조용히 멈춘다 — 물어보는 대신 무엇을 하라고 말한다.
    throw new Error("password required: pass --password PW, or pipe it with --password-stdin");
  }

  return await promptPassword();
}

module.exports = { resolvePassword };
