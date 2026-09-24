import { type BrowserContext, type Page } from "@playwright/test";
import { expect, test, installGameFixture, json } from "./fixtures/game";

const CHANNEL_ID = "artifacts-e2e-channel";
const CHARACTER_ID = "artifacts-e2e-character";
const TASK_ID = "artifacts-e2e-task";

// A transparent 1x1 PNG — served as-is as image artifact content.
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

type ArtifactVersionSeed = {
  version: number;
  content: Buffer;
  filename: string;
  mime: string;
  note?: string;
};

type ArtifactSeed = {
  id: string;
  kind: "document" | "web" | "link" | "image";
  title: string;
  profile: string;
  sourceKind: "chat" | "kanban" | "cron";
  taskId?: string;
  versions: ArtifactVersionSeed[];
};

type FixtureState = {
  artifacts: ArtifactSeed[];
};

function text(content: string, filename: string, mime: string, version = 1): ArtifactVersionSeed {
  return { version, content: Buffer.from(content, "utf8"), filename, mime };
}

function latest(a: ArtifactSeed): ArtifactVersionSeed {
  return a.versions[a.versions.length - 1];
}

function summaryOf(a: ArtifactSeed) {
  const v = latest(a);
  return {
    id: a.id,
    kind: a.kind,
    title: a.title,
    profile: a.profile,
    source_kind: a.sourceKind,
    session_id: "e2e-session",
    task_id: a.taskId ?? null,
    current_version: v.version,
    filename: v.filename,
    mime: v.mime,
    size: v.content.length,
    sha256: `sha-${a.id}-${v.version}`,
    created_at: 1_790_000_000,
    updated_at: 1_790_000_000 + v.version,
  };
}

function detailOf(a: ArtifactSeed) {
  return {
    artifact: summaryOf(a),
    versions: a.versions.map((v) => ({
      version: v.version,
      filename: v.filename,
      mime: v.mime,
      size: v.content.length,
      sha256: `sha-${a.id}-${v.version}`,
      created_by: a.profile,
      captured_via: v.version === 1 ? "tool" : "edit",
      note: v.note,
      created_at: 1_790_000_000 + v.version,
    })),
  };
}

function seedArtifacts(): ArtifactSeed[] {
  return [
    {
      id: "art-md",
      kind: "document",
      title: "프로젝트 메모",
      profile: "sophie",
      sourceKind: "kanban",
      taskId: TASK_ID,
      versions: [text("# 프로젝트 메모\n\n초안입니다.", "notes.md", "text/markdown")],
    },
    {
      id: "art-html",
      kind: "web",
      title: "소개 페이지",
      profile: "sophie",
      sourceKind: "chat",
      versions: [text("<h1>Hello Web</h1>", "page.html", "text/html")],
    },
    {
      id: "art-link",
      kind: "link",
      title: "참고 링크",
      profile: "sophie",
      sourceKind: "chat",
      versions: [text("https://example.com/report\n", "link.txt", "text/plain")],
    },
    {
      id: "art-img",
      kind: "image",
      title: "차트 이미지",
      profile: "sophie",
      sourceKind: "chat",
      versions: [{ version: 1, content: PNG_1PX, filename: "chart.png", mime: "image/png" }],
    },
  ];
}

async function installFixture(
  context: BrowserContext,
  state: FixtureState,
  options: { withKanbanCard?: boolean } = {},
) {
  await installGameFixture(context, {
    channelId: CHANNEL_ID,
    characterId: CHARACTER_ID,
    handle: async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      const method = request.method();
      const root = `/api/channels/${CHANNEL_ID}/artifacts`;

      if (options.withKanbanCard) {
        if (path === `/api/channels/${CHANNEL_ID}/kanban/board` && request.method() === "GET") {
          return json(route, {
            columns: [
              {
                name: "todo",
                tasks: [{ id: TASK_ID, title: "결과물 카드", status: "todo", assignee: "fixture" }],
              },
            ],
            tenants: [],
            assignees: ["fixture"],
            latest_event_id: null,
            now: "2026-09-18T00:00:00Z",
            npcs: [{ npcId: "npc-1", npcName: "Fixture NPC", profileName: "sophie", active: true }],
          });
        }
        if (path === `/api/channels/${CHANNEL_ID}/kanban/tasks/${TASK_ID}` && method === "GET") {
          return json(route, {
            task: { id: TASK_ID, title: "결과물 카드", status: "todo" },
            comments: [],
            events: [],
            attachments: [],
            links: { parents: [], children: [] },
            runs: [],
          });
        }
      }

      if (path === root && method === "GET") {
        const taskId = url.searchParams.get("taskId");
        const items = state.artifacts
          .filter((a) => !taskId || a.taskId === taskId)
          .map(summaryOf)
          .sort((a, b) => b.updated_at - a.updated_at);
        return json(route, { artifacts: items, cursor: "", has_more: false });
      }

      const single = path.match(new RegExp(`^${root}/([^/]+)$`));
      if (single && (method === "GET" || method === "DELETE")) {
        const found = state.artifacts.find((a) => a.id === single[1]);
        if (!found) return json(route, { code: "artifact_not_found", message: "not found" }, 404);
        if (method === "GET") return json(route, detailOf(found));
        if (method === "DELETE") {
          state.artifacts = state.artifacts.filter((a) => a.id !== single[1]);
          return json(route, { ok: true });
        }
      }

      const versions = path.match(new RegExp(`^${root}/([^/]+)/versions$`));
      if (versions && method === "POST") {
        const found = state.artifacts.find((a) => a.id === versions[1]);
        if (!found) return json(route, { code: "artifact_not_found", message: "not found" }, 404);
        const body = request.postDataJSON() as { content: string; filename: string; note?: string };
        const prev = latest(found);
        const nextVersion = prev.version + 1;
        found.versions.push({
          version: nextVersion,
          content: Buffer.from(body.content, "utf8"),
          filename: body.filename,
          mime: prev.mime,
          note: body.note,
        });
        const v = latest(found);
        return json(route, {
          version: {
            version: v.version,
            filename: v.filename,
            mime: v.mime,
            size: v.content.length,
            sha256: `sha-${found.id}-${v.version}`,
            created_by: found.profile,
            captured_via: "edit",
            note: v.note,
            created_at: 1_790_000_000 + v.version,
          },
        });
      }

      const content = path.match(new RegExp(`^${root}/([^/]+)/versions/(\\d+)/content$`));
      if (content && method === "GET") {
        const found = state.artifacts.find((a) => a.id === content[1]);
        const v = found?.versions.find((x) => x.version === Number(content[2]));
        if (!v) return route.fulfill({ status: 404, body: "not found" });
        return route.fulfill({ status: 200, contentType: v.mime, body: v.content });
      }

      return false;
    },
  });
}

