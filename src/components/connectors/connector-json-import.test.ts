import test from "node:test";
import assert from "node:assert/strict";

import { parseMcpJson } from "./connector-json-import";

test("reads the mcpServers shape and drops env values", () => {
  const r = parseMcpJson(
    JSON.stringify({
      mcpServers: {
        fs: { command: "npx", args: ["-y", "@x/fs"], env: { TOKEN: "secret" } },
      },
    }),
  );
  assert.deepEqual(r, {
    ok: true,
    input: {
      name: "fs",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@x/fs"],
      env: { TOKEN: "" },
      auth: "env",
    },
  });
});

test("reads a named http server", () => {
  const r = parseMcpJson(
    JSON.stringify({
      linear: { url: "https://mcp.linear.app/sse", headers: { Authorization: "Bearer x" } },
    }),
  );
  assert.deepEqual(r, {
    ok: true,
    input: { name: "linear", transport: "http", url: "https://mcp.linear.app/sse", auth: "bearer" },
  });
});

test("reads a flat entry that carries its own name", () => {
  const r = parseMcpJson(
    JSON.stringify({ name: "fs", command: "npx", args: ["@x/fs"], env: { KEY: "v" } }),
  );
  assert.deepEqual(r, {
    ok: true,
    input: {
      name: "fs",
      transport: "stdio",
      command: "npx",
      args: ["@x/fs"],
      env: { KEY: "" },
      auth: "env",
    },
  });
});

test("keeps an explicit oauth auth on an http server", () => {
  const r = parseMcpJson(
    JSON.stringify({ canva: { url: "https://mcp.canva.com", auth: "oauth" } }),
  );
  assert.deepEqual(r, {
    ok: true,
    input: { name: "canva", transport: "http", url: "https://mcp.canva.com", auth: "oauth" },
  });
});

test("rejects junk", () => {
  for (const raw of ["", "{", "[]", "null", JSON.stringify({ a: 1 }), JSON.stringify({ x: {} })]) {
    assert.deepEqual(parseMcpJson(raw), { ok: false }, raw);
  }
});
