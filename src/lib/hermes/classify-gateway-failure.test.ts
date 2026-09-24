import assert from "node:assert/strict";
import test from "node:test";

import { classifyGatewayFailure, gatewayFailureMessageCode } from "./classify-gateway-failure";
import { HermesError } from "./hermes-client";

test("classifies a gateway that is down as unreachable", () => {
  const err = new HermesError("unreachable", "fetch failed", 0);
  assert.equal(classifyGatewayFailure(err), "unreachable");
});

test("classifies a rejected key as an auth failure", () => {
  assert.equal(
    classifyGatewayFailure(new HermesError("unauthorized", "Unauthorized", 401)),
    "auth",
  );
  assert.equal(classifyGatewayFailure(new HermesError("unauthorized", "Forbidden", 403)), "auth");
});

test("classifies an aborted request as a timeout, not unreachable", () => {
  // HermesClient.request wraps everything fetch throws as unreachable —
  // trusting the code alone, a timeout would always look like "the gateway is down".
  const wrapped = new HermesError("unreachable", "This operation was aborted", 0);
  assert.equal(classifyGatewayFailure(wrapped), "timeout");

  const abort = new Error("aborted");
  abort.name = "AbortError";
  assert.equal(classifyGatewayFailure(abort), "timeout");
});

test("classifies a socket-timeout cause code as a timeout", () => {
  const err = Object.assign(new TypeError("fetch failed"), {
    cause: { code: "UND_ERR_HEADERS_TIMEOUT" },
  });
  assert.equal(classifyGatewayFailure(err), "timeout");
});

test("classifies a connection-refused cause code as unreachable", () => {
  for (const code of ["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH"]) {
    const err = Object.assign(new TypeError("fetch failed"), { cause: { code } });
    assert.equal(classifyGatewayFailure(err), "unreachable", code);
  }
});

test("folds other Hermes error codes into unknown error", () => {
  assert.equal(classifyGatewayFailure(new HermesError("http_error", "HTTP 500", 500)), "unknown");
  assert.equal(
    classifyGatewayFailure(new HermesError("run_failed", "model error", 200)),
    "unknown",
  );
  assert.equal(
    classifyGatewayFailure(new HermesError("unknown_profile", "Unknown profile", 404)),
    "unknown",
  );
});

test("classifies no structured information at all as unknown error", () => {
  assert.equal(classifyGatewayFailure(new Error("boom")), "unknown");
  assert.equal(classifyGatewayFailure(null), "unknown");
  assert.equal(classifyGatewayFailure("something"), "unknown");
});

test("recognizes an auth failure from the message even for non-HermesError exceptions", () => {
  assert.equal(classifyGatewayFailure(new Error("invalid api key")), "auth");
  assert.equal(classifyGatewayFailure(new Error("Unauthorized")), "auth");
});

test("classification result maps to the npc:response message code", () => {
  assert.equal(
    gatewayFailureMessageCode(new HermesError("unreachable", "fetch failed", 0)),
    "gateway_unreachable",
  );
  assert.equal(
    gatewayFailureMessageCode(new HermesError("unauthorized", "Unauthorized", 401)),
    "gateway_auth_failed",
  );
  assert.equal(gatewayFailureMessageCode(new Error("boom")), "gateway_unknown_error");
});
