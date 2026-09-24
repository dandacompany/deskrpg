// Hermes API Server SSE frame parser.
//
// Hermes uses **two dialects**. Measured (v0.20.2):
//
//   /api/sessions/<id>/chat/stream  (1:1)   "event: assistant.delta\ndata: {...}\n\n"
//   /v1/runs/<id>/events            (meeting) "data: {\"event\": \"message.delta\", ...}\n\n"
//
// The second has no `event:` line at all; the name lives inside the data JSON. So this parser, which only looked
// at `event:` lines, read every frame on the meeting path as the name "message"; as a result
// no delta ever accumulated and the poll response was always an empty string — NPCs were clearly answering
// "SPEAK: …" yet every one of them was tallied as PASS.

export type SseEvent = { event: string; data: Record<string, unknown> };

function parseFrame(raw: string): SseEvent | null {
  let eventName = "message";
  const dataLines: string[] = [];

  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }

  if (dataLines.length === 0) return null;

  try {
    const parsed = JSON.parse(dataLines.join("\n")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const data = parsed as Record<string, unknown>;
    // Without an `event:` line, the event field inside the payload is the name (the second dialect above).
    // If the line exists it wins — that is the explicit signal.
    const resolved =
      eventName === "message" && typeof data.event === "string" && data.event
        ? data.event
        : eventName;
    return { event: resolved, data };
  } catch {
    // A malformed frame must not kill the stream — the rest is still useful.
    return null;
  }
}

export function createSseParser() {
  let buffer = "";

  return {
    push(chunk: string): SseEvent[] {
      buffer += chunk;
      const events: SseEvent[] = [];
      let boundary = buffer.indexOf("\n\n");

      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseFrame(frame);
        if (parsed) events.push(parsed);
        boundary = buffer.indexOf("\n\n");
      }

      return events;
    },

    flush(): SseEvent[] {
      buffer = "";
      return [];
    },
  };
}
