// Hermes API Server SSE frame parser.
//
// Hermes 는 **두 가지 방언**을 쓴다. 실측(v0.20.2):
//
//   /api/sessions/<id>/chat/stream  (1:1)   "event: assistant.delta\ndata: {...}\n\n"
//   /v1/runs/<id>/events            (회의)  "data: {\"event\": \"message.delta\", ...}\n\n"
//
// 두 번째에는 `event:` 줄이 아예 없고 이름이 data JSON 안에 들어 있다. 그래서 `event:`
// 줄만 보던 이 파서는 회의 경로의 모든 프레임을 이름 "message" 로 읽었고, 그 결과
// 어떤 델타도 누적되지 않아 폴링 응답이 늘 빈 문자열이 됐다 — NPC 는 "SPEAK: …" 라고
// 또박또박 답하고 있었는데도 전원이 PASS 로 집계됐다.

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
    // `event:` 줄이 없으면 payload 안의 event 필드가 이름이다(위 두 번째 방언).
    // 줄이 있으면 그쪽이 우선 — 그게 명시적 신호다.
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
