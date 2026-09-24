import { NextResponse } from "next/server";
import { MeetingMapError } from "@/game/meeting-map-normalization";

/** Shared 422 body for both channel routes; the screen translates `errorCode` + `reason`, `error` stays English. */
export function meetingMapErrorResponse(error: unknown) {
  return NextResponse.json(
    {
      errorCode: "meeting_map_invalid",
      ...(error instanceof MeetingMapError ? { reason: error.reason } : {}),
      error:
        error instanceof MeetingMapError ? error.message : "Could not validate the meeting map",
    },
    { status: 422 },
  );
}
