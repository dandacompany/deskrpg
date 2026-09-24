import { type BrowserContext, type Page } from "@playwright/test";
import { expect, test, installGameFixture, json } from "./fixtures/game";

const CHANNEL_ID = "kanban-e2e-channel";
const CHARACTER_ID = "kanban-e2e-character";
const TASK_ID = "kanban-e2e-task";

type TaskStatus =
  | "triage"
  | "todo"
  | "scheduled"
  | "ready"
  | "running"
  | "blocked"
  | "review"
  | "done"
  | "archived";

type FixtureState = {
  status: TaskStatus;
  boardReads: number;
  patchBodies: unknown[];
  patchMode: "success" | "error" | "pending";
  releasePatch?: () => void;
  deleteAfterPatch?: boolean;
  hidden?: boolean;
};

const statuses: TaskStatus[] = [
  "triage",
  "todo",
  "scheduled",
  "ready",
  "running",
  "blocked",
  "review",
  "done",
  "archived",
];

function board(state: FixtureState, includeArchived: boolean) {
  return {
    columns: statuses
      .filter((status) => includeArchived || status !== "archived")
      .map((status) => ({
        name: status,
        tasks:
          status === state.status && !state.hidden
            ? [{ id: TASK_ID, title: "브라우저 이동 카드", status, assignee: "fixture" }]
            : [],
      })),
    tenants: [],
    assignees: ["fixture"],
    latest_event_id: null,
    now: "2026-09-17T00:00:00Z",
    npcs: [{ npcId: "npc-1", npcName: "Fixture NPC", profileName: "fixture", active: true }],
  };
}

async function installFixture(context: BrowserContext, state: FixtureState) {
  await installGameFixture(context, {
    channelId: CHANNEL_ID,
    characterId: CHARACTER_ID,
    handle: async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;

      // The card detail also reads that card's artifacts. A response without a list kills the whole drawer.
      if (path === `/api/channels/${CHANNEL_ID}/artifacts` && request.method() === "GET")
        return json(route, { artifacts: [], cursor: "", has_more: false });
      if (path === `/api/channels/${CHANNEL_ID}/kanban/board` && request.method() === "GET") {
        state.boardReads += 1;
        return json(route, board(state, url.searchParams.get("include_archived") === "true"));
      }
      if (
        path === `/api/channels/${CHANNEL_ID}/kanban/tasks/${TASK_ID}` &&
        request.method() === "GET"
      ) {
        return json(route, {
          task: { id: TASK_ID, title: "브라우저 이동 카드", status: state.status },
          comments: [],
          events: [],
          attachments: [],
          links: { parents: [], children: [] },
          runs: [],
        });
      }
      if (
        path === `/api/channels/${CHANNEL_ID}/kanban/tasks/${TASK_ID}` &&
        request.method() === "PATCH"
      ) {
        const body = request.postDataJSON() as { status: TaskStatus };
        state.patchBodies.push(body);
        if (state.patchMode === "error") {
          return json(route, { code: "fixture_failure", message: "fixture move failed" }, 500);
        }
        if (state.patchMode === "pending") {
          await new Promise<void>((resolve) => (state.releasePatch = resolve));
        }
        state.status = body.status;
        if (state.deleteAfterPatch) state.hidden = true;
        return json(route, {
          task: { id: TASK_ID, title: "브라우저 이동 카드", status: body.status },
        });
      }
      return false;
    },
  });
}

async function openBoard(page: Page) {
  await page.goto(`/game?channelId=${CHANNEL_ID}`);
  await page.getByRole("button", { name: "칸반 보드" }).click();
  await expect(page.getByRole("dialog", { name: "칸반 보드" })).toBeVisible();
  await expect(page.locator(`[data-card-move-handle="${TASK_ID}"]`)).toBeVisible();
}

async function drag(page: Page, target: string | { x: number; y: number }) {
  const handle = page.locator(`[data-card-move-handle="${TASK_ID}"]`);
  const from = await handle.boundingBox();
  expect(from).not.toBeNull();
  const point =
    typeof target === "string"
      ? await page.locator(`[data-column="${target}"]`).boundingBox()
      : { ...target, width: 0, height: 0 };
  expect(point).not.toBeNull();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await page.mouse.down();
  await page.mouse.move(point!.x + point!.width / 2, point!.y + Math.min(80, point!.height / 2), {
    steps: 8,
  });
  return { handle, point: { x: point!.x + point!.width / 2, y: point!.y + 40 } };
}

