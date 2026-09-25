import "../test-setup/dom";

import assert from "node:assert/strict";
import test from "node:test";

import { act } from "react";
import { createRoot } from "react-dom/client";

import { I18nProvider } from "@/lib/i18n";
import type { RoomState } from "@/app/game/room-state";
import type { RoomSummary } from "@/lib/chat-rooms-policy";
import type { ReportItem } from "@/game/report-queue";
import ChatPanel from "./ChatPanel";
import ReportBadge from "./report/ReportBadge";
import { tabFor } from "./chat/npc-tab-state";
import { openCardTarget } from "./kanban/open-card-target";

function room(id: string, kind: RoomSummary["kind"], name: string): RoomSummary {
  return {
    id,
    kind,
    name,
    replyPolicy: kind === "office" ? "mention" : "members",
    createdBy: "u1",
    lastMessageAt: null,
    members: [],
  };
}

function listState(): RoomState {
  return {
    rooms: [room("office", "office", "사무실"), room("g1", "group", "기획팀")],
    viewerUserId: "u1",
    currentRoomId: "g1",
    view: "list",
    messages: {},
  };
}

// A skeleton filled with only the required props. Verifies just the list view's close behavior.
function panel(roomState: RoomState, props: Partial<React.ComponentProps<typeof ChatPanel>> = {}) {
  return (
    <I18nProvider initialLocale="ko">
      <ChatPanel
        dialogNpc={null}
        npcMessages={[]}
        isNpcStreaming={false}
        onSend={() => {}}
        onClose={() => {}}
        npcSelectList={null}
        onSelectNpc={() => {}}
        roomState={roomState}
        onRoomSend={() => {}}
        onRoomAction={() => {}}
        onRoomCreate={() => {}}
        onRoomInvite={() => {}}
        onRoomLeave={() => {}}
        onRoomRename={() => {}}
        onRoomDelete={() => {}}
        mentionCandidatesFor={() => []}
        onlinePlayers={[]}
        {...props}
      />
    </I18nProvider>
  );
}

async function mount(node: React.ReactElement): Promise<HTMLElement> {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(node);
  });
  return el;
}

function buttonByText(el: HTMLElement, text: string): HTMLButtonElement {
  const btn = Array.from(el.querySelectorAll("button")).find(
    (b) => (b.textContent ?? "").trim() === text,
  );
  assert.ok(btn, `button "${text}" 를 찾지 못했다`);
  return btn as HTMLButtonElement;
}

