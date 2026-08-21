import { defineConfig } from "@playwright/test";

// DeskRPG E2E — 로컬/수동 실행 전용.
//
// CI 기본 파이프라인에 넣지 않는다. 이 스위트는 살아 있는 Hermes 게이트웨이(로컬 8642)와
// 시드된 개발 DB 를 요구하고, 그 둘은 CI 에 없다. `npm run test` (node:test 616개)는
// 그대로 순수 단위 테스트로 남고, 이쪽은 `npm run test:e2e` 로 사람이 부를 때만 돈다.
//
// 브라우저는 내려받지 않고 이미 설치된 Chrome 을 쓴다(channel: "chrome"). 번들 Chromium
// 을 받으면 수백 MB 가 더 들고, 우리가 검증하려는 것은 "이 기계의 Chrome 에서 되는가"다.
export default defineConfig({
  testDir: "./e2e",
  // NPC 한 턴은 에이전트 기동까지 포함해 1분을 넘길 수 있다. 기본 30초로는
  // 응답이 오기도 전에 죽는다.
  timeout: 180_000,
  expect: { timeout: 120_000 },
  // 대화는 같은 채널·같은 NPC 를 공유한다. 병렬로 돌리면 서로의 세션을 밟는다.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    // 반드시 localhost — 127.0.0.1 이 아니다. 브라우저에게 이 둘은 서로 다른 origin 이고,
    // Next dev 서버는 allowedDevOrigins 에 없는 origin 의 dev 자원 요청을 막는다. 그러면
    // RSC 페이로드가 끝내 도착하지 않아 React 가 hydrate 전에 멈춰 선다 — 콘솔 에러도,
    // 실패한 요청도 없이 "로딩 중..." 만 남는다. 실측: 같은 서버에 127.0.0.1 로 붙으면
    // fiber=0/input=0, localhost 로 붙으면 fiber=2/input=2.
    baseURL: process.env.DESKRPG_E2E_BASE_URL ?? "http://localhost:3000",
    channel: "chrome",
    // headless 로 돈다. 이 결정에는 실측 근거가 있다: headed 로 띄우면 창이 다른 창에
    // 가리는 순간 Chrome 이 requestAnimationFrame 을 초당 1프레임으로 스로틀하고,
    // Phaser 게임 루프가 사실상 멈춰 캐릭터가 이동하지 않는다. document.visibilityState
    // 는 그때도 "visible" 이라 코드로는 감지되지 않는다. headless 에는 가릴 창이 없다.
    headless: true,
    viewport: { width: 1440, height: 900 },
    locale: "ko-KR",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
});
