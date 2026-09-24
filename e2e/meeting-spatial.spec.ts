import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { waitForGameLoop } from "./helpers";
import type { MeetingSpatialState } from "../src/lib/meeting-discussion-state";
import { OFFICE_ENVIRONMENTS } from "../src/game/three/office-environments";

type Frame = { direction: "sent" | "received"; event: string; data: unknown; at: number };
function observe(page: Page): Frame[] {
  const frames: Frame[] = [];
  page.on("websocket", (socket) => {
    const capture =
      (direction: Frame["direction"]) =>
      ({ payload }: { payload: string | Buffer }) => {
        const text = payload.toString();
        // Default-namespace Socket.IO EVENT: Engine.IO 4 + EVENT 2 + optional ack id.
        // For example, seat:claim is 421["seat:claim", {...}], not just 42[...].
        const packet = /^42\d*(\[[\s\S]*)$/.exec(text);
        if (!packet) return;
        try {
          const [event, data] = JSON.parse(packet[1]);
          frames.push({ direction, event, data, at: Date.now() });
        } catch {
          /* Engine.IO control frames are not application events. */
        }
      };
    socket.on("framesent", capture("sent"));
    socket.on("framereceived", capture("received"));
  });
  return frames;
}
async function post(api: APIRequestContext, url: string, data: unknown) {
  const response = await api.post(url, { data });
  expect(response.ok(), `${url}: ${response.status()} ${await response.text()}`).toBeTruthy();
  return response.json();
}
async function speak(page: Page, message: string) {
  const input = page
    .locator('[data-meeting-workspace] textarea, [data-meeting-workspace] [contenteditable="true"]')
    .last();
  await input.fill(message);
  await input.press("Enter");
  await expect(
    page.locator("[data-meeting-workspace]").getByText(message, { exact: true }),
  ).toBeVisible();
}
/** With the map template table gone, fixture layouts are made by creating a channel and overwriting its map directly. */
function annexMap(kind: string) {
  const cols = 14,
    rows = 12;
  const mapData =
    kind === "tiled"
      ? {
          tiledversion: "1.10.2",
          orientation: "orthogonal",
          renderorder: "right-down",
          width: cols,
          height: rows,
          tilewidth: 32,
          tileheight: 32,
          tilesets: [],
          layers: [
            {
              id: 1,
              name: "Floor",
              type: "tilelayer",
              width: cols,
              height: rows,
              data: Array(cols * rows).fill(0),
            },
            {
              id: 2,
              name: "Objects",
              type: "objectgroup",
              objects: [{ id: 1, type: "desk", x: 96, y: 96 }],
            },
          ],
        }
      : {
          layers: {
            floor: Array.from({ length: rows }, () => Array(cols).fill(1)),
            walls: Array.from({ length: rows }, () => Array(cols).fill(0)),
          },
          objects: [{ id: "kept-desk", type: "desk", col: 3, row: 3 }],
        };
  return { mapData, mapConfig: { cols, rows, spawnCol: 1, spawnRow: 1 } };
}

/**
 * Create a channel. Official office environments are created directly with `environmentId`; fixture layouts (legacy, tiled)
 * are created with any environment and then the map is overwritten — the map template API has been removed.
 */
async function createSpatialChannel(
  api: APIRequestContext,
  { name, groupId, kind }: { name: string; groupId: string; kind: string },
) {
  const official = OFFICE_ENVIRONMENTS.some((entry) => entry.id === kind);
  const { channel } = await post(api, "/api/channels", {
    name,
    isPublic: true,
    groupId,
    environmentId: official ? kind : OFFICE_ENVIRONMENTS[0].id,
  });
  if (!official) {
    const response = await api.put(`/api/channels/${channel.id}`, { data: annexMap(kind) });
    expect(
      response.ok(),
      `PUT /api/channels/${channel.id}: ${response.status()} ${await response.text()}`,
    ).toBeTruthy();
  }
  return channel;
}

async function waitForOfficeReady(page: Page, frames: Frame[]) {
  // The simulation moves the player only after all three server snapshots arrive (even with 0 NPCs).
  await expect
    .poll(
      () =>
        ["player:spawn", "players:state", "npc:motion-state"].every((event) =>
          frames.some((frame) => frame.direction === "received" && frame.event === event),
        ),
      {
        timeout: 30_000,
        message: "Server player, peer and NPC motion snapshots must hydrate before movement",
      },
    )
    .toBeTruthy();
  await expect
    .poll(() => waitForGameLoop(page, 0), {
      // Latest GLTF layouts compile shaders after socket hydration; retain the FPS
      // threshold but allow cold assets to finish before testing movement.
      timeout: 60_000,
      message: "Visible canvas must reach 10 rAF frames/second after server hydration",
    })
    .toBeGreaterThanOrEqual(10);
}

test("isolated humans walk, share seats and leave independently on the original canvas", async ({
  browser,
  playwright,
  baseURL,
}, info) => {
  test.skip(
    process.env.DESKRPG_E2E_ALLOW_SEED !== "isolated-local",
    "Requires explicit isolated-local seed opt-in; creates synthetic users and a channel.",
  );
  expect(new URL(baseURL!).hostname).toMatch(/^(localhost|127\.0\.0\.1)$/);
  const admin = await playwright.request.newContext({ baseURL });
  const contexts = await Promise.all(
    [0, 1].map(() => browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } })),
  );
  const frames: Frame[][] = [];
  try {
    await post(admin, "/api/auth/login", {
      loginId: process.env.DESKRPG_E2E_LOGIN_ID,
      password: process.env.DESKRPG_E2E_PASSWORD,
    });
    const { groups } = await (await admin.get("/api/groups")).json();
    const suffix = Date.now().toString(36);
    const channel = await createSpatialChannel(admin, {
      name: `meeting-e2e-${suffix}`,
      groupId: groups.find((g: { isDefault: boolean }) => g.isDefault).id,
      kind: "tech",
    });
    const pages: Page[] = [];
    for (const [index, context] of contexts.entries()) {
      const identity = `meeting-e2e-${suffix}-${index}`;
      await post(context.request, "/api/auth/register", {
        loginId: identity,
        nickname: identity,
        password: `Isolated-meeting-${suffix}!`,
      });
      await post(context.request, "/api/characters", {
        name: identity,
        appearance: { officeLookId: "office-jun", bodyType: "male" },
      });
      await post(context.request, `/api/channels/${channel.id}/join`, {});
      const page = await context.newPage();
      frames.push(observe(page));
      await page.goto(`/game?channelId=${channel.id}`);
      await expect(page.locator(".office-three-canvas canvas")).toBeVisible();
      await waitForOfficeReady(page, frames[index]);
      pages.push(page);
    }
    const [a, b] = pages;
    const canvas = await a.locator(".office-three-canvas canvas").elementHandle();
    frames[0].length = 0;
    await a.locator('[data-meeting-entry="navbar"]').click();
    await expect(a.locator('[data-meeting-join-state="joined"]')).toBeVisible();
    await expect(a.locator('.office-presentation[data-meeting="true"]')).toBeVisible();
    expect(
      await canvas!.evaluate(
        (element) => element === document.querySelector(".office-three-canvas canvas"),
      ),
    ).toBeTruthy();
    const joinIndex = frames[0].findIndex(
      (f) => f.direction === "sent" && f.event === "meeting:join",
    );
    expect(joinIndex).toBeGreaterThan(0);
    expect(
      frames[0]
        .slice(0, joinIndex)
        .some((f) => f.direction === "sent" && f.event === "player:move"),
    ).toBeTruthy();
    // React development effect replay may send join/leave/join. Assert one admitted
    // participant rather than treating the transport attempt count as admission count.
    const admission = frames[0].filter((f) => f.event === "meeting:state").at(-1)?.data as {
      discussion: unknown;
      participants: Array<{ id: string }>;
    };
    expect(admission.discussion).toBeNull();
    expect(admission.participants).toHaveLength(1);
    await expect(a.locator("[data-meeting-start]")).toBeDisabled();
    await a
      .locator('[data-meeting-workspace] textarea[maxlength="200"]')
      .fill(`Human preparation ${suffix}`);
    await expect(a.locator("[data-meeting-start]")).toBeDisabled();
    const beforeJoinMessage = `private-before-join-${suffix}`;
    await speak(a, beforeJoinMessage);
    await b.waitForTimeout(1000);
    expect(frames[1].some((f) => f.event === "meeting:message")).toBeFalsy();
    await expect(b.getByText(beforeJoinMessage, { exact: true })).toHaveCount(0);
    await b.locator('[data-meeting-entry="navbar"]').click();
    await expect(b.locator('[data-meeting-join-state="joined"]')).toBeVisible();
    const latestSpatial = (index: number) =>
      frames[index].filter((f) => f.event === "meeting:spatial-state").at(-1)?.data as
        MeetingSpatialState | undefined;
    await expect
      .poll(() => latestSpatial(0)?.participants.filter((p) => p.state === "seated").length)
      .toBe(2);
    await expect.poll(() => latestSpatial(1)).toEqual(latestSpatial(0));
    const seats = latestSpatial(0)!.participants.map((p) => p.seatId);
    expect(new Set(seats).size).toBe(2);
    expect(seats.every(Boolean)).toBeTruthy();
    for (const name of [/^(확대|Zoom in)$/, /^(축소|Zoom out)$/]) {
      const zoom = a.getByRole("button", { name, includeHidden: true });
      await expect(zoom).toBeDisabled();
      await expect(zoom).toBeHidden();
    }
    const sharedMessage = `shared-meeting-${suffix}`;
    await speak(a, sharedMessage);
    await expect(
      b.locator("[data-meeting-workspace]").getByText(sharedMessage, { exact: true }),
    ).toBeVisible();
    await a.getByRole("button", { name: /왼쪽으로 회전|Rotate left/ }).click();
    await expect(a.locator("[data-meeting-auto-camera]")).toHaveAttribute("aria-pressed", "false");
    await expect(b.locator("[data-meeting-auto-camera]")).toHaveAttribute("aria-pressed", "true");
    await a.locator("[data-meeting-auto-camera]").click();
    await expect(a.locator("[data-meeting-auto-camera]")).toHaveAttribute("aria-pressed", "true");
    await a.setViewportSize({ width: 390, height: 844 });
    await expect(a.locator("[data-meeting-leave]")).toBeVisible();
    await a.locator("[data-meeting-leave]").click();
    await expect(a.locator("[data-meeting-workspace]")).toHaveCount(0);
    await expect(b.locator('[data-meeting-join-state="joined"]')).toBeVisible();
    await expect
      .poll(() => frames[1].some((f) => f.event === "meeting:participant-left"))
      .toBeTruthy();
    const afterLeaveMessage = `private-after-leave-${suffix}`;
    const messagesBefore = frames[0].filter((f) => f.event === "meeting:message").length;
    await speak(b, afterLeaveMessage);
    await a.waitForTimeout(1000);
    expect(frames[0].filter((f) => f.event === "meeting:message")).toHaveLength(messagesBefore);
    await expect(a.getByText(afterLeaveMessage, { exact: true })).toHaveCount(0);
    await a.setViewportSize({ width: 1440, height: 900 });
    await a.locator('[data-meeting-entry="navbar"]').click();
    await expect(a.locator('[data-meeting-join-state="joined"]')).toBeVisible();
    expect(
      frames.flat().some((f) => f.direction === "sent" && f.event === "meeting:start-discussion"),
    ).toBeFalsy();
  } finally {
    await info.attach("meeting-websocket-evidence", {
      body: JSON.stringify(frames, null, 2),
      contentType: "application/json",
    });
    await Promise.all(contexts.map((context) => context.close()));
    await admin.dispose();
  }
});

