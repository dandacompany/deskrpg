import { expect, test as base, type BrowserContext, type Route } from "@playwright/test";
import { SignJWT } from "jose";

export const FIXTURE_JWT_SECRET = "deskrpg-e2e-synthetic-secret-not-for-production";
const diagnostics = new WeakMap<BrowserContext, string[]>();

// Throwing in a route callback only times out the element wait. Report the original request at teardown.
export function assertFixtureRequests(errors: string[]) {
  expect(errors, "Unexpected fixture API requests or page errors").toEqual([]);
}

export const test = base.extend<{ fixtureDiagnostics: string[] }>({
  fixtureDiagnostics: [
    async ({ context }, runTest) => {
      const errors: string[] = [];
      diagnostics.set(context, errors);
      context.on("page", (page) =>
        page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`)),
      );
      try {
        await runTest(errors);
      } finally {
        assertFixtureRequests(errors);
      }
    },
    { auto: true },
  ],
});
export { expect };

export function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

export async function installGameFixture(
  context: BrowserContext,
  options: {
    channelId: string;
    characterId: string;
    handle: (route: Route) => Promise<void | false>;
  },
) {
  const baseURL = test.info().project.use.baseURL;
  if (!baseURL) throw new Error("Game fixtures require a configured baseURL");
  const token = await new SignJWT({ userId: "e2e-user", nickname: "E2E" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(
      new TextEncoder().encode(
        test.info().project.name === "game-fixtures"
          ? FIXTURE_JWT_SECRET
          : (process.env.DESKRPG_FIXTURE_JWT_SECRET ??
              "deskrpg-dev-jwt-secret-do-not-use-in-production"),
      ),
    );
  await context.addCookies([
    { name: "token", value: token, url: baseURL, httpOnly: true, sameSite: "Lax" },
  ]);
  await context.route("**/socket.io/**", (route) => route.abort());
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const root = `/api/channels/${options.channelId}`;
    if (request.method() === "GET") {
      if (path === "/api/app-meta")
        return json(route, {
          version: "2026.922.1",
          latestVersion: null,
          stars: null,
          feedbackUrl: null,
        });
      if (path === `${root}/projects`) return json(route, { projects: [] });
      if (path === `${root}/kanban/attachments`)
        return json(route, { supported: true, attachments: [], next_cursor: null });
      if (path === "/api/characters/me")
        return json(route, {
          character: {
            id: options.characterId,
            name: "E2E Character",
            appearance: { officeLookId: "office-jun", bodyType: "male" },
          },
        });
      if (path === root)
        return json(route, {
          channel: {
            id: options.channelId,
            name: "Fixture Office",
            description: null,
            inviteCode: null,
            mapData: null,
            mapConfig: null,
            mapRevision: "fixture",
            isPublic: true,
            isMember: true,
            isOwner: true,
            hasGateway: true,
          },
        });
      if (path === "/api/npcs" && url.searchParams.get("channelId") === options.channelId)
        return json(route, { npcs: [] });
      if (path === "/api/meetings" && url.searchParams.get("channelId") === options.channelId)
        return json(route, { minutes: [] });
      // The office state map (D08) reads the judgments inbox on join; an empty inbox leaves every employee idle.
      if (path === `${root}/attention`)
        return json(route, {
          rows: [],
          counts: { awaiting_approval: 0, blocked: 0, review: 0, total: 0 },
        });
      // Report acknowledgments live on the server; an empty record means nothing acknowledged and nothing to import.
      if (path === `${root}/report-acks`) return json(route, { ack: { through: null, ids: [] } });
      if (path === `${root}/automation/status`)
        return json(route, {
          pluginStatus: "ready",
          pluginVersion: "0.12.1",
          capabilities: ["kanban", "events", "artifacts"],
          timezone: "Asia/Seoul",
          boardSlug: "fixture",
          dispatcherPresent: true,
          attachments: true,
          lastPolledAt: null,
          lastError: null,
          minVersion: "0.6.0",
          working: [],
        });
    }
    if ((await options.handle(route)) !== false) return;
    diagnostics.get(context)?.push(`${request.method()} ${url.pathname}${url.search}`);
    await route.abort("failed");
  });
}
