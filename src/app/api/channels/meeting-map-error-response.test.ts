import test from "node:test";
import assert from "node:assert/strict";
import { MeetingMapError } from "@/game/meeting-map-normalization";
import { meetingMapErrorResponse } from "./meeting-map-error-response";
import { isErrorCode } from "@/lib/i18n/error-codes";

test("an invalid meeting map answers 422 with a translatable code and the English reason", async () => {
  const response = meetingMapErrorResponse(new MeetingMapError("no_entrance"));
  assert.equal(response.status, 422);
  const body = (await response.json()) as { errorCode: string; error: string };
  assert.equal(body.errorCode, "meeting_map_invalid");
  assert.ok(isErrorCode(body.errorCode));
  assert.equal(body.error, "Invalid meeting map: no walkable entrance");
});

test("an unexpected failure still answers with the code and no Korean text", async () => {
  const body = (await meetingMapErrorResponse("boom").json()) as {
    errorCode: string;
    error: string;
  };
  assert.equal(body.errorCode, "meeting_map_invalid");
  assert.equal(body.error, "Could not validate the meeting map");
});
