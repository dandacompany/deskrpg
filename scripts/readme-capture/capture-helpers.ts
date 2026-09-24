import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { expect, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import type { Camera, Scene, WebGLRenderer } from "three";
import { capturePaths, type CaptureScene } from "./contracts";
import type { CaptureFixture } from "./fixture";

export const ROOT = path.resolve(__dirname, "../..");
const origins = new WeakMap<Page, number>();
export const wireEvents = new WeakMap<
  Page,
  Array<{ event: string; data: Record<string, unknown> }>
>();
declare global {
  interface Window {
    __readmeProbe?: { scene: Scene; camera: Camera; frames: number };
    __readmeEvents?: Array<{ event: string; data: Record<string, unknown> }>;
    __readmeSpeakers?: string[];
  }
}

/** The origin is Node monotonic time at context page creation, never browser epoch time. */
export function observeRecordingPage(page: Page, origin: number) {
  origins.set(page, origin);
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  wireEvents.set(page, events);
  page.on("websocket", (socket) =>
    socket.on("framereceived", ({ payload }) => {
      const text = String(payload);
      if (!text.startsWith("42")) return;
      try {
        const [event, data] = JSON.parse(text.slice(2));
        events.push({ event, data });
      } catch {
        /* Engine frames are not all Socket.IO events. */
      }
    }),
  );
}

export async function readFixture(): Promise<CaptureFixture> {
  const fixture = JSON.parse(
    await fs.readFile(path.join(ROOT, ".artifacts/readme-capture/fixture.json"), "utf8"),
  ) as CaptureFixture;
  expect(fixture.loginId).toBe("readme-capture");
  expect(fixture.channelId).toBeTruthy();
  expect(fixture.npcNames).toEqual(["Sophie", "Noah"]);
  expect(fixture.profileNames).toEqual(["sophie", "noah"]);
  return fixture;
}

function resetCaptureHistory(fixture: CaptureFixture) {
  const db = new Database(path.join(ROOT, ".artifacts/readme-capture/runtime/data/db.sqlite"), {
    fileMustExist: true,
  });
  try {
    // This file is the dedicated capture runtime. Limit cleanup further to this fixture's rows.
    db.prepare(
      "DELETE FROM chat_room_messages WHERE room_id IN (SELECT id FROM chat_rooms WHERE channel_id = ?)",
    ).run(fixture.channelId);
    db.prepare("DELETE FROM meeting_minutes WHERE channel_id = ?").run(fixture.channelId);
    // A saved last position overrides the configured spawn (`office-simulation.createPlayer`).
    // Clear it so the scene starts next to the employee the fixture placed, with the room input open.
    db.prepare("UPDATE channel_members SET last_x = NULL, last_y = NULL WHERE channel_id = ?").run(
      fixture.channelId,
    );
    db.prepare(
      "DELETE FROM chat_messages WHERE npc_id IN (SELECT id FROM npcs WHERE channel_id = ?)",
    ).run(fixture.channelId);
  } finally {
    db.close();
  }
}

export async function enterCaptureOffice(page: Page, fixture: CaptureFixture) {
  const login = await page.request.post("/api/auth/login", {
    data: { loginId: fixture.loginId, password: fixture.password },
  });
  expect(login.ok()).toBe(true);
  const roster = await page.request.get(`/api/npcs?channelId=${fixture.channelId}`);
  const { npcs } = await roster.json();
  for (const name of fixture.npcNames)
    expect(npcs.some((npc: { name: string }) => npc.name === name)).toBe(true);
  // There is one character of your own and it is not picked from a list — the old screen's "click the character button" step is gone.
  await page.goto("/channels");
  await page.getByRole("heading", { name: "Dante Labs Office", exact: true }).click();
  await page.waitForURL(new RegExp(fixture.channelId));
  await expect(page.locator(".office-three-canvas canvas")).toBeVisible();
  await expect(page.locator('.office-actor-label[data-asset-status="ready"]')).toHaveCount(3);
}

export async function prepareScene(page: Page, scene: CaptureScene, fixture: CaptureFixture) {
  const health = await page.request.get("/__readme-capture/health");
  const body = await health.json();
  expect(body.listenerAddress).toBe("127.0.0.1");
  expect(body.repositoryEnvLoaded).toBe(false);
  expect(body.instanceId).toMatch(/^readme-capture-/);
  await page.addInitScript(() => {
    localStorage.setItem("deskrpg-locale", "ko");
    // Attach passive listeners when the frontend EventBus creates its event sets.
    // No event is emitted or suppressed; the original listener dispatch is untouched.
    window.__readmeEvents = [];
    const watched = new Set(["npc:call-to-player", "npc:movement-arrived", "chat:input-enabled"]);
    const originalSet = Map.prototype.set;
    Map.prototype.set = function (key, value) {
      if (watched.has(key) && value instanceof Set) {
        value.add((data: Record<string, unknown>) =>
          window.__readmeEvents!.push({ event: key, data }),
        );
        watched.delete(key);
        if (!watched.size) Map.prototype.set = originalSet;
      }
      return originalSet.call(this, key, value);
    };
    window.__THREE_DEVTOOLS__ = new EventTarget();
    window.__THREE_DEVTOOLS__.addEventListener("observe", (event) => {
      const renderer = (event as CustomEvent<WebGLRenderer>).detail;
      if (!("isWebGLRenderer" in renderer) || !renderer.isWebGLRenderer) return;
      const original = renderer.render.bind(renderer);
      renderer.render = (scene, camera) => {
        if (scene.getObjectByName("commute-vehicles"))
          window.__readmeProbe = {
            scene: scene as Scene,
            camera,
            frames: (window.__readmeProbe?.frames ?? 0) + 1,
          };
        original(scene, camera);
      };
    });
  });
  if (scene === "home-commute") {
    await page.goto("/auth");
    await expect(page.locator(".commute-canvas")).toHaveAttribute("data-ready", "true");
    await expect
      .poll(async () => (await trafficSnapshot(page)).actors)
      .toEqual(Array(6).fill("ready"));
    expect((await trafficSnapshot(page)).vehicles).toHaveLength(6);
  } else {
    resetCaptureHistory(fixture);
    await enterCaptureOffice(page, fixture);
    await page.getByRole("button", { name: "전체 보기", exact: true }).click();
    // Pin down which input we wait for — if a nearby employee greets us, the NPC dialog opens
    // and the "last textbox" is no longer the room input.
    const roomInput = page.locator('[data-chat-scope="room"] [contenteditable]');
    const unlocked = Date.now() + 15_000;
    while (Date.now() < unlocked) {
      if ((await roomInput.getAttribute("contenteditable")) === "true") break;
      await page.waitForTimeout(250);
    }
    if ((await roomInput.getAttribute("contenteditable")) !== "true") {
      const seen = await page.evaluate(() =>
        (window.__readmeEvents ?? []).filter((entry) => entry.event === "chat:input-enabled"),
      );
      throw new Error(`room input stayed locked; chat:input-enabled = ${JSON.stringify(seen)}`);
    }
    await expect(page.getByLabel("3D performance")).toHaveCount(0);
  }
}

export async function markClip(
  page: Page,
  scene: CaptureScene,
  action: () => Promise<void>,
  durationMs = 9000,
) {
  const origin = origins.get(page);
  if (origin === undefined) throw new Error("Recording page monotonic origin was not registered");
  const checkpoints = path.join(ROOT, ".artifacts/readme-capture/checkpoints");
  await fs.mkdir(checkpoints, { recursive: true });
  const start = performance.now();
  const startMs = start - origin;
  // Sample before the screenshot: its promise resolves after the captured frame.
  await page.screenshot({ path: path.join(checkpoints, `${scene}-start.png`) });
  // Real WebM frame checks show up to ~300 ms of screencast/origin skew. A short
  // opening hold keeps the first interaction inside the marked interval.
  await page.waitForTimeout(500);
  await action();
  const remaining = durationMs - (performance.now() - start);
  if (remaining > 0) await page.waitForTimeout(remaining);
  const endMs = performance.now() - origin;
  await page.screenshot({ path: path.join(checkpoints, `${scene}-end.png`) });
  expect(endMs - startMs).toBeGreaterThanOrEqual(8000);
  expect(endMs - startMs).toBeLessThanOrEqual(10000);
  const target = capturePaths(ROOT, scene).timing;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify({ startMs, endMs }, null, 2));
}

