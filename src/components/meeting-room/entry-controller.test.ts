import assert from "node:assert/strict";
import test from "node:test";
import { MeetingEntryController } from "./entry-controller";

test("does not open the UI before arrival, and ignores repeated requests and late arrivals", () => {
  const effects: string[] = [];
  const entry = new MeetingEntryController((event) => effects.push(event));
  entry.request();
  entry.request();
  assert.deepEqual(effects, ["request"]);
  assert.equal(entry.state.status, "walking");
  entry.cancel();
  entry.arrival({ status: "arrived" });
  assert.equal(entry.state.status, "idle");
  entry.request();
  entry.arrival({ status: "arrived" });
  assert.equal(entry.state.status, "joining");
  entry.joined();
  assert.equal(entry.state.status, "joined");
  entry.cancel();
  assert.equal(entry.state.status, "idle");
});

test("supports synchronous arrival and retry after rejection", () => {
  const entry = new MeetingEntryController((event) => {
    if (event === "request") entry.arrival({ status: "arrived" });
  });
  entry.request();
  assert.equal(entry.state.status, "joining");
  entry.fail("forbidden");
  assert.equal(entry.state.reasonCode, "forbidden");
  entry.joined();
  assert.equal(entry.state.status, "failed");
  entry.request();
  assert.equal(entry.state.status, "joining");
});
