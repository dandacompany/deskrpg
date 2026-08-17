// Custom server — wraps Next.js standalone with Socket.io on a single port
// Hooks into startServer's httpServer after it starts
/* eslint-disable @typescript-eslint/no-require-imports */

const path = require("node:path");
const { Server } = require("socket.io");
const {
  OpenClawGateway,
  buildGatewayErrorPayload,
  getGatewayErrorStatus,
} = require("./src/lib/openclaw-gateway.js");
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
const nextConfig = require(path.join(dir, ".next", "required-server-files.json")).config;
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
  const socketHandlers = unwrapTsModule(await import("./src/server/socket-handlers.ts"));
  const {
    setupSocketHandlers,
    getRoomUserIds,
    getSocketIdsForUser,
    invalidateGatewayConnectionForChannel,
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

  // In-memory state — the OpenClaw gateway connection cache used by the
  // /_internal/rpc bridge and by /_internal/emit's gateway-config-change
  // invalidation below. Player/session state lives in socket-handlers.ts now.
  const channelGateways = new Map(); // channelId → OpenClawGateway instance

  function decryptGatewayToken(payload) {
    const crypto = require("node:crypto");
    const secret = process.env.INTERNAL_RPC_SECRET || process.env.JWT_SECRET;
    if (!secret) throw new Error("Missing JWT_SECRET for gateway token decryption");
    const key = crypto.createHash("sha256").update(secret).digest();
    const [version, ivB64, tagB64, encryptedB64] = payload.split(":");
    if (version !== "v1" || !ivB64 || !tagB64 || !encryptedB64) {
      throw new Error("Invalid gateway token payload");
    }
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64url"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(encryptedB64, "base64url")), decipher.final()]).toString("utf8");
  }

  async function getOrConnectGateway(channelId) {
    if (channelGateways.has(channelId)) {
      const gw = channelGateways.get(channelId);
      if (gw.isConnected()) return gw;
      gw.disconnect();
      channelGateways.delete(channelId);
    }

    try {
      // Look up gateway via channel_gateway_bindings → gateway_resources
      const bindings = await db
        .select({ gatewayId: schema.channelGatewayBindings.gatewayId })
        .from(schema.channelGatewayBindings)
        .where(eq(schema.channelGatewayBindings.channelId, channelId))
        .limit(1);

      if (!bindings.length) return null;

      const [resource] = await db
        .select({ baseUrl: schema.gatewayResources.baseUrl, tokenEncrypted: schema.gatewayResources.tokenEncrypted })
        .from(schema.gatewayResources)
        .where(eq(schema.gatewayResources.id, bindings[0].gatewayId))
        .limit(1);

      if (!resource?.baseUrl || !resource?.tokenEncrypted) return null;

      const token = decryptGatewayToken(resource.tokenEncrypted);
      const gateway = new OpenClawGateway();
      await gateway.connect(resource.baseUrl, token);
      channelGateways.set(channelId, gateway);
      return gateway;
    } catch (err) {
      console.error(`[gateway] Failed to connect for channel ${channelId.slice(0, 8)}:`, err.message);
      return null;
    }
  }

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

    // POST /_internal/rpc — proxy RPC calls from API routes to gateway
    if (req.method === "POST" && req.url === "/_internal/rpc") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", async () => {
        try {
          const { channelId, method, params } = JSON.parse(body);
          const gateway = await getOrConnectGateway(channelId);
          if (!gateway) {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Gateway not connected" }));
            return;
          }
          const result = await gateway._rpcRequest(method, params || {});
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, result }));
        } catch (err) {
          const status = getGatewayErrorStatus(err, 500);
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(buildGatewayErrorPayload(err)));
        }
      });
      return;
    }

    // POST /_internal/emit
    if (req.method === "POST" && req.url === "/_internal/emit") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          const { event, room, targetUserId, payload } = JSON.parse(body);

          // Gateway reconnection on config change
          if (event === "gateway:config-updated" && payload?.channelId) {
            const gw = channelGateways.get(payload.channelId);
            if (gw) {
              gw.disconnect();
              channelGateways.delete(payload.channelId);
            }
            // Also invalidate the socket-handlers cache (keyed by gatewayId) so NPC
            // conversations pick up the new gateway config.
            void invalidateGatewayConnectionForChannel(payload.channelId).catch(() => {});
          }

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
    console.log(`[socket.io] Listening on http://${internalHostname}:${SOCKET_PORT}`);
  });
}

main().catch(err => { console.error(err); process.exit(1); });
