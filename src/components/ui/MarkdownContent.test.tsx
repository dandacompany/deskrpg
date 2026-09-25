import "../../test-setup/dom";
import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { I18nProvider } from "@/lib/i18n/context";

import MarkdownContent from "./MarkdownContent";

function render(content: string): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  let root: Root;
  act(() => {
    root = createRoot(host);
    root.render(
      <I18nProvider initialLocale="ko">
        <MarkdownContent content={content} />
      </I18nProvider>,
    );
  });
  return host;
}

/** Picks only links with a `download` attribute — distinguishes them from regular body links. */
const downloads = (host: HTMLElement) => Array.from(host.querySelectorAll("a[download]"));

test("a document link created by an employee gets a download link attached too", () => {
  const host = render("[보고서](/api/channels/c1/artifacts/a1/versions/2/content)");
  const links = downloads(host);
  assert.equal(links.length, 1);
  assert.equal(
    links[0].getAttribute("href"),
    "/api/channels/c1/artifacts/a1/versions/2/content?download=1",
  );
});

test("an external file link downloads with its filename", () => {
  const host = render("https://example.com/files/report.xlsx");
  const links = downloads(host);
  assert.equal(links.length, 1);
  assert.equal(links[0].getAttribute("download"), "report.xlsx");
});

test("a regular webpage link doesn't get a download attached", () => {
  const host = render("참고: [블로그](https://example.com/blog/post)");
  assert.equal(downloads(host).length, 0);
  // The body link itself must remain unchanged.
  assert.equal(host.querySelectorAll('a[href="https://example.com/blog/post"]').length, 1);
});

test("images can be downloaded too — showing the image with no way to save it is not acceptable", () => {
  const host = render("![차트](https://example.com/out/chart.png)");
  assert.equal(host.querySelectorAll("img").length, 1);
  const links = downloads(host);
  assert.equal(links.length, 1);
  assert.equal(links[0].getAttribute("href"), "https://example.com/out/chart.png");
});

test("a paragraph consisting solely of a link is promoted to a preview card", async () => {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(
      JSON.stringify({
        title: "예시 문서",
        description: "설명",
        image: "/api/link-preview/image?url=x",
        siteName: "example.com",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const host = render("https://example.com/doc\n");
    // Waits for the single fetch plus the state update, until the card is rendered.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    assert.deepEqual(calls, ["/api/link-preview?url=https%3A%2F%2Fexample.com%2Fdoc"]);
    const card = host.querySelector("[data-link-preview]");
    assert.ok(card, "미리보기 카드가 없다");
    assert.match(card.textContent ?? "", /예시 문서/);
    assert.equal(card.getAttribute("href"), "https://example.com/doc");
  } finally {
    globalThis.fetch = original;
  }
});

test("with no preview (204), the original underlined link remains as-is", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
  try {
    const host = render("https://example.com/doc\n");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    assert.ok(!host.querySelector("[data-link-preview]"));
    assert.equal(host.querySelectorAll('a[href="https://example.com/doc"]').length, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("an inline base64 image is not stripped, renders, and can be downloaded", () => {
  const src = "data:image/png;base64,AAAA";
  const host = render(`![차트](${src})`);
  const img = host.querySelector("img");
  assert.equal(img?.getAttribute("src"), src);
  assert.equal(downloads(host).length, 1);
  assert.equal(downloads(host)[0].getAttribute("download"), "image.png");
});

test("an image that lost its URL says it failed to load instead of showing a blank", () => {
  // A URL that isn't allowed through, like svg·file:, is stripped to an empty string by react-markdown.
  const host = render("![차트](data:image/svg+xml;base64,AAAA)");
  assert.ok(!host.querySelector("img"), "빈 src 로 깨진 아이콘을 남기지 않는다");
  assert.match(host.textContent ?? "", /이미지를 불러오지 못했습니다/);
});
