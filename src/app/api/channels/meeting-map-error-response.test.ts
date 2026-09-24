import test from "node:test";
import assert from "node:assert/strict";
import { MeetingMapError } from "@/game/meeting-map-normalization";
import { meetingMapErrorResponse } from "./meeting-map-error-response";
import { isErrorCode } from "@/lib/i18n/error-codes";

type Body = { errorCode: string; reason?: string; error: string };

test("an invalid meeting map answers 422 with a translatable code, its reason and the English message", async () => {
  const response = meetingMapErrorResponse(new MeetingMapError("no_entrance"));
  assert.equal(response.status, 422);
  const body = (await response.json()) as Body;
  assert.equal(body.errorCode, "meeting_map_invalid");
  assert.ok(isErrorCode(body.errorCode));
  assert.equal(body.reason, "no_entrance");
  assert.equal(body.error, "Invalid meeting map: no walkable entrance");
});

test("an unexpected failure still answers with the code, no reason and no Korean text", async () => {
  const body = (await meetingMapErrorResponse("boom").json()) as Body;
  assert.equal(body.errorCode, "meeting_map_invalid");
  assert.equal(body.reason, undefined);
  assert.equal(body.error, "Could not validate the meeting map");
});