async function click(node: Element) {
  await act(async () => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

const OPEN = "▶"; // ▶ reopen
const BACK = "◀"; // ◀ back

test("in a multi-room list view, ◀ collapses the panel (I-2)", async () => {
  const el = await mount(panel(listState()));

  // Starts closed, showing only the reopen button.
  await click(buttonByText(el, OPEN));

  // The panel opens and the list header's ◀ appears.
  const back = buttonByText(el, BACK);
  await click(back);

  // Even with 2 rooms, the list's ◀ must close the panel — only the reopen button should remain.
  const reopen = Array.from(el.querySelectorAll("button")).filter(
    (b) => (b.textContent ?? "").trim() === OPEN,
  );
  assert.equal(reopen.length, 1, "패널이 접혀 다시 열기 버튼만 남아야 한다");
  assert.equal(
    Array.from(el.querySelectorAll("button")).some((b) => (b.textContent ?? "").trim() === BACK),
    false,
    "접힌 패널에는 ◀ 가 없어야 한다",
  );
});

test("shared room shows responder receipt under another user's source message", async () => {
  const state: RoomState = {
    ...listState(),
    view: "room",
    messages: {
      g1: [
        {
          id: "source-other",
          roomId: "g1",
          senderKind: "user",
          senderId: "u2",
          senderName: "Other",
          content: "@Sophie help",
          createdAt: "2026-09-10T00:00:00Z",
        },
      ],
    },
  };
  const el = await mount(
    <I18nProvider>
      <ChatPanel
        dialogNpc={null}
        npcMessages={[]}
        isNpcStreaming={false}
        onSend={() => {}}
        onClose={() => {}}
        npcSelectList={null}
        onSelectNpc={() => {}}
        roomState={state}
        channelChatOpen
        roomResponses={[
          {
            requestId: "reply",
            sourceMessageId: "source-other",
            npcId: "n1",
            npcName: "Sophie",
            status: "thinking",
            content: "",
            updatedAt: 1,
          },
        ]}
        onRoomSend={() => {}}
        onRoomAction={() => {}}
        onRoomCreate={() => {}}
        onRoomInvite={() => {}}
        onRoomLeave={() => {}}
        onRoomRename={() => {}}
        onRoomDelete={() => {}}
        mentionCandidatesFor={() => []}
        onlinePlayers={[]}
        currentPlayerName="Me"
      />
    </I18nProvider>,
  );
  assert.match(el.textContent ?? "", /👌 Sophie/);
});

test("workspace presentation stays open and renders as an embedded conversation surface", async () => {
  const el = await mount(
    <I18nProvider>
      <ChatPanel
        presentation="workspace"
        width={388}
        dialogNpc={null}
        npcMessages={[]}
        isNpcStreaming={false}
        onSend={() => {}}
        onClose={() => {}}
        npcSelectList={null}
        onSelectNpc={() => {}}
        roomState={listState()}
        onRoomSend={() => {}}
        onRoomAction={() => {}}
        onRoomCreate={() => {}}
        onRoomInvite={() => {}}
        onRoomLeave={() => {}}
        onRoomRename={() => {}}
        onRoomDelete={() => {}}
        mentionCandidatesFor={() => []}
        onlinePlayers={[]}
      />
    </I18nProvider>,
  );

  const panel = el.querySelector<HTMLElement>("[data-chat-panel='workspace']");
  assert.ok(panel);
  assert.equal(panel.style.width, "388px");
  assert.doesNotMatch(panel.className, /fixed/);
  assert.equal(
    [...el.querySelectorAll("button")].some((node) => node.textContent?.trim() === OPEN),
    false,
  );
});

// ---------------------------------------------------------------------------
// T9 — NPC DM's cron tab
// ---------------------------------------------------------------------------

function dmState(): RoomState {
  return { ...listState(), view: "room" };
}

test("with no cron context, the NPC DM has no tabs (same as pre-wiring behavior)", async () => {
  const el = await mount(
    <I18nProvider initialLocale="ko">
      <ChatPanel
        dialogNpc={{ npcId: "npc-a", npcName: "소피" }}
        npcMessages={[]}
        isNpcStreaming={false}
        onSend={() => {}}
        onClose={() => {}}
        npcSelectList={null}
        onSelectNpc={() => {}}
        roomState={dmState()}
        onRoomSend={() => {}}
        onRoomAction={() => {}}
        onRoomCreate={() => {}}
        onRoomInvite={() => {}}
        onRoomLeave={() => {}}
        onRoomRename={() => {}}
        onRoomDelete={() => {}}
        mentionCandidatesFor={() => []}
        onlinePlayers={[]}
      />
    </I18nProvider>,
  );
  assert.equal(el.querySelector('[data-testid="npc-dialog-tabs"]'), null);
  assert.equal(el.querySelector('[data-testid="cron-panel"]'), null);
});

test("with a cron context, the 'cron' tab opens single-mode for just that NPC (R15)", async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(typeof input === "string" ? input : input.toString());
    return new Response(JSON.stringify({ jobs: [], timezone: "Asia/Seoul" }), { status: 200 });
  }) as typeof fetch;
  try {
    const el = await mount(
      <I18nProvider initialLocale="ko">
        <ChatPanel
          dialogNpc={{ npcId: "npc-a", npcName: "소피" }}
          npcMessages={[]}
          isNpcStreaming={false}
          onSend={() => {}}
          onClose={() => {}}
          npcSelectList={null}
          onSelectNpc={() => {}}
          roomState={dmState()}
          onRoomSend={() => {}}
          onRoomAction={() => {}}
          onRoomCreate={() => {}}
          onRoomInvite={() => {}}
          onRoomLeave={() => {}}
          onRoomRename={() => {}}
          onRoomDelete={() => {}}
          mentionCandidatesFor={() => []}
          onlinePlayers={[]}
          cron={{ channelId: "ch1" }}
        />
      </I18nProvider>,
    );
    const tabs = el.querySelector('[data-testid="npc-dialog-tabs"]');
    assert.ok(tabs, "탭 바가 있어야 한다");
    // Chat is the default tab — cron isn't fetched yet.
    assert.equal(el.querySelector('[data-testid="cron-panel"]'), null);
    assert.equal(urls.length, 0);

    await click(buttonByText(el, "크론"));
    await act(async () => {
      await Promise.resolve();
    });
    assert.ok(el.querySelector('[data-testid="cron-panel"]'));
    assert.equal(
      el.querySelector('[data-testid="cron-filter-npc"]'),
      null,
      "단일 모드는 필터 없음",
    );
    assert.deepEqual(urls, ["/api/channels/ch1/cron/jobs?npcId=npc-a"]);

    // Returning to the chat tab makes the input box visible again.
    await click(buttonByText(el, "대화"));
    assert.equal(el.querySelector('[data-testid="cron-panel"]'), null);
    assert.ok(el.querySelector("textarea"), "대화 입력창");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// R29/R30: only a line with `notice` goes to the notice renderer; a line without it renders as before (system lines included).
test("room messages — the notice renderer when notice is present, the existing render otherwise", async () => {
  const opened: string[] = [];
  const state: RoomState = {
    ...listState(),
    view: "room",
    messages: {
      g1: [
        {
          id: "plain-npc",
          roomId: "g1",
          senderKind: "npc",
          senderId: "n1",
          senderName: "Sophie",
          content: "plain npc line",
          createdAt: "2026-09-10T00:00:00Z",
        },
        {
          id: "plain-system",
          roomId: "g1",
          senderKind: "system",
          senderId: null,
          senderName: "",
          content: JSON.stringify({ kind: "left", name: "Other" }),
          createdAt: "2026-09-10T00:00:01Z",
        },
        {
          id: "notice-card",
          roomId: "g1",
          senderKind: "system",
          senderId: null,
          senderName: "Sophie",
          content: "Sophie: 주간 보고서",
          createdAt: "2026-09-10T00:00:02Z",
          notice: {
            kind: "card_done",
            cardId: "card-1",
            cardTitle: "주간 보고서",
            boardSlug: "b",
            npcName: "Sophie",
          },
        },
      ],
    },
  };
  const el = await mount(
    <I18nProvider initialLocale="ko">
      <ChatPanel
        dialogNpc={null}
        npcMessages={[]}
        isNpcStreaming={false}
        onSend={() => {}}
        onClose={() => {}}
        npcSelectList={null}
        onSelectNpc={() => {}}
        roomState={state}
        channelChatOpen
        onRoomSend={() => {}}
        onRoomAction={() => {}}
        onRoomCreate={() => {}}
        onRoomInvite={() => {}}
        onRoomLeave={() => {}}
        onRoomRename={() => {}}
        onRoomDelete={() => {}}
        mentionCandidatesFor={() => []}
        onlinePlayers={[]}
        currentPlayerName="Me"
        onOpenNoticeCard={(cardId) => opened.push(cardId)}
      />
    </I18nProvider>,
  );
  // An NPC line with no notice stays a plain bubble.
  assert.ok(
    Array.from(el.querySelectorAll('[data-chat-bubble="npc"]')).some((b) =>
      (b.textContent ?? "").includes("plain npc line"),
    ),
    "일반 NPC 줄이 말풍선으로 남아야 한다",
  );
  // A system line with no notice uses the existing system sentence.
  assert.match(el.textContent ?? "", /Other 님이 나갔습니다/);
  // A line with notice goes through the notice renderer — a locale sentence, not the content's prefix.
  const notice = el.querySelector('[data-room-notice="card_done"]');
  assert.ok(notice, "알림 렌더러가 그리지 않았다");
  assert.match(notice!.textContent ?? "", /카드를 완료했습니다: 주간 보고서/);
  assert.doesNotMatch(el.textContent ?? "", /Sophie: 주간 보고서/);
  await click(buttonByText(el, "카드 열기"));
  assert.deepEqual(opened, ["card-1"]);
});

function npcDialog(props: {
  npcArtifactChips?: Array<{ artifactId: string; title: string }>;
  onOpenArtifact?: (artifactId: string) => void;
}) {
  return (
    <I18nProvider initialLocale="ko">
      <ChatPanel
        dialogNpc={{ npcId: "npc-a", npcName: "소피" }}
        npcMessages={[
          { id: "m1", role: "player", content: "대시보드 만들어 줘" },
          { id: "m2", role: "npc", content: "만들었습니다" },
        ]}
        isNpcStreaming={false}
        onSend={() => {}}
        onClose={() => {}}
        npcSelectList={null}
        onSelectNpc={() => {}}
        roomState={dmState()}
        onRoomSend={() => {}}
        onRoomAction={() => {}}
        onRoomCreate={() => {}}
        onRoomInvite={() => {}}
        onRoomLeave={() => {}}
        onRoomRename={() => {}}
        onRoomDelete={() => {}}
        mentionCandidatesFor={() => []}
        onlinePlayers={[]}
        {...props}
      />
    </I18nProvider>
  );
}

test("draws an NPC's artifact chip under the last NPC reply, and clicking it calls onOpenArtifact", async () => {
  const opened: string[] = [];
  const el = await mount(
    npcDialog({
      npcArtifactChips: [{ artifactId: "a1", title: "대시보드" }],
      onOpenArtifact: (id) => void opened.push(id),
    }),
  );
  const chip = buttonByText(el, "결과물 저장됨: 대시보드");
  // Comes after the last NPC reply.
  const answer = Array.from(el.querySelectorAll("*")).find(
    (node) => node.children.length === 0 && node.textContent === "만들었습니다",
  );
  assert.ok(answer);
  assert.ok(answer.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING);
  await click(chip);
  assert.deepEqual(opened, ["a1"]);
});

test("draws no chip when there's no chip or no onOpenArtifact", async () => {
  const el = await mount(
    npcDialog({ npcArtifactChips: [{ artifactId: "a1", title: "대시보드" }] }),
  );
  assert.equal(
    Array.from(el.querySelectorAll("button")).some((b) =>
      (b.textContent ?? "").startsWith("결과물 저장됨"),
    ),
    false,
  );
});

// ── Avatars ────────────────────────────────────────────────────────────────────

function avatarPanel(roomState: RoomState, extra: Record<string, unknown> = {}) {
  const asked: Array<{ kind: string; id?: string | null; name: string }> = [];
  const node = (
    <I18nProvider>
      <ChatPanel
        dialogNpc={null}
        npcMessages={[]}
        isNpcStreaming={false}
        onSend={() => {}}
        onClose={() => {}}
        npcSelectList={null}
        onSelectNpc={() => {}}
        roomState={roomState}
        channelChatOpen
        currentPlayerName="단테"
        onRoomSend={() => {}}
        onRoomAction={() => {}}
        onRoomCreate={() => {}}
        onRoomInvite={() => {}}
        onRoomLeave={() => {}}
        onRoomRename={() => {}}
        onRoomDelete={() => {}}
        mentionCandidatesFor={() => []}
        onlinePlayers={[]}
        avatarFor={(who) => {
          asked.push(who);
          return null;
        }}
        {...extra}
      />
    </I18nProvider>
  );
  return { node, asked };
}

function roomMessage(id: string, kind: "user" | "npc", senderId: string, senderName: string) {
  return {
    id,
    roomId: "g1",
    senderKind: kind,
    senderId,
    senderName,
    content: `${senderName} 의 말 ${id}`,
    createdAt: "2026-09-20T00:00:00.000Z",
  };
}

test("room bubbles — avatar only for others, and just a spacer when the same speaker continues", async () => {
  const state: RoomState = {
    rooms: [room("g1", "group", "기획팀")],
    viewerUserId: "u1",
    currentRoomId: "g1",
    view: "room",
    messages: {
      g1: [
        roomMessage("m1", "npc", "npc-noah", "noah"),
        roomMessage("m2", "npc", "npc-noah", "noah"),
        roomMessage("m3", "user", "u1", "단테"),
        roomMessage("m4", "npc", "npc-sophie", "sophie"),
      ],
    },
  };
  const { node, asked } = avatarPanel(state);
  const el = await mount(node);
  const slots = [...el.querySelectorAll("[data-chat-avatar]")].map((n) =>
    n.getAttribute("data-chat-avatar"),
  );
  assert.deepEqual(
    slots,
    ["shown", "spacer", "shown"],
    "noah·(noah 이어서)·sophie — 내 말에는 없다",
  );
  assert.ok(
    asked.some((who) => who.kind === "npc" && who.id === "npc-noah"),
    "발화자 id 로 외형을 묻는다",
  );
});

test("NPC DM — an avatar appears before the header name and on the other party's bubbles", async () => {
  const state: RoomState = {
    rooms: [room("office", "office", "오피스")],
    viewerUserId: "u1",
    currentRoomId: "office",
    view: "room",
    messages: {},
  };
  const { node, asked } = avatarPanel(state, {
    dialogNpc: { npcId: "npc-noah", npcName: "noah" },
    npcMessages: [
      { id: "a", role: "player", content: "안녕" },
      { id: "b", role: "npc", content: "안녕하세요" },
      { id: "c", role: "npc", content: "무엇을 도울까요" },
    ],
  });
  const el = await mount(node);
  assert.ok(el.querySelector("[data-chat-header-avatar]"), "DM 헤더에 아바타가 없다");
  const slots = [...el.querySelectorAll("[data-chat-avatar]")].map((n) =>
    n.getAttribute("data-chat-avatar"),
  );
  assert.deepEqual(slots, ["shown", "spacer"]);
  assert.ok(asked.every((who) => who.id === "npc-noah"));
});

test("room header — stacks up to 5 participants and shows the rest as +N", async () => {
  const members = Array.from({ length: 7 }, (_, i) => ({
    kind: "npc" as const,
    id: `npc-${i}`,
    name: `직원${i}`,
  }));
  const state: RoomState = {
    rooms: [{ ...room("g1", "group", "기획팀"), members }],
    viewerUserId: "u1",
    currentRoomId: "g1",
    view: "room",
    messages: {},
  };
  const { node } = avatarPanel(state);
  const el = await mount(node);
  const stack = el.querySelector("[data-room-avatars]");
  assert.ok(stack, "방 헤더에 아바타 묶음이 없다");
  assert.equal(stack.querySelectorAll("[data-room-avatar]").length, 5);
  assert.equal(stack.querySelector("[data-room-avatar-more]")?.textContent, "+2");
});

test("draws no avatar when avatarFor is absent — same as the existing screen", async () => {
  const state: RoomState = {
    rooms: [room("g1", "group", "기획팀")],
    viewerUserId: "u1",
    currentRoomId: "g1",
    view: "room",
    messages: { g1: [roomMessage("m1", "npc", "npc-noah", "noah")] },
  };
  const { node } = avatarPanel(state, { avatarFor: undefined });
  const el = await mount(node);
  assert.equal(el.querySelector("[data-chat-avatar]"), null);
  assert.equal(el.querySelector("[data-room-avatars]"), null);
});

// ---------------------------------------------------------------------------
// T6 — Cards tab wiring and badges
// ---------------------------------------------------------------------------

function cardsPanel(
  extra: Partial<React.ComponentProps<typeof ChatPanel>> = {},
): React.ReactElement {
  return (
    <I18nProvider initialLocale="ko">
      <ChatPanel
        dialogNpc={{ npcId: "npc-a", npcName: "소피" }}
        npcMessages={[]}
        isNpcStreaming={false}
        onSend={() => {}}
        onClose={() => {}}
        npcSelectList={null}
        onSelectNpc={() => {}}
        roomState={dmState()}
        onRoomSend={() => {}}
        onRoomAction={() => {}}
        onRoomCreate={() => {}}
        onRoomInvite={() => {}}
        onRoomLeave={() => {}}
        onRoomRename={() => {}}
        onRoomDelete={() => {}}
        mentionCandidatesFor={() => []}
        onlinePlayers={[]}
        cron={{ channelId: "ch1" }}
        {...extra}
      />
    </I18nProvider>
  );
}

/** Tests in this block only check the tab row — stub the fetch that opening a tab triggers with an empty response. */
async function withStubbedFetch<T>(run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ columns: [], npcs: [], jobs: [] }), {
      status: 200,
    })) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("there are five tabs (chat/cron/cards/skills/connectors)", async () => {
  const el = await mount(cardsPanel());
  const tabs = [...el.querySelectorAll('[data-testid="npc-dialog-tabs"] [role="tab"]')];
  assert.deepEqual(
    tabs.map((tab) => tab.getAttribute("data-tab")),
    ["chat", "cron", "cards", "skills", "connectors"],
  );
});

