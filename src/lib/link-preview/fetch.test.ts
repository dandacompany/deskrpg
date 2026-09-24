import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";

import { fetchGuarded, isAllowedPreviewUrl } from "./fetch";

/**
 * The test server lives on loopback, and the real guard blocks loopback. So only
 * **127.0.0.1** is opened as an exception, and everything else is left to the real guard —
 * that way the private-network redirect test doesn't lose its meaning.
 */
const allowAll = async (url: URL) =>
  url.hostname === "127.0.0.1" || (await isAllowedPreviewUrl(url));

async function serve(
  handler: (url: string) => { status?: number; headers?: Record<string, string>; body?: string },
): Promise<{ origin: string; close: () => void; hits: string[] }> {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(req.url ?? "");
    const out = handler(req.url ?? "");
    res.writeHead(out.status ?? 200, { "content-type": "text/html", ...(out.headers ?? {}) });
    res.end(out.body ?? "");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  return { origin: `http://127.0.0.1:${addr.port}`, close: () => server.close(), hits };
}

test("fetches the body and returns the final URL alongside it", async () => {
  const s = await serve(() => ({ body: "<title>안녕</title>" }));
  try {
    const got = await fetchGuarded(new URL(`${s.origin}/p`), {
      accept: "text/html",
      maxBytes: 1024,
      isAllowedUrl: allowAll,
      isAllowedAddress: () => true,
    });
    assert.equal(got?.body, "<title>안녕</title>");
    assert.equal(got?.url.toString(), `${s.origin}/p`);
  } finally {
    s.close();
  }
});

test("a body over the limit gets truncated — doesn't hang on an infinite stream", async () => {
  const s = await serve(() => ({ body: "x".repeat(5000) }));
  try {
    const got = await fetchGuarded(new URL(`${s.origin}/big`), {
      accept: "text/html",
      maxBytes: 100,
      isAllowedUrl: allowAll,
      isAllowedAddress: () => true,
    });
    assert.equal(got?.body.length, 100);
  } finally {
    s.close();
  }
});

test("discards the response when content-type doesn't match", async () => {
  const s = await serve(() => ({ headers: { "content-type": "application/pdf" }, body: "%PDF" }));
  try {
    assert.equal(
      await fetchGuarded(new URL(`${s.origin}/f.pdf`), {
        accept: "text/html",
        maxBytes: 1024,
        isAllowedUrl: allowAll,
        isAllowedAddress: () => true,
      }),
      null,
    );
  } finally {
    s.close();
  }
});

test("follows a redirect itself and re-checks the address on every hop", async () => {
  const s = await serve((url) =>
    url === "/a" ? { status: 302, headers: { location: "/b" } } : { body: "<title>도착</title>" },
  );
  try {
    const got = await fetchGuarded(new URL(`${s.origin}/a`), {
      accept: "text/html",
      maxBytes: 1024,
      isAllowedUrl: allowAll,
      isAllowedAddress: () => true,
    });
    assert.equal(got?.url.pathname, "/b");
    assert.deepEqual(s.hits, ["/a", "/b"]);
  } finally {
    s.close();
  }
});

test("stops right there on a redirect to a private network — the whole reason this guard exists", async () => {
  const s = await serve(() => ({
    status: 302,
    headers: { location: "http://169.254.169.254/latest/meta-data/" },
  }));
  try {
    assert.equal(
      await fetchGuarded(new URL(`${s.origin}/a`), {
        accept: "text/html",
        maxBytes: 1024,
        isAllowedUrl: allowAll,
        isAllowedAddress: () => true,
      }),
      null,
    );
  } finally {
    s.close();
  }
});

test("gives up when the redirect chain is too long", async () => {
  let n = 0;
  const s = await serve(() => ({ status: 302, headers: { location: `/hop${n++}` } }));
  try {
    assert.equal(
      await fetchGuarded(new URL(`${s.origin}/a`), {
        accept: "text/html",
        maxBytes: 1024,
        isAllowedUrl: allowAll,
        isAllowedAddress: () => true,
      }),
      null,
    );
    assert.ok(s.hits.length <= 3, `홉이 너무 많다: ${s.hits.length}`);
  } finally {
    s.close();
  }
});

test("never sends a request at all to an address the guard rejects", async () => {
  const s = await serve(() => ({ body: "<title>x</title>" }));
  try {
    assert.equal(
      await fetchGuarded(new URL(`${s.origin}/p`), {
        accept: "text/html",
        maxBytes: 1024,
        isAllowedUrl: async () => false,
      }),
      null,
    );
    assert.deepEqual(s.hits, []);
  } finally {
    s.close();
  }
});