test("seven map meeting smoke: official environments and legacy/Tiled annex", async ({
  browser,
  playwright,
  baseURL,
}, info) => {
  test.skip(
    process.env.DESKRPG_E2E_ALLOW_SEED !== "isolated-local" ||
      process.env.DESKRPG_E2E_MEETING_MATRIX !== "1",
    "Explicit local seed and matrix opt-ins required.",
  );
  test.setTimeout(15 * 60_000);
  expect(new URL(baseURL!).hostname).toMatch(/^(localhost|127\.0\.0\.1)$/);
  const admin = await playwright.request.newContext({ baseURL });
  const user = await playwright.request.newContext({ baseURL });
  const failures: string[] = [];
  const suffix = Date.now().toString(36);
  try {
    await post(admin, "/api/auth/login", {
      loginId: process.env.DESKRPG_E2E_LOGIN_ID,
      password: process.env.DESKRPG_E2E_PASSWORD,
    });
    const { groups } = await (await admin.get("/api/groups")).json();
    const nickname = `meeting-matrix-${suffix}`;
    await post(user, "/api/auth/register", {
      loginId: nickname,
      nickname,
      password: `Isolated-matrix-${suffix}!`,
    });
    await post(user, "/api/characters", {
      name: nickname,
      appearance: { officeLookId: "office-jun", bodyType: "male" },
    });
    for (const kind of [
      "trading",
      "tech",
      "executive",
      "publishing",
      "agency",
      "legacy",
      "tiled",
    ]) {
      const context = await browser.newContext({
        baseURL,
        storageState: await user.storageState(),
        viewport: { width: 1440, height: 900 },
      });
      const page = await context.newPage();
      const frames = observe(page);
      try {
        await test.step(kind, async () => {
          const channel = await createSpatialChannel(admin, {
            name: `meeting-matrix-${kind}-${suffix}`,
            groupId: groups.find((g: { isDefault: boolean }) => g.isDefault).id,
            kind,
          });
          await post(user, `/api/channels/${channel.id}/join`, {});
          await page.goto(`/game?channelId=${channel.id}`);
          await expect(page.locator(".office-three-canvas canvas")).toBeVisible({
            timeout: 60_000,
          });
          await waitForOfficeReady(page, frames);
          const canvas = await page.locator(".office-three-canvas canvas").elementHandle();
          if (kind === "legacy") {
            // Arm the real cancel click before starting the long walk into the appended annex.
            await Promise.all([
              page
                .locator('[data-meeting-entry-status="walking"] button')
                .click({ timeout: 15_000 }),
              page.locator('[data-meeting-entry="navbar"]').click(),
            ]);
            await expect(page.locator('[data-meeting-entry-status="walking"]')).toHaveCount(0);
            await page.waitForTimeout(1000);
            expect(
              frames.filter(
                (frame) => frame.direction === "sent" && frame.event === "meeting:join",
              ),
            ).toHaveLength(0);
            await expect(page.locator("[data-meeting-workspace]")).toHaveCount(0);
          }
          await page.locator('[data-meeting-entry="navbar"]').click();
          await expect(page.locator('[data-meeting-join-state="joined"]')).toBeVisible({
            timeout: 60_000,
          });
          await expect(page.locator('.office-presentation[data-meeting="true"]')).toBeVisible({
            timeout: 15_000,
          });
          expect(
            await canvas!.evaluate(
              (element) => element === document.querySelector(".office-three-canvas canvas"),
            ),
          ).toBeTruthy();
          await expect
            .poll(
              () =>
                (
                  frames.filter((frame) => frame.event === "meeting:spatial-state").at(-1)?.data as
                    MeetingSpatialState | undefined
                )?.participants.some((p) => p.state === "seated" && !!p.seatId),
              { timeout: 30_000 },
            )
            .toBeTruthy();
          expect(
            frames.some(
              (frame) => frame.direction === "sent" && frame.event === "meeting:start-discussion",
            ),
          ).toBeFalsy();
          await info.attach(`${kind}-joined`, {
            body: await page.screenshot(),
            contentType: "image/png",
          });
          await page.locator("[data-meeting-leave]").click();
          await expect(page.locator("[data-meeting-workspace]")).toHaveCount(0, {
            timeout: 10_000,
          });
        });
      } catch (error) {
        failures.push(`${kind}: ${String(error)}`);
        await info.attach(`${kind}-failure`, {
          body: await page.screenshot(),
          contentType: "image/png",
        });
      } finally {
        await info.attach(`${kind}-websocket`, {
          body: JSON.stringify(frames, null, 2),
          contentType: "application/json",
        });
        await context.close();
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  } finally {
    await user.dispose();
    await admin.dispose();
  }
});
