import { test, mock } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { NextRequest } from "next/server";

import { withPreviewSlot } from "@/lib/link-preview/service";
import { GET } from "./route";

test("image GET returns 204 immediately when HTML fetches occupy all 8 slots", async () => {
  const releases: Array<() => void> = [];
  const pending = Array.from({ length: 8 }, () =>
    withPreviewSlot(() => new Promise<void>((resolve) => releases.push(resolve))),
  );
  let networkCalls = 0;
  const network = mock.method(https, "request", () => {
    networkCalls++;
    throw new Error("포화 중 네트워크 요청");
  });
  syncBuiltinESMExports();
  try {
    const req = new NextRequest(
      "http://localhost/api/link-preview/image?url=https%3A%2F%2Fexample.com%2Fpicture.png",
      { headers: { "x-user-id": "test-user" } },
    );
    const res = await GET(req);
    assert.equal(res.status, 204);
    assert.equal(networkCalls, 0, "포화 시 네트워크를 열지 않는다");
  } finally {
    network.mock.restore();
    syncBuiltinESMExports();
    releases.forEach((release) => release());
    await Promise.all(pending);
  }
});
