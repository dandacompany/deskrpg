// Custom server — wraps Next.js standalone with Socket.io on a single port
// Hooks into startServer's httpServer after it starts
/* eslint-disable @typescript-eslint/no-require-imports */

const path = require("node:path");
const { Server } = require("socket.io");
const {
  getInternalSocketHostname,
  isInternalRequestAuthorized,
} = require("./src/lib/internal-transport.js");

const dir = __dirname;
process.env.NODE_ENV = "production";
// Standalone server runs on HTTP localhost — default to insecure cookies
// so browsers accept Set-Cookie. Override with COOKIE_SECURE=true for HTTPS.
if (!process.env.COOKIE_SECURE) process.env.COOKIE_SECURE = "false";
process.chdir(dir);

const currentPort = parseInt(process.env.PORT, 10) || 3000;
const hostname = process.env.HOSTNAME || "0.0.0.0";

// Load Next.js config from standalone build
const nextConfig = require(
  path.join(dir, ".next", "required-server-files.json"),
).config;
process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(nextConfig);

require("next");
const { startServer } = require("next/dist/server/lib/start-server");

async function main() {
  const unwrapTsModule = (moduleNamespace) => {
    if (
      moduleNamespace &&
      typeof moduleNamespace === "object" &&
      "default" in moduleNamespace &&
      moduleNamespace.default &&
      typeof moduleNamespace.default === "object"
    ) {
      return moduleNamespace.default;
    }
    return moduleNamespace;
  };
  const socketHandlers = unwrapTsModule(
    await import("./src/server/socket-handlers.ts"),
  );
  const {
    setupSocketHandlers,
    getRoomUserIds,
    getSocketIdsForUser,
  } = socketHandlers;

  const { db, schema } = require("./src/db/server-db.js");
  const { eq } = require("drizzle-orm");

  // Start Next.js (this creates and listens on the HTTP server)
  await startServer({
    dir,
    isDev: false,
    config: nextConfig,
    hostname,
    port: currentPort,
    allowRetry: false,
  });

  // Get the underlying HTTP server from the return value
  // startServer returns { port, hostname } but the HTTP server is
  // already listening. We need to access it differently.
  //
  // Alternative: use the http module to find the listening server
  const http = require("node:http");
  // Simpler: create Socket.io on a separate internal port, proxy via Caddy path
  const SOCKET_PORT = currentPort + 1; // 3001
  const socketHttpServer = http.createServer();
  const io = new Server(socketHttpServer, {
    path: "/socket.io",
    cors: { origin: "*" },
    maxHttpBufferSize: 20e6, // 20 MB — supports 3 × 5 MB file attachments
  });

  // 예전에는 여기에 OpenClaw 게이트웨이 커넥션 캐시와 /_internal/rpc 브리지가 있었다.
  // API 라우트가 그 브리지로 agents.create / agents.files.set 을 불러 게이트웨이
  // 워크스페이스에 페르소나 파일을 써 넣었다. OpenClaw 가 사라지면서 그 개념 전체가
  // 없어졌다 — 페르소나는 DB 에만 남고, Hermes 프로필은 자기 홈을 직접 들고 있다.
  // 플레이어/세션 상태는 socket-handlers.ts 에 있다.

  setupSocketHandlers(io);

  // Internal HTTP endpoints for cross-process communication
  socketHttpServer.on("request", (req, res) => {
    if (!req.url || !req.url.startsWith("/_internal")) return;

    res.setHeader("Content-Type", "application/json");

    if (!isInternalRequestAuthorized(req.headers)) {
      res.writeHead(403);
      res.end(JSON.stringify({ ok: false, error: "Forbidden" }));
      return;
    }

    // POST /_internal/emit
    if (req.method === "POST" && req.url === "/_internal/emit") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        try {
          const { event, room, targetUserId, payload } = JSON.parse(body);

          if (targetUserId) {
            for (const socketId of getSocketIdsForUser(targetUserId)) {
              io.to(socketId).emit(event, payload);
              if (event === "member:kicked" && payload?.channelId) {
                const targetSocket = io.sockets.sockets.get(socketId);
                if (targetSocket) {
                  targetSocket.leave(payload.channelId);
                }
              }
            }
          } else if (room) {
            io.to(room).emit(event, payload);
          }

          res.writeHead(200);
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Invalid request" }));
        }
      });
      return;
    }

    // GET /_internal/room-members?channelId=X
    if (req.method === "GET" && req.url.startsWith("/_internal/room-members")) {
      const url = new URL(req.url, "http://localhost");
      const channelId = url.searchParams.get("channelId");

      if (!channelId) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "channelId required" }));
        return;
      }

      const userIds = getRoomUserIds(io, channelId);

      res.writeHead(200);
      res.end(JSON.stringify({ userIds }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
  });

  const internalHostname = getInternalSocketHostname(process.env);
  socketHttpServer.listen(SOCKET_PORT, internalHostname, () => {
    console.log(
      `[socket.io] Listening on http://${internalHostname}:${SOCKET_PORT}`,
    );
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
