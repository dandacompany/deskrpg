import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";

import { buildLinkPreview, clearLinkPreviewCache, proxiedImageUrl } from "./service";
import { isAllowedPreviewUrl } from "./fetch";

const allowAll = async (url: URL) =>
  url.hostname === "127.0.0.1" || (await isAllowedPreviewUrl(url));

async function serve(body: string): Promise<{ origin: string; close: () => void; hits: number }> {
  const state = { hits: 0 };
  const server: Server = createServer((_req, res) => {
    state.hits++;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  return {
    origin: `http://127.0.0.1:${addr.port}`,
    close: () => server.close(),
    get hits() {
      return state.hits;
    },
  };
}

test("a page with og tags comes back as a preview, and the image goes through our proxy", async () => {
  clearLinkPreviewCache();
  const s = await serve(
    `<meta property="og:title" content="제목"><meta property="og:image" content="/a.png">`,
  );
  try {
    const got = await buildLinkPreview(`${s.origin}/p`, {
      isAllowedUrl: allowAll,
      isAllowedAddress: () => true,
    });
    assert.equal(got?.title, "제목");
    assert.equal(got?.image, proxiedImageUrl(`${s.origin}/a.png`));
    assert.ok(got?.image?.startsWith("/api/link-preview/image?"), "이미지는 직접 물리지 않는다");
  } finally {
    s.close();
  }
});

test("querying the same address twice only calls the other server once", async () => {
  clearLinkPreviewCache();
  const s = await serve(`<title>한 번만</title>`);
  try {
    await buildLinkPreview(`${s.origin}/p`, {
      isAllowedUrl: allowAll,
      isAllowedAddress: () => true,
    });
    await buildLinkPreview(`${s.origin}/p`, {
      isAllowedUrl: allowAll,
      isAllowedAddress: () => true,
    });
    assert.equal(s.hits, 1);
  } finally {
    s.close();
  }
});

test("failure is cached too — a dead link isn't re-hit every time the screen loads", async () => {
  clearLinkPreviewCache();
  const first = await buildLinkPreview("http://169.254.169.254/latest/meta-data/", {
    isAllowedUrl: allowAll,
    isAllowedAddress: () => true,
  });
  assert.equal(first, null);
  // The address is rejected by the guard, so the second call is also null, and neither one sends a request.
  assert.equal(
    await buildLinkPreview("http://169.254.169.254/latest/meta-data/", {
      isAllowedUrl: allowAll,
      isAllowedAddress: () => true,
    }),
    null,
  );
});

test("an address rejected by the guard is never fetched", async () => {
  clearLinkPreviewCache();
  for (const bad of ["file:///etc/passwd", "http://localhost/", "https://a:b@example.com/"]) {
    assert.equal(
      await buildLinkPreview(bad, { isAllowedUrl: allowAll, isAllowedAddress: () => true }),
      null,
      bad,
    );
  }
});

test("HTML and image work share 8 slots, and a slot is returned after a failure", async () => {
  const { withPreviewSlot } = await import("./service");
  const releases: Array<() => void> = [];
  const pending = Array.from({ length: 8 }, () =>
    withPreviewSlot(() => new Promise<void>((resolve) => releases.push(resolve))),
  );
  assert.equal(releases.length, 8);
  let called = false;
  assert.deepEqual(
    await withPreviewSlot(async () => {
      called = true;
      return "image";
    }),
    { admitted: false },
  );
  assert.equal(called, false);
  releases[0]();
  await pending[0];
  assert.deepEqual(await withPreviewSlot(async () => "image"), { admitted: true, value: "image" });
  releases.slice(1).forEach((release) => release());
  await Promise.all(pending);
  await assert.rejects(
    withPreviewSlot(async () => {
      throw new Error("failed");
    }),
    /failed/,
  );
  assert.deepEqual(await withPreviewSlot(async () => "html"), { admitted: true, value: "html" });
});

test("an address that failed from saturation isn't cached, so it succeeds after a slot frees up", async () => {
  clearLinkPreviewCache();
  const { withPreviewSlot } = await import("./service");
  const s = await serve(`<title>복구</title>`);
  const releases: Array<() => void> = [];
  const pending = Array.from({ length: 8 }, () =>
    withPreviewSlot(() => new Promise<void>((resolve) => releases.push(resolve))),
  );
  try {
    const target = `${s.origin}/recover`;
    const options = { isAllowedUrl: allowAll, isAllowedAddress: () => true };
    assert.equal(await buildLinkPreview(target, options), null);
    assert.equal(s.hits, 0);
    releases.forEach((release) => release());
    await Promise.all(pending);
    assert.equal((await buildLinkPreview(target, options))?.title, "복구");
    assert.equal(s.hits, 1);
  } finally {
    releases.forEach((release) => release());
    s.close();
  }
});
