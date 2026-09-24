import test from "node:test";
import assert from "node:assert/strict";

import { streamProxyResponse } from "./stream-proxy";

test("copies only allowed headers and keeps the status as-is", () => {
  const upstream = new Response("abc", {
    status: 206,
    headers: {
      "content-type": "text/plain",
      "content-range": "bytes 0-2/10",
      "accept-ranges": "bytes",
      "content-security-policy": "sandbox",
      "x-content-type-options": "nosniff",
      "set-cookie": "leak=1",
      "x-internal": "no",
    },
  });
  const res = streamProxyResponse(upstream);
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-range"), "bytes 0-2/10");
  assert.equal(res.headers.get("content-security-policy"), "sandbox");
  assert.equal(res.headers.get("set-cookie"), null);
  assert.equal(res.headers.get("x-internal"), null);
  assert.equal(res.headers.get("cache-control"), "private, no-store");
});

test("streams the body without buffering — reads the first chunk of a never-ending stream right away", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("first"));
      // Don't close — if it buffered, it would wait here forever.
    },
  });
  const res = streamProxyResponse(new Response(body, { status: 200 }));
  const reader = res.body!.getReader();
  const { value } = await reader.read();
  assert.equal(new TextDecoder().decode(value), "first");
  await reader.cancel();
});

test("forces CSP and nosniff even if upstream doesn't send them", () => {
  const upstream = new Response("<script>alert(1)</script>", {
    status: 200,
    headers: { "content-type": "text/html" },
  });
  const res = streamProxyResponse(upstream);
  assert.equal(res.headers.get("content-security-policy"), "sandbox");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
});

test("overrides upstream's weak CSP with sandbox", () => {
  const upstream = new Response("abc", {
    status: 200,
    headers: { "content-security-policy": "default-src *" },
  });
  const res = streamProxyResponse(upstream);
  assert.equal(res.headers.get("content-security-policy"), "sandbox");
});

test("forceAttachment turns inline into attachment, and adds it if absent", () => {
  const withInline = streamProxyResponse(
    new Response("abc", {
      status: 200,
      headers: { "content-disposition": 'inline; filename="a.html"' },
    }),
    { forceAttachment: true },
  );
  assert.equal(withInline.headers.get("content-disposition"), 'attachment; filename="a.html"');

  const withoutDisposition = streamProxyResponse(new Response("abc", { status: 200 }), {
    forceAttachment: true,
    filename: "note.txt",
  });
  assert.equal(
    withoutDisposition.headers.get("content-disposition"),
    "attachment; filename*=UTF-8''note.txt",
  );
});