async function openGame(page: Page) {
  await page.goto(`/game?channelId=${CHANNEL_ID}`);
  await page.locator("canvas").first().waitFor({ state: "visible" });
}

async function openArtifactsModal(page: Page) {
  await page.getByRole("button", { name: "결과물" }).click();
  const dialog = page.getByRole("dialog", { name: "결과물" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("header artifacts → list, md edit, HTML, link viewer, delete", async ({ context, page }) => {
  const state: FixtureState = { artifacts: seedArtifacts() };
  await installFixture(context, state);
  await openGame(page);

  const dialog = await openArtifactsModal(page);
  const list = dialog.locator("ul > li");
  await expect(list).toHaveCount(4);

  // Open markdown → h1 visible → edit → save as a new version → version 2 selected.
  await dialog.getByRole("button", { name: /프로젝트 메모/ }).click();
  await expect(dialog.locator("h1")).toHaveText("프로젝트 메모");

  await dialog.getByRole("button", { name: "편집" }).click();
  const editorHost = dialog.locator('[data-testid="artifact-editor"]');
  await editorHost.locator(".cm-content").waitFor({ state: "visible" });
  await editorHost.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("# 프로젝트 메모 v2\n\n수정된 내용입니다.");
  await dialog.getByRole("button", { name: "새 버전으로 저장" }).click();

  const versionSelect = dialog.getByLabel("버전");
  await expect(versionSelect).toHaveValue("2");
  await expect(dialog.locator("h1")).toHaveText("프로젝트 메모 v2");

  // At 1440px width the list (left) stays next to the viewer — pick the next item without closing.
  await expect(dialog.locator("ul > li")).toHaveCount(4);
  await dialog.getByRole("button", { name: /소개 페이지/ }).click();
  await expect(dialog.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");

  // Link artifact → check the rel of "open in new tab".
  await dialog.getByRole("button", { name: /참고 링크/ }).click();
  const openLink = dialog.getByRole("link", { name: "새 탭에서 열기" });
  await expect(openLink).toHaveAttribute("rel", "noopener noreferrer");
  await expect(openLink).toHaveAttribute("target", "_blank");

  // Confirm delete → 3 items in the list.
  await dialog.getByRole("button", { name: "삭제" }).click();
  await dialog.getByRole("alertdialog").getByRole("button", { name: "삭제" }).click();
  await expect(dialog.locator("ul > li")).toHaveCount(3);
});

test("the kanban card detail shows an artifacts section", async ({ context, page }) => {
  const state: FixtureState = { artifacts: seedArtifacts() };
  await installFixture(context, state, { withKanbanCard: true });
  await openGame(page);

  await page.getByRole("button", { name: "칸반 보드" }).click();
  await expect(page.getByRole("dialog", { name: "칸반 보드" })).toBeVisible();
  await page.locator(`[data-card-detail="${TASK_ID}"]`).click();

  const drawer = page.getByRole("complementary", { name: "카드 상세" });
  await expect(drawer).toBeVisible();
  const artifactButton = drawer.getByRole("button", { name: /프로젝트 메모/ });
  await expect(artifactButton).toBeVisible();

  // Clicking a card's artifact opens the artifacts modal over the kanban with that artifact selected.
  await artifactButton.click();
  const modal = page.getByRole("dialog", { name: "결과물" });
  await expect(modal).toBeVisible();
  await expect(modal.locator("h1")).toHaveText("프로젝트 메모");
});
