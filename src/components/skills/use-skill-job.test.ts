import "../../test-setup/dom";
import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { renderHook } from "@testing-library/react";

import { SkillsApiError, type SkillsApi } from "./skills-api";
import { useSkillJob } from "./use-skill-job";

function fakeApi(states: string[]) {
  const seen: string[] = [];
  const api = {
    job: async (_kind: string, id: string) => {
      seen.push(id);
      const state = states.shift() ?? "succeeded";
      return {
        jobId: id,
        kind: "hub_install",
        state,
        exitCode: state === "running" ? null : state === "failed" ? 1 : 0,
        outputTail: state === "failed" ? "boom" : "",
      };
    },
  } as unknown as SkillsApi;
  return { api, seen };
}

const wait = (ms: number) => act(async () => new Promise((r) => setTimeout(r, ms)));

test("keeps polling while running, stops once it's done", async () => {
  const { api, seen } = fakeApi(["running", "running", "succeeded"]);
  const { result } = renderHook(() => useSkillJob(api, { intervalMs: 1, timeoutMs: 1000 }));
  await act(async () => {
    await result.current.start("hub", async () => "j1");
  });
  await wait(40);
  assert.equal(result.current.state, "succeeded");
  assert.equal(seen.length, 3);
  await wait(20);
  assert.equal(seen.length, 3);
});

test("on failure leaves failed and the output tail", async () => {
  const { api } = fakeApi(["failed"]);
  const { result } = renderHook(() => useSkillJob(api, { intervalMs: 1, timeoutMs: 1000 }));
  await act(async () => {
    await result.current.start("hub", async () => "j1");
  });
  await wait(10);
  assert.equal(result.current.state, "failed");
  assert.equal(result.current.job?.outputTail, "boom");
});

test("stops polling on unmount", async () => {
  const { api, seen } = fakeApi(Array(1000).fill("running"));
  const { result, unmount } = renderHook(() =>
    useSkillJob(api, { intervalMs: 1, timeoutMs: 10_000 }),
  );
  await act(async () => {
    await result.current.start("hub", async () => "j1");
  });
  unmount();
  const before = seen.length;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(seen.length, before);
});

test("starting a new job discards the previous job's polling", async () => {
  const { api, seen } = fakeApi(Array(1000).fill("running"));
  const { result } = renderHook(() => useSkillJob(api, { intervalMs: 5, timeoutMs: 10_000 }));
  await act(async () => {
    await result.current.start("hub", async () => "old");
  });
  await act(async () => {
    await result.current.start("hub", async () => "new");
  });
  const oldBefore = seen.filter((id) => id === "old").length;
  await wait(40);
  assert.equal(seen.filter((id) => id === "old").length, oldBefore);
});

test("busy if starting hits job_busy, unknown if polling hits job_unknown", async () => {
  const api = {
    job: async () => {
      throw new SkillsApiError(404, "job_unknown", "");
    },
  } as unknown as SkillsApi;
  const { result } = renderHook(() => useSkillJob(api, { intervalMs: 1, timeoutMs: 1000 }));
  await act(async () => {
    await result.current.start("hub", async () => {
      throw new SkillsApiError(409, "job_busy", "");
    });
  });
  assert.equal(result.current.state, "busy");
  await act(async () => {
    await result.current.start("hub", async () => "j2");
  });
  await wait(10);
  assert.equal(result.current.state, "unknown");
});

test("stops with unknown once the timeout is exceeded", async () => {
  const { api } = fakeApi(Array(1000).fill("running"));
  const { result } = renderHook(() => useSkillJob(api, { intervalMs: 2, timeoutMs: 10 }));
  await act(async () => {
    await result.current.start("curator", async () => "j1");
  });
  await wait(60);
  assert.equal(result.current.state, "unknown");
});