export async function orbit(page: Page, pixels: number, durationMs: number) {
  const box = await page.locator(".office-three-canvas canvas").boundingBox();
  if (!box) throw new Error("3D canvas has no bounds");
  const x = box.x + box.width * 0.6,
    y = box.y + box.height * 0.45;
  await page.mouse.move(x, y);
  await page.mouse.down({ button: "right" });
  const steps = Math.max(24, Math.ceil(durationMs / 33)),
    started = performance.now();
  try {
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(x + (pixels * i) / steps, y);
      await page.waitForTimeout(
        Math.max(0, (durationMs * i) / steps - (performance.now() - started)),
      );
    }
  } finally {
    await page.mouse.up({ button: "right" });
  }
}

export async function zoom(page: Page, deltaY: number, steps: number) {
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, deltaY / steps);
    await page.waitForTimeout(75);
  }
}

export async function trafficSnapshot(page: Page) {
  return page.evaluate(() => {
    const scene = window.__readmeProbe?.scene;
    const actors: string[] = [];
    scene?.traverse((object) => {
      if (object.userData.assetStatus) actors.push(object.userData.assetStatus);
    });
    return {
      actors,
      vehicles:
        scene?.getObjectByName("commute-vehicles")?.children.map((vehicle) => ({
          id: vehicle.name,
          x: vehicle.position.x,
          z: vehicle.position.z,
          wheel: vehicle.getObjectByName("wheel")!.rotation.z,
        })) ?? [],
    };
  });
}
