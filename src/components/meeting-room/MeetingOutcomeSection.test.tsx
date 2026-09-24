import "../../test-setup/dom";

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { act } from "react";
import { createRoot } from "react-dom/client";

import { I18nProvider } from "@/lib/i18n/context";

import MeetingOutcomeSection from "./MeetingOutcomeSection";

const outcome = {
  decisions: ["A안 채택"],
  followUps: [
    {
      title: "조사",
      summary: null,
      acceptance: null,
      assigneeNpcId: "npc-1",
      assigneeName: "소피",
      after: [],
    },
  ],
  project: { recommended: true, name: "가격 개편", reason: null },
};

type Call = { url: string; method: string; body: unknown };
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(given: Record<string, () => { status: number; body: unknown }>): Call[] {
  const routes: typeof given = {
    "GET /api/channels/c1/automation/status": () => ({
      status: 200,
      body: { capabilities: ["kanban", "initial_status"] },
    }),
    ...given,
  };
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const route = routes[`${method} ${url}`];
    assert.ok(route, `예상하지 않은 요청: ${method} ${url}`);
    const { status, body } = route();
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return calls;
}

async function mount(
  extra: Partial<React.ComponentProps<typeof MeetingOutcomeSection>> = {},
): Promise<HTMLElement> {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () =>
    root.render(
      <I18nProvider initialLocale="ko">
        <MeetingOutcomeSection
          minutesId="m1"
          channelId="c1"
          npcs={[{ id: "npc-1", name: "소피" }]}
          {...extra}
        />
      </I18nProvider>,
    ),
  );
  await act(async () => {});
  return el;
}

test("permission and registered status use the values returned by the minutes fetch", async () => {
  stubFetch({
    "GET /api/meetings/m1": () => ({
      status: 200,
      body: { minutes: { outcome, summaryStatus: "ok" }, canManage: false },
    }),
  });
  const el = await mount();
  assert.equal(el.querySelectorAll("[data-outcome-item]").length, 1);
  assert.equal(el.querySelector("[data-outcome-register]"), null);
});

test("when registration succeeds, the button turns into the result", async () => {
  const calls = stubFetch({
    "GET /api/meetings/m1": () => ({
      status: 200,
      body: { minutes: { outcome, summaryStatus: "ok" }, canManage: true },
    }),
    "POST /api/meetings/m1/register": () => ({
      status: 200,
      body: {
        registered: { boardSlug: "b", tenant: "가격-개편", taskIds: ["t1"], by: "u", at: "now" },
      },
    }),
  });
  const el = await mount();
  await act(async () => (el.querySelector("[data-outcome-register]") as HTMLElement).click());
  await act(async () => {});
  const posted = calls.find((call) => call.method === "POST");
  assert.deepEqual(posted?.body, {
    tenant: { slug: "가격-개편", name: "가격 개편" },
    items: [{ index: 0, title: "조사", npcId: "npc-1", after: [] }],
  });
  assert.ok(el.querySelector("[data-outcome-registered]"));
  assert.equal(el.querySelector("[data-outcome-register]"), null);
});

test("when registration is rejected, it shows the message for the returned code and keeps the button", async () => {
  stubFetch({
    "GET /api/meetings/m1": () => ({
      status: 200,
      body: { minutes: { outcome, summaryStatus: "ok" }, canManage: true },
    }),
    "POST /api/meetings/m1/register": () => ({
      status: 409,
      body: { errorCode: "already_registered" },
    }),
  });
  const el = await mount();
  await act(async () => (el.querySelector("[data-outcome-register]") as HTMLElement).click());
  await act(async () => {});
  assert.match(el.querySelector("[data-outcome-error]")?.textContent ?? "", /이미 등록된 회의/);
  assert.ok(el.querySelector("[data-outcome-register]"));
});

test("retrying a failed summary swaps the panel for the new outcome", async () => {
  stubFetch({
    "GET /api/meetings/m1": () => ({
      status: 200,
      body: { minutes: { outcome: null, summaryStatus: "failed" }, canManage: true },
    }),
    "POST /api/meetings/m1/summarize": () => ({
      status: 200,
      body: { summaryStatus: "ok", keyTopics: ["a"], conclusions: "b", outcome },
    }),
  });
  const el = await mount();
  await act(async () => (el.querySelector("[data-outcome-retry]") as HTMLElement).click());
  await act(async () => {});
  assert.equal(el.querySelector("[data-outcome-retry]"), null);
  assert.equal(el.querySelectorAll("[data-outcome-item]").length, 1);
});

