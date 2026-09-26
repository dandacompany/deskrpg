import assert from "node:assert/strict";
import test from "node:test";

import type { RoomMessage } from "@/lib/chat-rooms-policy";

import {
  acknowledgeReport,
  EMPTY_REPORT_ACK,
  parseReportAck,
  pendingReports,
  planReportAckLoad,
  serializeReportAck,
} from "./report-queue";

const msg = (over: Partial<RoomMessage> & { id: string }): RoomMessage => ({
  roomId: "office",
  senderKind: "npc",
  senderId: "npc-1",
  senderName: "소피",
  content: "카드",
  createdAt: "2026-09-21T00:00:00.000Z",
  notice: null,
  ...over,
});

const card = (
  id: string,
  kind: "card_review" | "card_blocked" | "card_done",
  createdAt: string,
  npcId = "npc-1",
) =>
  msg({
    id,
    senderId: npcId,
    createdAt,
    notice: { kind, cardId: `c-${id}`, cardTitle: `제목 ${id}`, boardSlug: "b", npcName: "소피" },
  });

const present = ["npc-1", "npc-2"];

test("report targets are only review, blocked, done and failed cron jobs", () => {
  const messages = [
    card("a", "card_review", "2026-09-21T00:00:01.000Z"),
    card("b", "card_blocked", "2026-09-21T00:00:02.000Z"),
    card("c", "card_done", "2026-09-21T00:00:03.000Z"),
    msg({
      id: "d",
      createdAt: "2026-09-21T00:00:04.000Z",
      notice: { kind: "cron_result", jobId: "j", jobName: "야간", npcName: "소피", status: "ok" },
    }),
    msg({
      id: "e",
      createdAt: "2026-09-21T00:00:05.000Z",
      notice: {
        kind: "cron_result",
        jobId: "j",
        jobName: "야간",
        npcName: "소피",
        status: "error",
      },
    }),
    msg({ id: "f", createdAt: "2026-09-21T00:00:06.000Z" }),
  ];
  assert.deepEqual(
    pendingReports(messages, EMPTY_REPORT_ACK, present).map((r) => r.messageId),
    ["a", "b", "c", "e"],
    "성공한 크론과 일반 메시지는 보고가 아니다",
  );
});

test("lined up in order of occurrence — even when the list arrives shuffled", () => {
  const messages = [
    card("late", "card_review", "2026-09-21T00:00:09.000Z"),
    card("early", "card_blocked", "2026-09-21T00:00:01.000Z"),
    card("mid", "card_done", "2026-09-21T00:00:05.000Z"),
  ];
  assert.deepEqual(
    pendingReports(messages, EMPTY_REPORT_ACK, present).map((r) => r.messageId),
    ["early", "mid", "late"],
  );
});

test("reports before the acknowledgment point are excluded — the point itself counts as acknowledged too", () => {
  const messages = [
    card("old", "card_review", "2026-09-21T00:00:01.000Z"),
    card("edge", "card_review", "2026-09-21T00:00:05.000Z"),
    card("new", "card_review", "2026-09-21T00:00:09.000Z"),
  ];
  assert.deepEqual(
    pendingReports(messages, parseReportAck("2026-09-21T00:00:05.000Z"), present).map(
      (r) => r.messageId,
    ),
    ["new"],
  );
});

test("reports of NPCs not on the map are not queued — there is nobody to walk over", () => {
  const messages = [
    card("gone", "card_review", "2026-09-21T00:00:01.000Z", "npc-absent"),
    card("here", "card_review", "2026-09-21T00:00:02.000Z", "npc-2"),
  ];
  assert.deepEqual(
    pendingReports(messages, EMPTY_REPORT_ACK, present).map((r) => r.messageId),
    ["here"],
  );
});

test("notices without a sender id (system substitute) are not queued", () => {
  const orphan = card("sys", "card_review", "2026-09-21T00:00:01.000Z");
  assert.deepEqual(
    pendingReports(
      [{ ...orphan, senderKind: "system", senderId: null }],
      EMPTY_REPORT_ACK,
      present,
    ),
    [],
  );
});

test("report entries carry the values needed to go to the card", () => {
  const [item] = pendingReports(
    [card("a", "card_review", "2026-09-21T00:00:01.000Z")],
    EMPTY_REPORT_ACK,
    present,
  );
  assert.deepEqual(item, {
    messageId: "a",
    jobId: null,
    npcId: "npc-1",
    npcName: "소피",
    kind: "card_review",
    cardId: "c-a",
    boardSlug: "b",
    cardTitle: "제목 a",
    summary: "카드",
    createdAt: "2026-09-21T00:00:01.000Z",
  });
});

test("a cron failure report opens the cron history, not a card", () => {
  const [item] = pendingReports(
    [
      msg({
        id: "cron",
        createdAt: "2026-09-21T00:00:01.000Z",
        notice: {
          kind: "cron_result",
          jobId: "job-7",
          jobName: "야간 집계",
          npcName: "소피",
          status: "error",
        },
      }),
    ],
    EMPTY_REPORT_ACK,
    present,
  );
  assert.equal(item.kind, "cron_failed");
  assert.equal(item.cardId, null, "열 카드가 없다");
  assert.equal(item.jobId, "job-7", "대신 크론 이력으로 갈 값을 싣는다");
  assert.equal(item.cardTitle, "야간 집계");
});

test("card reports have no jobId", () => {
  const [item] = pendingReports(
    [card("a", "card_review", "2026-09-21T00:00:01.000Z")],
    EMPTY_REPORT_ACK,
    present,
  );
  assert.equal(item.jobId, null);
});

test("an old string watermark reads everything before that time as acknowledged — backward compatibility", () => {
  assert.deepEqual(parseReportAck("2026-09-21T00:00:05.000Z"), {
    through: "2026-09-21T00:00:05.000Z",
    ids: [],
  });
  assert.deepEqual(parseReportAck(null), EMPTY_REPORT_ACK);
  assert.deepEqual(parseReportAck("{깨짐"), EMPTY_REPORT_ACK);
});

test("acknowledgments accumulate per report and are saved and restored", () => {
  const ack = acknowledgeReport(
    acknowledgeReport(parseReportAck("2026-09-21T00:00:05.000Z"), "b"),
    "b",
  );
  assert.deepEqual(ack.ids, ["b"], "같은 건을 두 번 넣지 않는다");
  assert.deepEqual(parseReportAck(serializeReportAck(ack)), ack);
});

test("loading acks: the server record wins, and a browser leftover is imported once", () => {
  const server = { through: "2026-09-21T00:00:00.000Z", ids: ["a"] };
  const local = { through: null, ids: ["b"] };
  assert.deepEqual(planReportAckLoad(server, EMPTY_REPORT_ACK), { use: server, importLocal: null });
  assert.deepEqual(planReportAckLoad(server, local), {
    use: { through: server.through, ids: ["a", "b"] },
    importLocal: local,
  });
  assert.deepEqual(planReportAckLoad(null, local), { use: local, importLocal: local });
  assert.deepEqual(planReportAckLoad(null, EMPTY_REPORT_ACK), {
    use: EMPTY_REPORT_ACK,
    importLocal: null,
  });
});
