import assert from "node:assert/strict";
import test from "node:test";

import { diagnoseUnreachable } from "./unreachable-hint";

test("컨테이너 안에서 루프백 주소면 그 사실을 짚는다", () => {
  for (const baseUrl of [
    "http://127.0.0.1:8643",
    "http://localhost:8643",
    "http://127.0.0.53:8643",
    "http://[::1]:8643",
  ]) {
    assert.equal(
      diagnoseUnreachable({ baseUrl, inContainer: true }),
      "gateway_loopback_in_container",
      baseUrl,
    );
  }
});

test("컨테이너가 아니면 루프백은 정상적인 주소다", () => {
  // 로컬에서 직접 실행하는 셀프호스팅 사용자에게는 127.0.0.1 이 맞는 답이다.
  assert.equal(
    diagnoseUnreachable({ baseUrl: "http://127.0.0.1:8643", inContainer: false }),
    "failed_to_reach_test_endpoint",
  );
});

test("컨테이너라도 외부 주소면 짚지 않는다", () => {
  for (const baseUrl of [
    "http://100.123.7.90:8643",
    "http://hermes.example.com",
    "http://10.0.0.5",
  ]) {
    assert.equal(
      diagnoseUnreachable({ baseUrl, inContainer: true }),
      "failed_to_reach_test_endpoint",
      baseUrl,
    );
  }
});

test("URL 이 아니면 짚지 않는다 — 추측으로 오진하지 않는다", () => {
  assert.equal(
    diagnoseUnreachable({ baseUrl: "127.0.0.1:8643", inContainer: true }),
    "failed_to_reach_test_endpoint",
  );
});
