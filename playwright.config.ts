import { defineConfig } from "@playwright/test";

// DeskRPG E2E — for local/manual runs only.
//
// Not part of the default CI pipeline. This suite needs a live Hermes gateway (local 8642)
// and a seeded development DB, and CI has neither. `npm run test` (616 node:test tests) stays
// pure unit tests, and this one runs only when a person calls `npm run test:e2e`.
//
// Uses the installed Chrome instead of downloading a browser (channel: "chrome"). Downloading bundled Chromium
// costs hundreds of MB more, and what we want to verify is "does it work in this machine's Chrome".
export default defineConfig({
  testDir: "./e2e",
  // One NPC turn can exceed a minute including agent startup. The default 30 seconds
  // dies before the reply even arrives.
  timeout: 180_000,
  expect: { timeout: 120_000 },
  // Conversations share the same channel and the same NPC. Running in parallel steps on each other's sessions.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    // Must be localhost — not 127.0.0.1. To the browser these are different origins, and
    // the Next dev server blocks dev resource requests from origins not in allowedDevOrigins. Then
    // the RSC payload never arrives and React stalls before hydrating — no console error,
    // no failed request, just "로딩 중..." left on screen. Measured: attaching to the same server via 127.0.0.1 gives
    // fiber=0/input=0, via localhost gives fiber=2/input=2.
    baseURL: process.env.DESKRPG_E2E_BASE_URL ?? "http://localhost:3000",
    channel: "chrome",
    // Runs headless. This decision is based on measurement: in headed mode, the moment the window is
    // covered by another window Chrome throttles requestAnimationFrame to 1 frame per second, and
    // the Phaser game loop effectively stops so the character does not move. document.visibilityState
    // is still "visible" then, so code cannot detect it. Headless has no window to cover.
    headless: true,
    viewport: { width: 1440, height: 900 },
    locale: "ko-KR",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
});