test("mouse drag highlights an empty column and waits for server truth before moving", async ({
  context,
  page,
}) => {
  const state: FixtureState = {
    status: "todo",
    boardReads: 0,
    patchBodies: [],
    patchMode: "pending",
  };
  await installFixture(context, state);
  await openBoard(page);

  const source = page.locator('[data-column="todo"]');
  const target = page.locator('[data-column="scheduled"]');
  const { point } = await drag(page, "scheduled");
  await expect(target).toHaveAttribute("data-move-target", "true");
  await page.mouse.up();

  await expect(page.locator('[data-move-status="pending"]')).toContainText("브라우저 이동 카드");
  await expect(source).toContainText("브라우저 이동 카드");
  await expect(target).not.toContainText("브라우저 이동 카드");
  expect(state.patchBodies).toEqual([{ status: "scheduled" }]);

  state.releasePatch?.();
  await expect(target).toContainText("브라우저 이동 카드");
  await expect(page.locator('[data-move-status="success"]')).toBeVisible();
  await expect(page.locator(`[data-card-move-handle="${TASK_ID}"]`)).toBeFocused();
  expect(state.boardReads).toBeGreaterThanOrEqual(2);
  expect(point.x).toBeGreaterThan(0);
});

test("successful move focuses the board fallback when the authoritative card disappeared", async ({
  context,
  page,
}) => {
  const state: FixtureState = {
    status: "todo",
    boardReads: 0,
    patchBodies: [],
    patchMode: "success",
    deleteAfterPatch: true,
  };
  await installFixture(context, state);
  await openBoard(page);
  const handle = page.locator(`[data-card-move-handle="${TASK_ID}"]`);
  await handle.focus();
  await handle.press("Space");
  await handle.press("ArrowRight");
  await handle.press("Enter");
  await expect(page.locator('[data-move-status="success"]')).toBeVisible();
  await expect(page.locator("[data-kanban-board-root]")).toBeFocused();
  expect(state.patchBodies).toEqual([{ status: "scheduled" }]);
});

test("keyboard movement, detail click, Escape, same-column and outside drops stay separate", async ({
  context,
  page,
}) => {
  const state: FixtureState = {
    status: "todo",
    boardReads: 0,
    patchBodies: [],
    patchMode: "success",
  };
  await installFixture(context, state);
  await openBoard(page);

  await page.locator(`[data-card-detail="${TASK_ID}"]`).click();
  await expect(page.locator("#kanban-status")).toHaveValue("todo");
  await page
    .getByRole("complementary", { name: "카드 상세" })
    .getByRole("button", { name: "닫기" })
    .click();
  expect(state.patchBodies).toEqual([]);

  const handle = page.locator(`[data-card-move-handle="${TASK_ID}"]`);
  await handle.focus();
  await handle.press("Space");
  await handle.press("ArrowRight");
  await expect(page.locator('[data-column="scheduled"]')).toHaveAttribute(
    "data-move-target",
    "true",
  );
  await handle.press("Escape");
  await expect(handle).toBeFocused();
  expect(state.patchBodies).toEqual([]);

  await handle.press("Space");
  await handle.press("ArrowLeft");
  await handle.press("ArrowRight");
  await handle.press("Enter");
  expect(state.patchBodies).toEqual([]);

  const outside = await drag(page, { x: 2, y: 2 });
  await page.mouse.move(outside.point.x, outside.point.y);
  await page.mouse.up();
  expect(state.patchBodies).toEqual([]);

  await handle.press("Space");
  await handle.press("ArrowRight");
  await handle.press("Enter");
  await expect(page.locator('[data-column="scheduled"]')).toContainText("브라우저 이동 카드");
  expect(state.patchBodies).toEqual([{ status: "scheduled" }]);
});