test("can't reach loopback when the pre-connect address check is the default — this is where rebinding gets blocked", async () => {
  const s = await serve(() => ({ body: "<title>x</title>" }));
  try {
    // Only the address policy is left at its default (the URL policy is left open) — the
    // socket gets caught on the real IP.
    const got = await fetchGuarded(new URL(`${s.origin}/p`), {
      accept: "text/html",
      maxBytes: 1024,
      isAllowedUrl: async () => true,
    });
    assert.equal(got, null);
    assert.deepEqual(s.hits, []);
  } finally {
    s.close();
  }
});

test("stops right there even on a redirect to an IPv4-mapped IPv6 address — the same check applies on every hop", async () => {
  const s = await serve(() => ({ status: 302, headers: { location: "http://[::ffff:7f00:1]/" } }));
  try {
    // Leave the URL policy at its default (the real guard) and open only the first hop — it
    // must get caught on the second hop.
    const got = await fetchGuarded(new URL(`${s.origin}/a`), {
      accept: "text/html",
      maxBytes: 1024,
      isAllowedUrl: allowAll,
      isAllowedAddress: (a) => a === "127.0.0.1",
    });
    assert.equal(got, null);
    assert.deepEqual(s.hits, ["/a"]);
  } finally {
    s.close();
  }
});

test("doesn't accept a compressed response — a limit on pre-compression bytes isn't a limit", async () => {
  const s = await serve(() => ({
    headers: { "content-encoding": "gzip" },
    body: "not really gzip",
  }));
  try {
    assert.equal(
      await fetchGuarded(new URL(`${s.origin}/z`), {
        accept: "text/html",
        maxBytes: 1024,
        isAllowedUrl: allowAll,
        isAllowedAddress: () => true,
      }),
      null,
    );
  } finally {
    s.close();
  }
});

test(
  "gives up on a slowly-trickling body too once the overall 8 seconds pass",
  { timeout: 12000 },
  async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.write("start");
      const interval = setInterval(() => res.write("x"), 1000);
      res.on("close", () => clearInterval(interval));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const started = Date.now();
    try {
      const got = await fetchGuarded(new URL(`http://127.0.0.1:${address.port}/`), {
        accept: "text/html",
        maxBytes: 1024,
        isAllowedUrl: allowAll,
        isAllowedAddress: () => true,
      });
      assert.equal(got, null);
      assert.ok(Date.now() - started < 10000);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  },
);

test(
  "finishes within the overall budget even for a server that never sends headers",
  { timeout: 12000 },
  async () => {
    const server = createServer(() => {});
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const started = Date.now();
    try {
      const got = await fetchGuarded(new URL(`http://127.0.0.1:${address.port}/`), {
        accept: "text/html",
        maxBytes: 1024,
        isAllowedUrl: allowAll,
        isAllowedAddress: () => true,
      });
      assert.equal(got, null);
      assert.ok(Date.now() - started < 10000);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  },
);

test("doesn't restart the clock on every redirect", { timeout: 12000 }, async () => {
  const server = createServer((req, res) => {
    setTimeout(() => {
      if (res.destroyed) return;
      const n = Number(req.url?.slice(1) ?? 0);
      if (n < 2) res.writeHead(302, { location: `/${n + 1}` }).end();
      else res.writeHead(200, { "content-type": "text/html" }).end("done");
    }, 3000);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const started = Date.now();
  try {
    const got = await fetchGuarded(new URL(`http://127.0.0.1:${address.port}/0`), {
      accept: "text/html",
      maxBytes: 1024,
      isAllowedUrl: allowAll,
      isAllowedAddress: () => true,
    });
    assert.equal(got, null);
    assert.ok(Date.now() - started < 10000);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("closes the previous socket of a redirect whose body never ends", async () => {
  let closed = false;
  const server = createServer((req, res) => {
    if (req.url === "/first") {
      res.writeHead(302, { location: "/final" });
      res.write("unused");
      res.on("close", () => {
        closed = true;
      });
      return;
    }
    res.writeHead(200, { "content-type": "text/html" }).end("done");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const got = await fetchGuarded(new URL(`http://127.0.0.1:${address.port}/first`), {
      accept: "text/html",
      maxBytes: 1024,
      isAllowedUrl: allowAll,
      isAllowedAddress: () => true,
    });
    assert.equal(got?.body, "done");
    for (let i = 0; i < 20 && !closed; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(closed, true);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
