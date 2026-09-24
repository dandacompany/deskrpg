/**
 * Shared scaffolding for skills-screen tests — the same pattern as `ArtifactsModal.test.tsx`'s
 * `mockFetch`·`render`·`flush`. Not a test file, so `npm run test` does not run it separately.
 */
import "../../test-setup/dom";
import assert from "node:assert/strict";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { SkillRow } from "@/lib/hermes/plugin-client-types";
import { I18nProvider } from "@/lib/i18n/context";

export const ROOT = "/api/channels/ch-1/npcs/n-1/skills";
export const LIST = `GET ${ROOT}/`;

export const row = (name: string, over: Partial<SkillRow> = {}): SkillRow => ({
  name,
  category: "",
  description: "",
  disabled: false,
  essential: false,
  source: "local",
  useCount: 0,
  viewCount: 0,
  ...over,
});

type Reply = Record<string, unknown>;
export type FetchLog = { calls: string[]; bodies: Record<string, unknown> };

/**
 * `"METHOD path"` → response. `{status, json}` responds with that status; anything else is JSON 200.
 * An unknown path is 404. `delayMs`, if present, delays the reply that long (it is not included in
 * the body). `routes` is read by reference, so it can be changed mid-test.
 */
export function mockFetch(routes: Record<string, Reply>): FetchLog {
  const log: FetchLog = { calls: [], bodies: {} };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const key = `${init?.method ?? "GET"} ${url}`;
    log.calls.push(key);
    if (typeof init?.body === "string") log.bodies[key] = JSON.parse(init.body);
    const found = routes[key];
    if (found && typeof found.delayMs === "number") {
      await new Promise((r) => setTimeout(r, found.delayMs as number));
    }
    const { delayMs: _delay, ...reply } = found ?? {};
    if (!found) {
      return new Response(JSON.stringify({ code: "not_found", message: key }), { status: 404 });
    }
    if (typeof reply.status === "number" && "json" in reply) {
      return new Response(JSON.stringify(reply.json), { status: reply.status });
    }
    return new Response(JSON.stringify(reply), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return log;
}

const originalFetch = globalThis.fetch;
let root: Root | null = null;
export let container: HTMLElement;

export async function flush() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

export async function render(element: ReactElement) {
  if (!root) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  const r = root;
  await act(async () => r.render(<I18nProvider initialLocale="ko">{element}</I18nProvider>));
  await flush();
}

export async function cleanup() {
  if (root) {
    const r = root;
    await act(async () => r.unmount());
    root = null;
    container.remove();
  }
  globalThis.fetch = originalFetch;
}

export function $(sel: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(sel);
  assert.ok(el, `selector ${sel}`);
  return el;
}

export async function click(sel: string) {
  const el = $(sel);
  await act(async () => el.click());
  await flush();
}

/** Changes the value via an input event React listens for (a controlled component needs the value setter bypassed). */
export async function type(sel: string, value: string) {
  const el = $(sel) as HTMLInputElement | HTMLTextAreaElement;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, "value")!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
}

export const text = () => container.textContent ?? "";
