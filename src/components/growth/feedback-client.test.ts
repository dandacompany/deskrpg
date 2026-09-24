import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGithubIssueUrl,
  collectAttachments,
  fetchSurvey,
  FALLBACK_SURVEY,
  getInstallId,
  recentErrorDigest,
  recordClientError,
  resolveFeedbackUrl,
  type BugDraft,
} from "./feedback-client";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  };
}

test("the install ID is created once and the same value is used from then on", () => {
  const s = memoryStorage();
  const id = getInstallId(s);
  assert.match(id ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(getInstallId(s), id);
  assert.equal(getInstallId(null), null);
});

test("collection server URL: defaults when unset, off when empty", () => {
  assert.equal(resolveFeedbackUrl(undefined), "https://feedback.deskrpg.com");
  assert.equal(resolveFeedbackUrl(""), null);
  assert.equal(resolveFeedbackUrl("  "), null);
  assert.equal(resolveFeedbackUrl("https://example.test/"), "https://example.test");
});

test("only the last 5 recent errors are kept, each trimmed to one line", () => {
  for (let i = 0; i < 7; i++) recordClientError(`boom ${i}\nstack line`);
  const digest = recentErrorDigest();
  assert.equal(digest.split("\n").length, 5);
  assert.ok(digest.startsWith("boom 2"));
  assert.ok(!digest.includes("stack line"));
});

test("the GitHub issue URL includes only the attachments the user kept", () => {
  const attachments = collectAttachments({
    version: "2026.921.3",
    userAgent: "UA/1",
    viewport: "1440x900",
    errorDigest: "",
  });
  assert.deepEqual(
    attachments.map((a) => a.key),
    ["version", "userAgent", "viewport"],
  );
  const url = new URL(
    buildGithubIssueUrl(
      {
        title: "맵 멈춤",
        body: "회의 뒤",
        repro: "1. 회의",
        attachments: attachments.filter((a) => a.key !== "userAgent"),
      },
      "ko",
    ),
  );
  assert.equal(url.searchParams.get("title"), "맵 멈춤");
  const body = url.searchParams.get("body") ?? "";
  assert.ok(body.includes("회의 뒤") && body.includes("1. 회의") && body.includes("2026.921.3"));
  assert.ok(!body.includes("UA/1"));
  assert.equal(url.searchParams.get("labels"), "bug-report");
});

test("falls back to the built-in default survey when it can't be fetched from the server", async () => {
  const failing = async () => {
    throw new Error("offline");
  };
  assert.deepEqual(await fetchSurvey("https://x.test", failing as typeof fetch), FALLBACK_SURVEY);
  const ok = async () =>
    new Response(
      JSON.stringify({
        version: 2,
        intervalDays: 14,
        questions: [{ id: "a", type: "nps", prompt: { ko: "?" } }],
      }),
    );
  assert.equal((await fetchSurvey("https://x.test", ok as typeof fetch)).version, 2);
  const junk = async () => new Response(JSON.stringify({ version: "x" }));
  assert.deepEqual(await fetchSurvey("https://x.test", junk as typeof fetch), FALLBACK_SURVEY);
});

test("issue headings follow the reporter's language — Korean or English, English for the rest", () => {
  const draft: BugDraft = {
    title: "t",
    body: "b",
    repro: "r",
    attachments: [{ key: "version", value: "1" }],
  };
  const headings = (locale: string) =>
    (new URL(buildGithubIssueUrl(draft, locale)).searchParams.get("body") ?? "")
      .split("\n")
      .filter((line) => line.startsWith("## "));
  assert.deepEqual(headings("ko"), ["## 문제 설명", "## 재현 방법", "## 디버그 정보"]);
  assert.deepEqual(headings("en"), ["## Problem", "## Steps to reproduce", "## Debug info"]);
  assert.deepEqual(headings("ja"), headings("en"));
  assert.deepEqual(headings("zh"), headings("en"));
});
