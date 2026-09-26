import "../../test-setup/dom";
import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { I18nProvider } from "@/lib/i18n/context";

import GatewayShares from "./GatewayShares";

type Json = Record<string, unknown>;

function mockFetch(
  routes: Record<string, Json | ((body: unknown) => Json)>,
  status: Record<string, number> = {},
) {
  const calls: Array<{ key: string; body: unknown }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const key = `${init?.method ?? "GET"} ${url}`;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ key, body });
    const route = routes[key];
    const data = typeof route === "function" ? route(body) : (route ?? {});
    return new Response(JSON.stringify(data), {
      status: status[key] ?? (route ? 200 : 404),
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

async function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <I18nProvider initialLocale="ko">
        <GatewayShares gatewayId="gw-1" />
      </I18nProvider>,
    ),
  );
  const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
  await settle();
  await settle();
  return {
    host,
    settle,
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

const OWNER = { gateway: { id: "gw-1", displayName: "사무실", isOwner: true } };

test("the owner sees who the gateway is shared with, and adds a login id", async () => {
  let shares = [{ userId: "u2", loginId: "mina", nickname: "미나", role: "use" }];
  const calls = mockFetch({
    "GET /api/gateways/gw-1": OWNER,
    "GET /api/gateways/gw-1/shares": () => ({ shares }),
    "POST /api/gateways/gw-1/shares": (body) => {
      shares = [
        ...shares,
        { userId: "u3", loginId: (body as Json).loginId as string, nickname: null, role: "use" },
      ];
      return { ok: true };
    },
  });
  const f = await mount();
  assert.match(f.host.textContent ?? "", /사무실/);
  assert.match(f.host.textContent ?? "", /미나/);
  const input = f.host.querySelector<HTMLInputElement>("[data-share-login-id]");
  assert.ok(input, "owner gets the add field");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "joon");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    f.host.querySelector<HTMLButtonElement>("[data-share-add]")?.click();
  });
  await f.settle();
  await f.settle();
  assert.deepEqual(
    calls.filter((c) => c.key === "POST /api/gateways/gw-1/shares").map((c) => c.body),
    [{ loginId: "joon", role: "use" }],
  );
  assert.match(f.host.textContent ?? "", /joon/);
  await f.cleanup();
});

test("the owner removes a share", async () => {
  const calls = mockFetch({
    "GET /api/gateways/gw-1": OWNER,
    "GET /api/gateways/gw-1/shares": {
      shares: [{ userId: "u2", loginId: "mina", nickname: null, role: "use" }],
    },
    "DELETE /api/gateways/gw-1/shares": { ok: true },
  });
  const f = await mount();
  await act(async () => {
    f.host.querySelector<HTMLButtonElement>("[data-share-remove]")?.click();
  });
  await f.settle();
  assert.deepEqual(
    calls.filter((c) => c.key === "DELETE /api/gateways/gw-1/shares").map((c) => c.body),
    [{ userId: "u2" }],
  );
  await f.cleanup();
});

test("someone the gateway is shared with sees the owner-only notice and no share list", async () => {
  const calls = mockFetch({
    "GET /api/gateways/gw-1": { gateway: { id: "gw-1", displayName: "사무실", isOwner: false } },
  });
  const f = await mount();
  assert.ok(!f.host.querySelector("[data-share-login-id]"));
  assert.ok(
    !calls.some((c) => c.key === "GET /api/gateways/gw-1/shares"),
    "the list is never asked for",
  );
  assert.match(f.host.textContent ?? "", /소유자만/);
  await f.cleanup();
});

test("a gateway the user can't reach shows the error and a way back", async () => {
  mockFetch(
    { "GET /api/gateways/gw-1": { errorCode: "not_found" } },
    { "GET /api/gateways/gw-1": 404 },
  );
  const f = await mount();
  assert.ok(!f.host.querySelector("[data-share-login-id]"));
  const back = f.host.querySelector<HTMLAnchorElement>("[data-back-to-gateways]");
  assert.ok(back);
  assert.equal(back.getAttribute("href"), "/gateways?gateway=gw-1");
  await f.cleanup();
});
