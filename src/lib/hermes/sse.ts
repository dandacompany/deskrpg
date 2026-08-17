// Hermes API Server SSE frame parser.
// Wire format (api_server.py:_sse_frame): "event: <name>\ndata: <json>\n\n"

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
    return { event: eventName, data: parsed as Record<string, unknown> };
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