test("horizontal edge scrolling reaches an initially offscreen target and server errors keep source truth", async ({
  context,
  page,
}) => {
  const state: FixtureState = {
    status: "todo",
    boardReads: 0,
    patchBodies: [],
    patchMode: "error",
  };
  await installFixture(context, state);
  await openBoard(page);

  const scroller = page.locator(".overflow-x-auto").filter({ has: page.locator("[data-column]") });
  const before = await scroller.evaluate((el) => el.scrollLeft);
  const handle = page.locator(`[data-card-move-handle="${TASK_ID}"]`);
  const box = await handle.boundingBox();
  const bounds = await scroller.boundingBox();
  expect(box).not.toBeNull();
  expect(bounds).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  for (let i = 0; i < 18; i++) {
    await page.mouse.move(bounds!.x + bounds!.width - 2, box!.y + 40, { steps: 2 });
  }
  await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBeGreaterThan(before);
  const done = page.locator('[data-column="done"]');
  await done.scrollIntoViewIfNeeded();
  const doneBox = await done.boundingBox();
  await page.mouse.move(doneBox!.x + doneBox!.width / 2, doneBox!.y + 60, { steps: 5 });
  await expect(done).toHaveAttribute("data-move-target", "true");
  await page.mouse.up();

  await expect(page.locator('[data-move-status="error"]')).toContainText("fixture move failed");
  await expect(page.locator('[data-column="todo"]')).toContainText("브라우저 이동 카드");
  expect(state.patchBodies).toEqual([{ status: "done" }]);
});

test("archived filtering and fixed column order remain intact", async ({ context, page }) => {
  const state: FixtureState = {
    status: "todo",
    boardReads: 0,
    patchBodies: [],
    patchMode: "success",
  };
  await installFixture(context, state);
  await openBoard(page);
  await expect(page.locator("[data-column]")).toHaveCount(8);
  expect(
    await page
      .locator("[data-column]")
      .evaluateAll((columns) => columns.map((column) => column.getAttribute("data-column"))),
  ).toEqual(["triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done"]);
  await page.getByLabel("보관함 보기").check();
  await expect(page.locator('[data-column="archived"]')).toBeVisible();
});

test.describe("touch emulation", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test("an emulated touch-pointer sequence drops onto an empty column", async ({
    context,
    page,
  }) => {
    const state: FixtureState = {
      status: "todo",
      boardReads: 0,
      patchBodies: [],
      patchMode: "success",
    };
    await installFixture(context, state);
    await openBoard(page);
    await page
      .locator(".overflow-x-auto")
      .filter({ has: page.locator("[data-column]") })
      .evaluate((element) => element.scrollTo({ left: 260 }));
    const handleLocator = page.locator(`[data-card-move-handle="${TASK_ID}"]`);
    const handle = await handleLocator.boundingBox();
    const target = await page.locator('[data-column="scheduled"]').boundingBox();
    expect(handle).not.toBeNull();
    expect(target).not.toBeNull();
    const start = { x: handle!.x + handle!.width / 2, y: handle!.y + handle!.height / 2 };
    const end = { x: target!.x + target!.width / 2, y: target!.y + 60 };
    await handleLocator.dispatchEvent("pointerdown", {
      pointerId: 1,
      pointerType: "touch",
      isPrimary: true,
      button: 0,
      buttons: 1,
      clientX: start.x,
      clientY: start.y,
    });
    for (let step = 1; step <= 6; step++) {
      await handleLocator.dispatchEvent("pointermove", {
        pointerId: 1,
        pointerType: "touch",
        isPrimary: true,
        button: -1,
        buttons: 1,
        clientX: start.x + ((end.x - start.x) * step) / 6,
        clientY: start.y + ((end.y - start.y) * step) / 6,
      });
    }
    await expect(page.locator('[data-column="scheduled"]')).toHaveAttribute(
      "data-move-target",
      "true",
    );
    await handleLocator.dispatchEvent("pointerup", {
      pointerId: 1,
      pointerType: "touch",
      isPrimary: true,
      button: 0,
      buttons: 0,
      clientX: end.x,
      clientY: end.y,
    });
    await expect(page.locator('[data-column="scheduled"]')).toContainText("브라우저 이동 카드");
    expect(state.patchBodies).toEqual([{ status: "scheduled" }]);
  });
});