test("the unread count shows as a badge, and there's no badge when it's 0", async () => {
  const el = await mount(cardsPanel({ badges: { cards: 3, cron: 0 } }));
  assert.equal(el.querySelector('[data-badge="cards"]')?.textContent, "3");
  assert.equal(el.querySelector('[data-badge="cron"]'), null);
});

test("opening a tab records that tab's view — the chat tab is not recorded", async () => {
  await withStubbedFetch(async () => {
    const posted: string[] = [];
    const el = await mount(cardsPanel({ onMarkSeen: (tab) => posted.push(tab) }));
    await click(el.querySelector('[role="tab"][data-tab="cards"]')!);
    assert.deepEqual(posted, ["cards"]);
    await click(el.querySelector('[role="tab"][data-tab="chat"]')!);
    assert.deepEqual(posted, ["cards"]);
  });
});

test("the cards tab fetches the board, draws assigned cards, and clicking one targets that card", async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(typeof input === "string" ? input : input.toString());
    return new Response(
      JSON.stringify({
        columns: [
          {
            status: "todo",
            tasks: [
              { id: "t1", title: "주간 보고서", status: "todo", assignee: "sophie" },
              { id: "t2", title: "남의 것", status: "todo", assignee: "noah" },
            ],
          },
        ],
        npcs: [{ npcId: "npc-a", npcName: "소피", profileName: "sophie", active: true }],
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  try {
    const opened: string[] = [];
    const el = await mount(cardsPanel({ onOpenAssignedCard: (taskId) => opened.push(taskId) }));
    await click(el.querySelector('[role="tab"][data-tab="cards"]')!);
    await act(async () => {
      await Promise.resolve();
    });
    assert.deepEqual(urls, ["/api/channels/ch1/kanban/board"]);
    const cards = el.querySelectorAll('[data-testid="npc-cards-tab"] [data-card-id]');
    assert.equal(cards.length, 1, "담당 카드만 보여야 한다");
    await click(cards[0]);
    assert.deepEqual(opened, ["t1"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("when the board fetch is blocked, the server's code is passed through to the cards tab as-is", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ code: "board_unavailable", message: "not ready" }), {
      status: 503,
    })) as typeof fetch;
  try {
    const el = await mount(cardsPanel());
    await click(el.querySelector('[role="tab"][data-tab="cards"]')!);
    await act(async () => {
      await Promise.resolve();
    });
    const alert = el.querySelector('[data-testid="cards-error"]');
    assert.ok(alert, "게이트 안내가 보이지 않는다");
    // The `board_unavailable`-specific copy — must not fall back to the generic ("unknown error") message.
    assert.match(alert.textContent ?? "", /보드/);
    assert.equal(el.querySelector('[data-testid="cards-empty"]'), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("switching employees returns the tab to chat", () => {
  // Doesn't break the existing behavior (tab selection is tied to npcId).
  assert.equal(tabFor({ npcId: "n1", tab: "cards" }, "n2"), "chat");
  assert.equal(tabFor({ npcId: "n1", tab: "cards" }, "n1"), "cards");
});

test("a closed board targets via initialTaskId, an open board via focusRequest", () => {
  const closed = openCardTarget({ boardOpen: false, taskId: "t1" });
  assert.equal(closed.initialTaskId, "t1");
  assert.equal(closed.focusRequest, null);
  const open = openCardTarget({ boardOpen: true, taskId: "t1", prev: closed });
  assert.equal(open.initialTaskId, null);
  assert.equal(open.focusRequest?.taskId, "t1");
  // Clicking the same card again is still a new request — seq rises.
  assert.equal(openCardTarget({ boardOpen: true, taskId: "t1", prev: open }).focusRequest?.seq, 2);
});

// ---------------------------------------------------------------------------
// Card proposal resolution wiring (T7)
// ---------------------------------------------------------------------------

function proposalState(): RoomState {
  return {
    ...listState(),
    view: "room",
    messages: {
      g1: [
        {
          id: "notice-proposal",
          roomId: "g1",
          senderKind: "npc",
          senderId: "n1",
          senderName: "소피",
          content: "청구서 정리",
          createdAt: "2026-09-21T00:00:00Z",
          notice: {
            kind: "card_proposal",
            proposalId: "cp_1",
            title: "청구서 정리",
            summary: "세 단계짜리 일입니다",
            npcId: "n1",
            npcName: "소피",
          },
        },
      ],
    },
  };
}

function proposalPanel(opts: { onRoomSend?: (message: string) => void } = {}) {
  return (
    <I18nProvider initialLocale="ko">
      <ChatPanel
        dialogNpc={null}
        npcMessages={[]}
        isNpcStreaming={false}
        onSend={() => {}}
        onClose={() => {}}
        npcSelectList={null}
        onSelectNpc={() => {}}
        roomState={proposalState()}
        channelChatOpen
        onRoomSend={opts.onRoomSend ?? (() => {})}
        onRoomAction={() => {}}
        onRoomCreate={() => {}}
        onRoomInvite={() => {}}
        onRoomLeave={() => {}}
        onRoomRename={() => {}}
        onRoomDelete={() => {}}
        mentionCandidatesFor={() => []}
        onlinePlayers={[]}
        cron={{ channelId: "ch-1" }}
      />
    </I18nProvider>
  );
}

test("proposal notice — the register button calls the resolve route and shows the decision on success", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: String(init?.body ?? "") });
    return new Response(JSON.stringify({ choice: "card", taskId: "t-9", assigneeDropped: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const el = await mount(proposalPanel());
    const register = buttonByText(el, "이슈카드등록");
    assert.equal(register.disabled, false);
    await click(register);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/api/channels/ch-1/kanban/proposals/cp_1/resolve");
    assert.deepEqual(JSON.parse(calls[0].body), { choice: "card" });
    // The decision is shown and the button disappears — down to the card number.
    assert.equal(el.querySelectorAll("[data-testid='card-proposal'] button").length, 0);
    assert.match(el.querySelector("[data-testid='card-proposal-resolved']")!.textContent!, /t-9/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("proposal notice — 'handle here' sends a follow-up message naming that employee in the same room", async () => {
  const originalFetch = globalThis.fetch;
  const sent: string[] = [];
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choice: "inline" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    const el = await mount(proposalPanel({ onRoomSend: (message) => sent.push(message) }));
    await click(buttonByText(el, "여기서 처리"));
    assert.equal(sent.length, 1);
    assert.match(sent[0], /^@\[소피\] /);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("proposal notice — a 409 from the server shows guidance and leaves the button in place", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ code: "already_resolved", message: "already" }), {
      status: 409,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    const el = await mount(proposalPanel());
    await click(buttonByText(el, "이슈카드등록"));
    const error = el.querySelector("[data-testid='card-proposal-error']");
    assert.ok(error);
    assert.doesNotMatch(error.textContent!, /already_resolved/);
    // The button remains so it can be chosen again.
    assert.equal(el.querySelectorAll("[data-testid='card-proposal'] button").length, 2);
    assert.equal(buttonByText(el, "이슈카드등록").disabled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// The cards tab list refreshes on `kanban:event` — eliminates the state where only the badge rises while the list goes stale.
// ---------------------------------------------------------------------------

/** A mount that can rerender with changed props. Simulates the tick the wiring raises. */
async function mountRerender(
  node: React.ReactElement,
): Promise<{ el: HTMLElement; render: (next: React.ReactElement) => Promise<void> }> {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(node);
  });
  return {
    el,
    render: async (next) => {
      await act(async () => {
        root.render(next);
      });
    },
  };
}

/** Waits for the debounce to pass and the fetch after it to finish. */
async function settle(ms: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** A fetch that returns a board with assigned-card `titles`. Collects the called URLs. */
function boardFetch(titlesByCall: string[][]): { urls: string[]; fetch: typeof fetch } {
  const urls: string[] = [];
  let call = 0;
  const impl = (async (input: RequestInfo | URL) => {
    urls.push(typeof input === "string" ? input : input.toString());
    const titles = titlesByCall[Math.min(call, titlesByCall.length - 1)] ?? [];
    call += 1;
    return new Response(
      JSON.stringify({
        columns: [
          {
            status: "todo",
            tasks: titles.map((title, i) => ({
              id: `t${i + 1}`,
              title,
              status: "todo",
              assignee: "sophie",
            })),
          },
        ],
        npcs: [{ npcId: "npc-a", npcName: "소피", profileName: "sophie", active: true }],
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { urls, fetch: impl };
}

function cardTitles(el: HTMLElement): string[] {
  return Array.from(el.querySelectorAll('[data-testid="npc-cards-tab"] [data-card-id]')).map(
    (node) => (node.textContent ?? "").trim(),
  );
}

test("with the cards tab open, a kanban:event reloads the list", async () => {
  const originalFetch = globalThis.fetch;
  const server = boardFetch([["주간 보고서"], ["주간 보고서", "새로 배정된 카드"]]);
  globalThis.fetch = server.fetch;
  try {
    const view = await mountRerender(cardsPanel({ cardsRefreshTick: 0, cardsDebounceMs: 5 }));
    await click(view.el.querySelector('[role="tab"][data-tab="cards"]')!);
    await settle(20);
    assert.equal(cardTitles(view.el).length, 1);

    await view.render(cardsPanel({ cardsRefreshTick: 1, cardsDebounceMs: 5 }));
    await settle(30);
    assert.equal(
      cardTitles(view.el).length,
      2,
      "사건이 왔는데 목록이 그대로다 — 배지만 오르고 목록이 낡는다",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a burst of events still coalesces into a single board fetch", async () => {
  const originalFetch = globalThis.fetch;
  const server = boardFetch([["주간 보고서"]]);
  globalThis.fetch = server.fetch;
  try {
    const view = await mountRerender(cardsPanel({ cardsRefreshTick: 0, cardsDebounceMs: 30 }));
    await click(view.el.querySelector('[role="tab"][data-tab="cards"]')!);
    await settle(10);
    const afterOpen = server.urls.length;

    for (const tick of [1, 2, 3, 4]) {
      await view.render(cardsPanel({ cardsRefreshTick: tick, cardsDebounceMs: 30 }));
    }
    await settle(60);
    assert.equal(
      server.urls.length - afterOpen,
      1,
      "사건 수만큼 보드를 읽고 있다 — 이 조회는 서버에서 Hermes 를 부른다",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("without the cards tab open, the board isn't read even if an event arrives", async () => {
  const originalFetch = globalThis.fetch;
  const server = boardFetch([[]]);
  globalThis.fetch = server.fetch;
  try {
    const view = await mountRerender(cardsPanel({ cardsRefreshTick: 0, cardsDebounceMs: 5 }));
    await view.render(cardsPanel({ cardsRefreshTick: 1, cardsDebounceMs: 5 }));
    await settle(20);
    assert.deepEqual(server.urls, [], "닫힌 탭이 보드를 읽고 있다");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the previous list stays visible during a refetch — never treated as an empty list", async () => {
  const originalFetch = globalThis.fetch;
  // A gate to hold the second fetch. Assigning it inside the callback would let TS narrow it to `never`, so it's built beforehand.
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(typeof input === "string" ? input : input.toString());
    const body = JSON.stringify({
      columns: [
        {
          status: "todo",
          tasks: [{ id: "t1", title: "주간 보고서", status: "todo", assignee: "sophie" }],
        },
      ],
      npcs: [{ npcId: "npc-a", npcName: "소피", profileName: "sophie", active: true }],
    });
    // Hold the second fetch — what the screen looks like in the meantime is this test's whole point.
    if (urls.length === 2) await held;
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  try {
    const view = await mountRerender(cardsPanel({ cardsRefreshTick: 0, cardsDebounceMs: 5 }));
    await click(view.el.querySelector('[role="tab"][data-tab="cards"]')!);
    await settle(20);
    assert.equal(cardTitles(view.el).length, 1);

    await view.render(cardsPanel({ cardsRefreshTick: 1, cardsDebounceMs: 5 }));
    await settle(20);
    assert.equal(urls.length, 2, "둘째 조회가 나가야 한다");
    assert.equal(cardTitles(view.el).length, 1, "재조회 중에 목록이 비었다");
    assert.equal(view.el.querySelector('[data-testid="cards-empty"]'), null);
    release();
    await settle(10);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("with no events, the board isn't reread just because time passes with the tab open — no polling", async () => {
  const originalFetch = globalThis.fetch;
  const server = boardFetch([["주간 보고서"]]);
  globalThis.fetch = server.fetch;
  try {
    const view = await mountRerender(cardsPanel({ cardsRefreshTick: 0, cardsDebounceMs: 5 }));
    await click(view.el.querySelector('[role="tab"][data-tab="cards"]')!);
    await settle(20);
    const afterOpen = server.urls.length;
    await settle(60);
    assert.equal(server.urls.length, afterOpen, "이 조회는 서버에서 Hermes 보드를 읽는다");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("even if an event passes while the tab is closed, reopening the same employee's tab reads the board only once", async () => {
  const originalFetch = globalThis.fetch;
  const server = boardFetch([["주간 보고서"], ["주간 보고서"], ["주간 보고서"]]);
  globalThis.fetch = server.fetch;
  try {
    const view = await mountRerender(cardsPanel({ cardsRefreshTick: 1, cardsDebounceMs: 5 }));
    await click(view.el.querySelector('[role="tab"][data-tab="cards"]')!);
    await settle(30);
    assert.equal(server.urls.length, 1);

    // An event passes while back on the chat tab — a closed tab doesn't fetch.
    await click(view.el.querySelector('[role="tab"][data-tab="chat"]')!);
    await view.render(cardsPanel({ cardsRefreshTick: 2, cardsDebounceMs: 5 }));
    await settle(30);
    assert.equal(server.urls.length, 1, "닫힌 탭이 보드를 읽었다");

    // Reopening makes that moment current — it must end with a single open-time fetch.
    await click(view.el.querySelector('[role="tab"][data-tab="cards"]')!);
    await settle(30);
    assert.equal(server.urls.length, 2, "다시 여는 것만으로 보드를 두 번 읽는다");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("opening the tab after an event already passed still reads the board only once — but reacts to a new event after that", async () => {
  const originalFetch = globalThis.fetch;
  const server = boardFetch([["주간 보고서"]]);
  globalThis.fetch = server.fetch;
  try {
    // Three events passed before the chat panel opened — the tick only ever rises during a session.
    const view = await mountRerender(cardsPanel({ cardsRefreshTick: 3, cardsDebounceMs: 5 }));
    await click(view.el.querySelector('[role="tab"][data-tab="cards"]')!);
    await settle(30);
    assert.equal(
      server.urls.length,
      1,
      "탭을 여는 것만으로 보드를 두 번 읽는다 — 새 사건은 없었다",
    );

    await view.render(cardsPanel({ cardsRefreshTick: 4, cardsDebounceMs: 5 }));
    await settle(30);
    assert.equal(server.urls.length, 2, "탭을 연 뒤의 새 사건에는 반응해야 한다");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an employee's chat coming to report shows that report's summary and an open link at the top", async () => {
  const opened: [string, string][] = [];
  const report = {
    messageId: "m1",
    npcId: "sophie",
    npcName: "소피",
    kind: "card_review" as const,
    cardId: "card-1",
    boardSlug: "board-1",
    jobId: null,
    cardTitle: "목차 초안",
    summary: "목차 7개 장을 정리했습니다",
    createdAt: "2026-09-21T01:00:00Z",
  };
  const withDialog = (dialogReport: typeof report | null) => (
    <I18nProvider>
      <ChatPanel
        dialogNpc={{ npcId: "sophie", npcName: "소피" }}
        dialogReport={dialogReport}
        onOpenNoticeCard={(cardId, boardSlug) => opened.push([cardId, boardSlug])}
        npcMessages={[]}
        isNpcStreaming={false}
        onSend={() => {}}
        onClose={() => {}}
        npcSelectList={null}
        onSelectNpc={() => {}}
        roomState={listState()}
        onRoomSend={() => {}}
        onRoomAction={() => {}}
        onRoomCreate={() => {}}
        onRoomInvite={() => {}}
        onRoomLeave={() => {}}
        onRoomRename={() => {}}
        onRoomDelete={() => {}}
        mentionCandidatesFor={() => []}
        onlinePlayers={[]}
      />
    </I18nProvider>
  );
  const el = await mount(withDialog(report));
  const summary = el.querySelector('[data-testid="dialog-report-summary"]');
  assert.ok(summary, "보고 요약이 보여야 한다");
  assert.match(summary.textContent ?? "", /목차 초안/);
  assert.match(summary.textContent ?? "", /목차 7개 장을 정리했습니다/);
  await click(el.querySelector('[data-testid="dialog-report-open"]')!);
  assert.deepEqual(opened, [["card-1", "board-1"]]);

  const plain = await mount(withDialog(null));
  assert.equal(plain.querySelector('[data-testid="dialog-report-summary"]'), null);
});

test("with a modal open, Esc closes only the modal and not the employee chat behind it", async () => {
  let closed = 0;
  const node = (
    <I18nProvider>
      <ChatPanel
        dialogNpc={{ npcId: "sophie", npcName: "소피" }}
        npcMessages={[]}
        isNpcStreaming={false}
        onSend={() => {}}
        onClose={() => {
          closed += 1;
        }}
        npcSelectList={null}
        onSelectNpc={() => {}}
        roomState={listState()}
        onRoomSend={() => {}}
        onRoomAction={() => {}}
        onRoomCreate={() => {}}
        onRoomInvite={() => {}}
        onRoomLeave={() => {}}
        onRoomRename={() => {}}
        onRoomDelete={() => {}}
        mentionCandidatesFor={() => []}
        onlinePlayers={[]}
      />
    </I18nProvider>
  );
  await mount(node);
  const modal = document.createElement("div");
  modal.setAttribute("aria-modal", "true");
  document.body.appendChild(modal);
  const esc = () =>
    act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
  await esc();
  assert.equal(closed, 0, "모달이 있으면 대화창은 그대로다");
  modal.remove();
  await esc();
  assert.equal(closed, 1, "모달이 없으면 Esc 가 대화창을 닫는다");
});

test("with the report list popover open, Esc closes only the list and the chat panel remains", async () => {
  let closed = 0;
  const item: ReportItem = {
    messageId: "m1",
    npcId: "oliver",
    npcName: "올리버",
    kind: "card_done",
    cardId: "c-1",
    boardSlug: "b",
    jobId: null,
    cardTitle: "본문 초안",
    summary: "",
    createdAt: "2026-09-21T01:00:00Z",
  };
  const el = await mount(
    <I18nProvider>
      <ReportBadge
        queue={[item]}
        current={null}
        dismissedIds={new Set()}
        onOpen={() => {}}
        onRecall={() => {}}
      />
      <ChatPanel
        dialogNpc={{ npcId: "sophie", npcName: "소피" }}
        npcMessages={[]}
        isNpcStreaming={false}
        onSend={() => {}}
        onClose={() => {
          closed += 1;
        }}
        npcSelectList={null}
        onSelectNpc={() => {}}
        roomState={listState()}
        onRoomSend={() => {}}
        onRoomAction={() => {}}
        onRoomCreate={() => {}}
        onRoomInvite={() => {}}
        onRoomLeave={() => {}}
        onRoomRename={() => {}}
        onRoomDelete={() => {}}
        mentionCandidatesFor={() => []}
        onlinePlayers={[]}
      />
    </I18nProvider>,
  );
  await act(async () => {
    el.querySelector('[data-testid="report-badge"]')!.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
  });
  assert.ok(el.querySelector('[data-testid="report-list"]'), "배지를 누르면 목록이 열린다");

  // Like a real browser, a single event bubbles up from the body through document and then window.
  await act(async () => {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
  assert.equal(
    el.querySelector('[data-testid="report-list"]'),
    null,
    "가장 위 레이어인 목록이 닫힌다",
  );
  assert.equal(closed, 0, "목록을 닫는 Esc 가 뒤의 대화창까지 닫으면 안 된다");

  // In a real browser, the chat panel's listener runs only after the list has already left the DOM
  // (observed on staging, 2026-09-21). It must still not close then, so this reproduces the state
  // where a layer has already consumed Esc.
  const consume = (event: KeyboardEvent) => event.preventDefault();
  document.addEventListener("keydown", consume);
  await act(async () => {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
  document.removeEventListener("keydown", consume);
  assert.equal(closed, 0, "레이어가 소비한 Esc 로는 대화창이 닫히지 않는다");

  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
  assert.equal(closed, 1, "목록이 닫힌 뒤에는 Esc 가 대화창을 닫는다");
});

test("a completed reply's register-card button carries the preceding request and reply into the confirmation screen", async () => {
  let draft: { title: string; body: string; assigneeNpcId: string } | undefined;
  const el = await mount(
    panel(listState(), {
      dialogNpc: { npcId: "n1", npcName: "직원" },
      npcMessages: [
        { id: "original", role: "player", content: "주간 안내를 작성해 주세요" },
        {
          responseRequestId: "reply",
          role: "npc",
          content: "완료한 일과 다음 주 계획을 알려 주세요.",
        },
      ],
      npcResponses: [
        {
          requestId: "reply",
          sourceMessageId: "original",
          npcId: "n1",
          npcName: "직원",
          status: "complete",
          content: "완료한 일과 다음 주 계획을 알려 주세요.",
          updatedAt: 1,
        },
      ],
      onCreateTaskFromChat: (next) => {
        draft = next;
      },
    }),
  );
  await click(buttonByText(el, "카드로 등록"));
  assert.equal(draft?.title, "주간 안내를 작성해 주세요");
  assert.equal(draft?.assigneeNpcId, "n1");
  assert.match(draft?.body ?? "", /주간 안내를 작성해 주세요/);
  assert.match(draft?.body ?? "", /완료한 일과 다음 주 계획/);
});

test("does not show the register-card button on a reply that's still streaming", async () => {
  const el = await mount(
    panel(listState(), {
      dialogNpc: { npcId: "n1", npcName: "직원" },
      npcMessages: [{ role: "npc", content: "작성 중" }],
      isNpcStreaming: true,
      onCreateTaskFromChat: () => {
        throw new Error("등록하면 안 된다");
      },
    }),
  );
  assert.equal(
    Array.from(el.querySelectorAll("button")).some((b) => b.textContent === "카드로 등록"),
    false,
  );
});

test("with a request history of A, B, replyA, the reply links to A by request id", async () => {
  let draft: { title: string; body: string; assigneeNpcId: string } | undefined;
  const el = await mount(
    panel(listState(), {
      dialogNpc: { npcId: "n1", npcName: "직원" },
      npcMessages: [
        { id: "a", role: "player", content: "요청 A" },
        { id: "b", role: "player", content: "요청 B" },
        { id: "ra", responseRequestId: "r1", role: "npc", content: "A의 답변" },
      ],
      npcResponses: [
        {
          requestId: "r1",
          sourceMessageId: "a",
          npcId: "n1",
          npcName: "직원",
          status: "complete",
          content: "A의 답변",
          updatedAt: 1,
        },
      ],
      onCreateTaskFromChat: (next) => {
        draft = next;
      },
    }),
  );
  await click(buttonByText(el, "카드로 등록"));
  assert.equal(draft?.title, "요청 A");
  assert.doesNotMatch(draft?.body ?? "", /요청 B/);
});

test("a past reply with no link info does not assume the adjacent request is its original text", async () => {
  let body = "";
  const el = await mount(
    panel(listState(), {
      dialogNpc: { npcId: "n1", npcName: "직원" },
      npcMessages: [
        { role: "player", content: "다른 요청" },
        { role: "npc", content: "과거 답변" },
      ],
      onCreateTaskFromChat: (draft) => {
        body = draft.body;
      },
    }),
  );
  await click(buttonByText(el, "카드로 등록"));
  assert.doesNotMatch(body, /다른 요청/);
  assert.match(body, /원래 요청을 확인할 수 없습니다/);
  assert.match(body, /과거 답변/);
});

test("the NPC chat tab shows that NPC's tool approval card above the input", async () => {
  const handlers = new Map<string, (payload: unknown) => void>();
  const socket = {
    on: (event: string, handler: (payload: unknown) => void) => handlers.set(event, handler),
    off: (event: string) => handlers.delete(event),
    emit: () => true,
  };
  const el = await mount(cardsPanel({ approvalSocket: socket }));
  const request = {
    key: "r:1",
    runId: "r",
    requestId: "1",
    channelId: "ch1",
    context: "dm",
    kind: "command",
    command: "rm -r /tmp/probe",
    description: "",
    choices: ["once", "deny"],
    expiresAt: Date.now() + 60_000,
  };
  await act(async () => {
    handlers.get("tool-approval:request")!({ ...request, npcId: "npc-b" });
    handlers.get("tool-approval:request")!({ ...request, key: "r:2", npcId: "npc-a" });
  });
  const cards = el.querySelectorAll('[data-testid="tool-approval-card"]');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].getAttribute("data-key"), "r:2");
  assert.ok((cards[0].textContent ?? "").includes("소피"));
});

test("an open chat room shows its NPC's tool approval card above the room input, and only that room's", async () => {
  const handlers = new Map<string, (payload: unknown) => void>();
  const socket = {
    on: (event: string, handler: (payload: unknown) => void) => handlers.set(event, handler),
    off: (event: string) => handlers.delete(event),
    emit: () => true,
  };
  const el = await mount(
    panel(
      { ...listState(), view: "room" },
      {
        channelChatOpen: true,
        approvalSocket: socket,
        mentionCandidatesFor: () => [{ id: "npc-a", name: "소피" }],
      },
    ),
  );
  const request = {
    runId: "r",
    requestId: "1",
    npcId: "npc-a",
    channelId: "ch1",
    context: "room",
    kind: "command",
    command: "rm -r /tmp/probe",
    description: "",
    choices: ["once", "deny"],
    expiresAt: Date.now() + 60_000,
  };
  await act(async () => {
    handlers.get("tool-approval:request")!({ ...request, key: "r:1", roomId: "office" });
    handlers.get("tool-approval:request")!({ ...request, key: "r:2", roomId: "g1" });
  });
  const cards = el.querySelectorAll('[data-testid="tool-approval-card"]');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].getAttribute("data-key"), "r:2");
  assert.ok((cards[0].textContent ?? "").includes("소피"));
});

test("an NPC reply in progress shows a stop button that stops that reply", async () => {
  const stopped: string[] = [];
  const response = (requestId: string, status: "complete" | "streaming") => ({
    requestId,
    sourceMessageId: `m-${requestId}`,
    npcId: "npc-noah",
    npcName: "noah",
    status,
    content: "…",
    updatedAt: 1,
  });
  const el = await mount(
    panel(listState(), {
      dialogNpc: { npcId: "npc-noah", npcName: "noah" },
      npcResponses: [response("done", "complete"), response("live", "streaming")],
      onStopNpcResponse: (requestId) => stopped.push(requestId),
    }),
  );
  const stop = el.querySelector('[data-testid="chat-stop"]') as HTMLButtonElement;
  assert.ok(stop);
  await act(async () => stop.click());
  assert.deepEqual(stopped, ["live"]);
});

test("with no reply in progress the NPC chat keeps its send button", async () => {
  const el = await mount(
    panel(listState(), {
      dialogNpc: { npcId: "npc-noah", npcName: "noah" },
      npcResponses: [],
      onStopNpcResponse: () => {},
    }),
  );
  assert.equal(el.querySelector('[data-testid="chat-stop"]'), null);
});

test("a room reply to my own message can be stopped; a reply to someone else's cannot", async () => {
  const message = (id: string, senderId: string) => ({
    id,
    roomId: "g1",
    senderKind: "user" as const,
    senderId,
    senderName: senderId,
    content: "@Sophie help",
    createdAt: "2026-09-10T00:00:00Z",
  });
  const reply = (requestId: string, sourceMessageId: string) => ({
    requestId,
    sourceMessageId,
    npcId: "n1",
    npcName: "Sophie",
    status: "streaming" as const,
    content: "…",
    updatedAt: 1,
  });
  const stopped: string[][] = [];
  const roomState = (messages: ReturnType<typeof message>[]): RoomState => ({
    ...listState(),
    view: "room",
    messages: { g1: messages },
  });

  const mineEl = await mount(
    panel(roomState([message("mine", "u1")]), {
      channelChatOpen: true,
      roomResponses: [reply("r-mine", "mine")],
      onStopRoomResponse: (roomId, requestId) => stopped.push([roomId, requestId]),
    }),
  );
  const stop = mineEl.querySelector('[data-testid="chat-stop"]') as HTMLButtonElement;
  assert.ok(stop);
  await act(async () => stop.click());
  assert.deepEqual(stopped, [["g1", "r-mine"]]);

  const otherEl = await mount(
    panel(roomState([message("theirs", "u2")]), {
      channelChatOpen: true,
      roomResponses: [reply("r-theirs", "theirs")],
      onStopRoomResponse: () => {},
    }),
  );
  assert.equal(otherEl.querySelector('[data-testid="chat-stop"]'), null);
});
