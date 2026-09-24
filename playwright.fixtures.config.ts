import { defineConfig } from "@playwright/test";

const port = Number(process.env.DESKRPG_FIXTURE_PORT ?? "13104");
if (!Number.isInteger(port) || port < 1024 || port > 65534) throw new Error("Invalid fixture port");
const baseURL = `http://127.0.0.1:${port}`;

// Specs that call a real Hermes are not included in this allowlist.
export default defineConfig({
  testDir: "./e2e",
  testMatch: ["artifacts.spec.ts", "kanban-card-move.spec.ts", "fixture-contract.spec.ts"],
  projects: [{ name: "game-fixtures" }],
  workers: 1,
  fullyParallel: false,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: [["list"]],
  outputDir: ".artifacts/game-fixtures/test-results",
  use: {
    baseURL,
    browserName: "chromium",
    headless: true,
    viewport: { width: 1440, height: 900 },
    locale: "ko-KR",
    launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node e2e/fixtures/server.mjs",
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 90_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
  },
});
