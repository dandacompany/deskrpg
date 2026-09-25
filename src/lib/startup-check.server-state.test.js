const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const { checkServerState, probeHttp } = require("./startup-check.js");

// doctor used to report only whether the port could be bound. With DeskRPG itself running it said
// "another process uses the port — stop it", and after a background server died it said
// "healthy" with a stale PID file left behind. It now reads the PID file and asks the port.

const EN = { LANG: "en_US.UTF-8" };

test("a running server that answers is reported as running, and its port is not a conflict", () => {
  const state = checkServerState({ pid: 4242, alive: true, responding: true, port: 3000 }, EN);
  assert.equal(state.status, "ok");
  assert.match(state.message, /PID 4242/);
  assert.equal(state.portInUseIsOurs, true);
});

test("a PID file whose process is gone is flagged — the server stopped without deskrpg stop", () => {
  const state = checkServerState({ pid: 4242, alive: false, responding: false, port: 3000 }, EN);
  assert.equal(state.status, "warn");
  assert.match(state.message, /4242/);
  assert.match(state.message, /deskrpg start/);
  assert.equal(state.portInUseIsOurs, false);
});

test("a live process that does not answer on the port is flagged", () => {
  const state = checkServerState({ pid: 4242, alive: true, responding: false, port: 3000 }, EN);
  assert.equal(state.status, "warn");
  assert.match(state.message, /3000/);
});

test("no PID file and nothing answering is simply 'not running'", () => {
  const state = checkServerState({ pid: null, alive: false, responding: false, port: 3000 }, EN);
  assert.equal(state.status, "ok");
  assert.equal(state.portInUseIsOurs, false);
});

test("probeHttp tells an answering port from a silent one", async () => {
  const server = http.createServer((_req, res) => {
    res.statusCode = 307;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    assert.equal(await probeHttp(port), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(await probeHttp(port, 500), false);
});
