import assert from "node:assert/strict";
import test from "node:test";

import type { ParsedMeetingOutcome } from "./meeting-outcome";
import { resummarizeMinutes, type ResummarizeMinutesDeps } from "./meeting-summarize";

const row = {
  id: "m1",
  channelId: "c1",
  topic: "주제",
  transcript: "전문",
  initiatorId: "host",
  participants: [
    { id: "npc-1", name: "소피", type: "npc" },
    { id: "socket-9", name: "Dante", type: "player" },
  ],
  summaryStatus: "failed",
  outcome: null,
};
const ok: ParsedMeetingOutcome = {
  status: "ok",
  keyTopics: ["a"],
  conclusions: "b",
  outcome: { decisions: ["d"], followUps: [], project: null },
};

function deps(over: Partial<ResummarizeMinutesDeps> = {}): ResummarizeMinutesDeps & {
  saved: unknown[];
} {
  const saved: unknown[] = [];
  return {
    saved,
    loadMinutes: async () => row,
    loadChannelOwner: async () => "owner",
    resummarize: async () => ok,
    saveSummary: async (_id, summary) => {
      saved.push(summary);
    },
    ...over,
  };
}

test("when the host retries a failed summary, the result is saved and returned", async () => {
  const d = deps({
    resummarize: async (input) => {
      // The assignee candidates are only the attending **employees**.
      assert.deepEqual(input.participants, [{ npcId: "npc-1", name: "소피" }]);
      return ok;
    },
  });
  const result = await resummarizeMinutes({ minutesId: "m1", userId: "host" }, d);
  assert.deepEqual(result, { ok: true, summary: ok });
  assert.deepEqual(d.saved, [ok]);
});

test("403 and calls nothing when the caller is neither the host nor the owner", async () => {
  const d = deps({ resummarize: async () => assert.fail("부르면 안 된다") });
  const result = await resummarizeMinutes({ minutesId: "m1", userId: "member" }, d);
  assert.deepEqual(result, { ok: false, status: 403, errorCode: "forbidden" });
});

test("404 for minutes that don't exist", async () => {
  const result = await resummarizeMinutes(
    { minutesId: "x", userId: "host" },
    deps({ loadMinutes: async () => null }),
  );
  assert.deepEqual(result, { ok: false, status: 404, errorCode: "not_found" });
});

test("doesn't overwrite the summary of an already-registered meeting — it would desync the card and the draft", async () => {
  const registered = {
    ...row,
    summaryStatus: "ok",
    outcome: {
      decisions: [],
      followUps: [],
      project: null,
      registered: { boardSlug: "b", tenant: null, taskIds: ["t1"], by: "host", at: "2026-09-21" },
    },
  };
  const result = await resummarizeMinutes(
    { minutesId: "m1", userId: "host" },
    deps({ loadMinutes: async () => registered }),
  );
  assert.deepEqual(result, { ok: false, status: 409, errorCode: "already_registered" });
});

test("503 when there's no socket server hook — doesn't overwrite with an empty summary", async () => {
  const d = deps({ resummarize: undefined });
  const result = await resummarizeMinutes({ minutesId: "m1", userId: "owner" }, d);
  assert.deepEqual(result, { ok: false, status: 503, errorCode: "summarizer_unavailable" });
  assert.deepEqual(d.saved, []);
});

test("if the retry also fails, it's still saved (the state persists) and the failure is returned as-is", async () => {
  const failed: ParsedMeetingOutcome = {
    status: "failed",
    keyTopics: [],
    conclusions: null,
    outcome: null,
  };
  const d = deps({ resummarize: async () => failed });
  const result = await resummarizeMinutes({ minutesId: "m1", userId: "owner" }, d);
  assert.deepEqual(result, { ok: true, summary: failed });
  assert.deepEqual(d.saved, [failed]);
});

// The retry summarizes in the language of whoever retries, not the meeting opener's.
test("a retry passes the requester's locale to the summarizer", async () => {
  const locales: unknown[] = [];
  const d = deps({
    resummarize: async (input) => {
      locales.push(input.locale);
      return ok;
    },
  });
  await resummarizeMinutes({ minutesId: "m1", userId: "host", locale: "ja" }, d);
  await resummarizeMinutes({ minutesId: "m1", userId: "host", locale: null }, d);
  assert.deepEqual(locales, ["ja", null]);
});