test("even when the kanban gate rejects with a {code} shape, it reads that code rather than the HTTP status", async () => {
  stubFetch({
    "GET /api/meetings/m1": () => ({
      status: 200,
      body: { minutes: { outcome, summaryStatus: "ok" }, canManage: true },
    }),
    "POST /api/meetings/m1/register": () => ({
      status: 409,
      body: { code: "gateway_not_bound", message: "no gateway" },
    }),
  });
  const el = await mount();
  await act(async () => (el.querySelector("[data-outcome-register]") as HTMLElement).click());
  await act(async () => {});
  const shown = el.querySelector("[data-outcome-error]")?.textContent ?? "";
  assert.ok(shown.length > 0, "오류가 보여야 한다");
  assert.ok(!/HTTP 409/.test(shown), `상태 코드가 아니라 사유를 보여야 한다: ${shown}`);
  assert.ok(Boolean(el.querySelector("[data-outcome-register]")), "버튼은 남는다");
});

test("does not render the register button when the plugin doesn't advertise initial_status", async () => {
  stubFetch({
    "GET /api/meetings/m1": () => ({
      status: 200,
      body: { minutes: { outcome, summaryStatus: "ok" }, canManage: true },
    }),
    "GET /api/channels/c1/automation/status": () => ({
      status: 200,
      body: { capabilities: ["kanban", "swarm"] },
    }),
  });
  const el = await mount();
  assert.equal(el.querySelector("[data-outcome-register]"), null);
  assert.ok(Boolean(el.querySelector("[data-outcome-upgrade]")), "갱신 안내가 보여야 한다");
});

test("treats it as unsupported when the automation status can't be read — does not render a button that would fail", async () => {
  stubFetch({
    "GET /api/meetings/m1": () => ({
      status: 200,
      body: { minutes: { outcome, summaryStatus: "ok" }, canManage: true },
    }),
    "GET /api/channels/c1/automation/status": () => ({
      status: 409,
      body: { code: "gateway_not_bound" },
    }),
  });
  const el = await mount();
  assert.equal(el.querySelector("[data-outcome-register]"), null);
});

test("the end screen hears whether follow-ups remain to register, and can click 'don't register'", async () => {
  stubFetch({
    "GET /api/meetings/m1": () => ({
      status: 200,
      body: { minutes: { outcome, summaryStatus: "ok" }, canManage: true },
    }),
  });
  const loaded: boolean[] = [];
  let declined = 0;
  const el = await mount({
    onOutcomeLoaded: (pending) => loaded.push(pending),
    onDeclined: () => declined++,
  });
  assert.deepEqual(loaded, [true]);
  await act(async () => (el.querySelector("[data-outcome-decline]") as HTMLElement).click());
  assert.equal(declined, 1);
});

test("reports nothing left when there are no follow-ups or no register permission", async () => {
  for (const [body, why] of [
    [{ minutes: { outcome: { ...outcome, followUps: [] } }, canManage: true }, "0건"],
    [{ minutes: { outcome }, canManage: false }, "권한 없음"],
    [
      { minutes: { outcome: { ...outcome, registered: { taskIds: ["t"] } } }, canManage: true },
      "이미 등록",
    ],
  ] as const) {
    stubFetch({ "GET /api/meetings/m1": () => ({ status: 200, body }) });
    const loaded: boolean[] = [];
    await mount({ onOutcomeLoaded: (pending) => loaded.push(pending) });
    assert.deepEqual(loaded, [false], why);
  }
});

test("without a callback passed, as in the minutes archive, there is no 'don't register' button", async () => {
  stubFetch({
    "GET /api/meetings/m1": () => ({
      status: 200,
      body: { minutes: { outcome, summaryStatus: "ok" }, canManage: true },
    }),
  });
  const el = await mount();
  assert.ok(el.querySelector("[data-outcome-register]"));
  assert.equal(el.querySelector("[data-outcome-decline]"), null);
});
