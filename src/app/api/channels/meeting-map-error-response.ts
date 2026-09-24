import { NextResponse } from "next/server";
import { MeetingMapError } from "@/game/meeting-map-normalization";

/** Shared 422 body for both channel routes; the screen translates `errorCode`, `error` stays English. */
export function meetingMapErrorResponse(error: unknown) {
  return NextResponse.json(
    {
      errorCode: "meeting_map_invalid",
      error:
        error instanceof MeetingMapError ? error.message : "Could not validate the meeting map",
    },
    { status: 422 },
  );
}
