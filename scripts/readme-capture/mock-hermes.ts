import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import {
  KANBAN_TASK_STATUSES,
  type BoardMeta,
  type KanbanTaskFull,
  type PluginEvent,
} from "../../src/lib/hermes/deskrpg-plugin-types";

const CAPTURE_TOKENS = new Set([
  "readme-capture-gateway-token",
  "readme-capture-sophie-token",
  "readme-capture-noah-token",
]);

export const CHAT_SCRIPT = ["좋은 ", "아침이에요. ", "오늘 일정부터 함께 확인할게요."];

const MEETING_LINES = {
  sophie: "SPEAK: 오전에는 릴리스 점검부터 진행하겠습니다.",
  noah: "SPEAK: 저는 사용자 피드백을 정리해 공유하겠습니다.",
} as const;

type MeetingProfile = keyof typeof MEETING_LINES;

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
}

function isMeetingProfile(profile: string): profile is MeetingProfile {
  return Object.hasOwn(MEETING_LINES, profile);
}

function isAuthorized(request: IncomingMessage): boolean {
  const authorization = request.headers.authorization;
  return (
    typeof authorization === "string" &&
    authorization.startsWith("Bearer ") &&
    CAPTURE_TOKENS.has(authorization.slice("Bearer ".length))
  );
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

async function writeSse(
  response: ServerResponse,
  eventName: "assistant" | "message",
  chunks: string[],
  thinkingMs = 0,
) {
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  // Let the real room UI display thinking across several 12 fps capture frames.
  if (thinkingMs) await new Promise((resolve) => setTimeout(resolve, thinkingMs));
  for (const [index, delta] of chunks.entries()) {
    response.write(
      `event: ${eventName}.delta\ndata: ${JSON.stringify({ delta, seq: index + 1 })}\n\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  response.write(
    `event: ${eventName}.completed\ndata: ${JSON.stringify({ content: chunks.join("") })}\n\n`,
  );
  response.end(`event: run.completed\ndata: {}\n\n`);
}

export async function startMockHermes({ host, port }: { host: string; port: number }): Promise<{
  baseUrl: string;
  close(): Promise<void>;
}> {
  if (!isLoopbackHost(host)) throw new Error(`Mock Hermes must listen on a loopback host: ${host}`);

  let sessionSequence = 0;
  let runSequence = 0;
  const runs = new Map<string, { profile: MeetingProfile; room: boolean; priming: boolean }>();
  const boards = new Map<string, BoardMeta>();
  const cards = new Map<string, { board: string; task: KanbanTaskFull }>();
  const events: PluginEvent[] = [];
  const readBody = async (request: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    return JSON.parse(Buffer.concat(chunks).toString() || "{}");
  };
  const server = createServer((request, response) => {
    const handle = async () => {
      if (request.method === "GET" && request.url === "/health") {
        response.writeHead(200, { "Content-Type": "text/plain" });
        response.end("ok");
        return;
      }
      if (!isAuthorized(request)) {
        writeJson(response, 401, { error: "unauthorized" });
        return;
      }

      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);
      if (url.pathname.startsWith("/deskrpg/")) {
        if (request.headers.authorization !== "Bearer readme-capture-gateway-token") {
          writeJson(response, 401, { error: "unauthorized" });
          return;
        }
        const board = url.searchParams.get("board") ?? "";
        if (url.pathname === "/deskrpg/info") {
          writeJson(response, 200, {
            plugin: "deskrpg",
            version: "0.6.0",
            capabilities: ["kanban", "cron", "events"],
            timezone: "Asia/Seoul",
            kanban: { dispatcher_present: true, attachments: false },
          });
          return;
        }
        if (url.pathname === "/deskrpg/kanban/boards" && request.method === "POST") {
          const body = (await readBody(request)) as BoardMeta;
          if (!boards.has(body.slug)) boards.set(body.slug, body);
          writeJson(response, 200, { board: boards.get(body.slug) });
          return;
        }
        if (url.pathname.startsWith("/deskrpg/kanban/boards/") && request.method === "PATCH") {
          const slug = decodeURIComponent(url.pathname.split("/").at(-1)!);
          const updated = { ...boards.get(slug), ...(await readBody(request)), slug };
          boards.set(slug, updated);
          writeJson(response, 200, { board: updated });
          return;
        }
        if (url.pathname === "/deskrpg/kanban/board") {
          writeJson(response, 200, {
            columns: KANBAN_TASK_STATUSES.map((name) => ({
              name,
              tasks: [...cards.values()]
                .filter((c) => c.board === board && c.task.status === name)
                .map((c) => c.task),
            })),
            tenants: [],
            assignees: ["sophie", "noah"],
            latest_event_id: events.at(-1)?.id ?? null,
            now: new Date().toISOString(),
          });
          return;
        }
        if (url.pathname === "/deskrpg/kanban/tasks" && request.method === "POST") {
          const body = await readBody(request);
          const task: KanbanTaskFull = {
            ...body,
            id: `capture-card-${cards.size + 1}`,
            status: "todo",
            created_at: new Date().toISOString(),
          };
          cards.set(task.id, { board, task });
          writeJson(response, 201, { task });
          return;
        }
        const cardMatch = /^\/deskrpg\/kanban\/tasks\/([^/]+)$/.exec(url.pathname);
        if (cardMatch) {
          const card = cards.get(decodeURIComponent(cardMatch[1]));
          if (!card || card.board !== board) {
            writeJson(response, 404, { error: "not_found" });
            return;
          }
          if (request.method === "PATCH") {
            const body = await readBody(request);
            const from = card.task.status;
            Object.assign(card.task, body);
            if (body.status && body.status !== from)
              events.push({
                id: `capture-event-${events.length + 1}`,
                ts: Date.now(),
                kind: "task.status",
                board,
                task_id: card.task.id,
                profile: card.task.assignee,
                payload: {
                  from,
                  to: body.status,
                  title: card.task.title,
                  assignee: card.task.assignee,
                  parent_count: 0,
                },
              });
          }
          writeJson(response, 200, {
            task: card.task,
            comments: [],
            events: [],
            attachments: null,
            links: { parents: [], children: [] },
            runs: [],
          });
          return;
        }
        if (url.pathname === "/deskrpg/kanban/dispatch") {
          writeJson(response, 200, { dispatched: [], skipped: [] });
          return;
        }
        if (url.pathname === "/deskrpg/events") {
          const cursor = url.searchParams.get("cursor");
          writeJson(response, 200, {
            events:
              cursor === null ? [] : events.slice(Number(cursor)).filter((e) => e.board === board),
            cursor: String(events.length),
            has_more: false,
          });
          return;
        }
      }
      const match = /^\/p\/([^/]+)(\/.*)$/.exec(url.pathname);
      if (!match) {
        writeJson(response, 404, { error: "not_found" });
        return;
      }

      const [, encodedProfile, path] = match;
      const profile = decodeURIComponent(encodedProfile);
      if (!isMeetingProfile(profile)) {
        writeJson(response, 404, { error: "unknown_profile" });
        return;
      }

      if (request.method === "GET" && path === "/v1/capabilities") {
        writeJson(response, 200, {
          features: { sessions: true, runs: true },
          endpoints: {
            sessions: { method: "POST", path: "/api/sessions" },
            sessionChat: { method: "POST", path: "/api/sessions/:id/chat/stream" },
            runs: { method: "POST", path: "/v1/runs" },
            runEvents: { method: "GET", path: "/v1/runs/:id/events" },
          },
        });
        return;
      }

      if (request.method === "POST" && path === "/api/sessions") {
        const id = `session-${++sessionSequence}`;
        writeJson(response, 200, {
          object: "hermes.session",
          session: { id, source: "api_server", message_count: 0 },
        });
        return;
      }

      const chat = /^\/api\/sessions\/([^/]+)\/chat\/stream$/.exec(path);
      if (request.method === "POST" && chat) {
        await writeSse(response, "assistant", CHAT_SCRIPT);
        return;
      }

      if (request.method === "POST" && path === "/v1/runs") {
        const body: Buffer[] = [];
        for await (const chunk of request) body.push(Buffer.from(chunk));
        const input = String(JSON.parse(Buffer.concat(body).toString()).input ?? "");
        // The open-chat script has a Korean and an English variant; take the last recent line from either.
        const block =
          /\[(?:최근 대화|Recent conversation)\]\n([\s\S]*?)\n\[(?:답하는 법|How to reply)\]/.exec(
            input,
          );
        const recent = block ? block[1].trim().split("\n").at(-1)! : input;
        const runId = `run-${++runSequence}`;
        runs.set(runId, {
          profile,
          room: String(request.headers["x-hermes-session-key"] ?? "").includes("-room-"),
          priming: recent.endsWith("잠깐 준비해 주세요."),
        });
        writeJson(response, 202, { run_id: runId });
        return;
      }

      const runEvents = /^\/v1\/runs\/([^/]+)\/events$/.exec(path);
      if (request.method === "GET" && runEvents) {
        const runId = decodeURIComponent(runEvents[1]);
        if (runs.get(runId)?.profile !== profile) {
          writeJson(response, 404, { error: "not_found" });
          return;
        }
        await writeSse(
          response,
          "message",
          runs.get(runId)!.room
            ? runs.get(runId)!.priming
              ? ["준비됐어요."]
              : CHAT_SCRIPT
            : [MEETING_LINES[profile]],
          runs.get(runId)!.room ? (runs.get(runId)!.priming ? 3500 : 700) : 0,
        );
        return;
      }

      writeJson(response, 404, { error: "not_found" });
    };

    void handle().catch(() => writeJson(response, 500, { error: "mock_error" }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Mock Hermes did not expose a TCP address");
  const originHost = host.includes(":") ? `[${host}]` : host;

  return {
    baseUrl: `http://${originHost}:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
