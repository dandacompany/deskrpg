// Custom server — wraps Next.js standalone with Socket.io on a single port
// Hooks into startServer's httpServer after it starts
const path = require("node:path");
// Install alias resolution first — the requires below already go through `@/`.
require("./src/lib/path-alias.js").installPathAlias(__dirname);
const { Server } = require("socket.io");
const {
  getInternalSocketHostname,
  isInternalRequestAuthorized,
} = require("./src/lib/internal-transport.js");
const { bootstrapRuntimeEnv } = require("./src/lib/runtime-env-bootstrap.js");
const { cliMessage } = require("./src/lib/cli-messages.js");
const {
  checkDatabaseReachable,
  hostSetupHint,
  inspectEnvironment,
  reportEnvironmentInspection,
} = require("./src/lib/startup-check.js");

const dir = __dirname;
process.env.NODE_ENV = "production";
// Standalone server runs on HTTP localhost — default to insecure cookies
// so browsers accept Set-Cookie. Override with COOKIE_SECURE=true for HTTPS.
if (!process.env.COOKIE_SECURE) process.env.COOKIE_SECURE = "false";
process.chdir(dir);

const currentPort = parseInt(process.env.PORT, 10) || 3000;
const hostname = process.env.HOSTNAME || "0.0.0.0";

// Load Next.js config from standalone build
const nextConfig = require(path.join(dir, ".next", "required-server-files.json")).config;
process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(nextConfig);

function getRuntimeSqlitePath() {
  try {
    return require(path.join(dir, "src", "lib", "runtime-paths.js")).getDeskRpgSqlitePath();
  } catch {
    return null;
  }
}

require("next");
const { startServer } = require("next/dist/server/lib/start-server");

async function main() {
  // Promote the runtime home's values into the environment — values already set are not overwritten.
  bootstrapRuntimeEnv({ packageRoot: dir });

  // Validate the environment right before startup — errors abort immediately, warnings are printed and startup continues.
  // Users who ran on SQLite without DATABASE_URL just see a warning and start as before.
  const inspection = inspectEnvironment(process.env);
  const hint = hostSetupHint();
  if (hint) console.log(`[startup] ${hint}`);
  if (!reportEnvironmentInspection(inspection)) {
    console.error(cliMessage("server.environmentInvalid"));
    process.exit(1);
  }

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
  const socketHandlers = unwrapTsModule(await import("./src/server/socket-handlers.ts"));
  const { setupSocketHandlers, getRoomUserIds, getSocketIdsForUser } = socketHandlers;

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

  // This used to hold the OpenClaw gateway connection cache and the /_internal/rpc bridge.
  // API routes called agents.create / agents.files.set through that bridge to write persona files
  // into the gateway workspace. The whole concept went away with OpenClaw —
  // personas live only in the DB, and each Hermes profile holds its own home directly.
  // Player/session state lives in socket-handlers.ts.

  const { refreshChannelMap } = setupSocketHandlers(io);

  // Internal HTTP endpoints for cross-process communication
  socketHttpServer.on("request", (req, res) => {
    if (!req.url || !req.url.startsWith("/_internal")) return;

    res.setHeader("Content-Type", "application/json");

    if (!isInternalRequestAuthorized(req.headers)) {
      res.writeHead(403);
      res.end(JSON.stringify({ ok: false, error: "Forbidden" }));
      return;
    }

    // Authenticated cross-process migration boundary, also registered locally in dev.
    if (req.method === "POST" && req.url === "/_internal/map-refresh") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", async () => {
        try {
          const { action, channelId, lease } = JSON.parse(body);
          if (
            !["begin", "finish"].includes(action) ||
            typeof channelId !== "string" ||
            channelId.length > 128
          )
            throw Error("Invalid request");
          const result = await refreshChannelMap(action, channelId, lease);
          res.writeHead(200);
          res.end(JSON.stringify({ lease: result }));
        } catch {
          res.writeHead(503);
          res.end(JSON.stringify({ error: "Map refresh unavailable" }));
        }
      });
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

  // DB reachability does not block startup — a failure only leaves a warning (existing behavior kept).
  const dbProbe = await checkDatabaseReachable({
    databaseUrl: process.env.DATABASE_URL,
    sqlitePath: process.env.SQLITE_PATH || getRuntimeSqlitePath(),
    // Probe what the app actually uses — even SQLite runtimes still have an old DATABASE_URL in .env.
    target: inspection.dbTarget,
  });
  if (dbProbe.ok) {
    console.log(
      cliMessage("server.databaseOk", { target: dbProbe.target, message: dbProbe.message }),
    );
  } else {
    console.warn(cliMessage("report.warning", { message: dbProbe.message }));
  }

  const internalHostname = getInternalSocketHostname(process.env);
  socketHttpServer.listen(SOCKET_PORT, internalHostname, () => {
    console.log(`[socket.io] Listening on http://${internalHostname}:${SOCKET_PORT}`);
  });
}

main().catch((err) => {
  console.error(cliMessage("server.startFailed"));
  console.error(err);
  process.exit(1);
});
