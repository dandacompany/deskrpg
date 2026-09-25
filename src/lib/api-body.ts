/**
 * Request-body parsing for REST routes. A body that is empty, not JSON, or not a JSON object is
 * the client's mistake — the route answers 400 instead of letting `SyntaxError` become a 500.
 */
import { NextResponse } from "next/server";

export type JsonObject = Record<string, unknown>;

/** The body as a JSON object, or null when it is empty, malformed, or not an object. */
export async function readJsonObject(req: Request): Promise<JsonObject | null> {
  try {
    const parsed: unknown = await req.json();
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : null;
  } catch {
    return null;
  }
}

/** The 400 for a body `readJsonObject` rejected. Never carries the parser's message. */
export function invalidJsonBody() {
  return NextResponse.json(
    { errorCode: "invalid_request_body", error: "JSON object body required" },
    { status: 400 },
  );
}
