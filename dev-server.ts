// Dev server — runs Next.js dev mode + Socket.io on the same HTTP server
// Usage: npx tsx dev-server.ts

import { createServer } from "node:http";
import { parse } from "node:url";
import next from "next";
import { Server as SocketServer } from "socket.io";
import { registerGatewayConfigUpdatedHandler, registerRpcHandler } from "./src/lib/rpc-registry";

const envLoader = (process as typeof process & {
  loadEnvFile?: (path?: string) => void;
}).loadEnvFile;

try {
  envLoader?.(process.env.DESKRPG_ENV_PATH || ".env.local");
  envLoader?.(".env");
} catch {
  // Ignore missing local env files in environments that inject env vars externally.
}

const hostname = process.env.HOSTNAME || "localhost";
const port = parseInt(process.env.PORT || "3000", 10);

const app = next({ dev: true, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(async () => {
  const { setupSocketHandlers, getOrConnectGateway, invalidateGatewayConnectionForChannel } = await import("./src/server/socket-handlers");

  // Register in-process RPC handler so Next.js API routes can call the gateway
  // directly without HTTP — no port dependency.
  registerRpcHandler(async (channelId, method, params) => {
    const gateway = await getOrConnectGateway(channelId);
    if (!gateway) throw new Error("Gateway not connected");

    if (method === "agents.create") return gateway.agentsCreate(params.name, params.workspace);
    if (method === "agents.files.set") return gateway.agentsFileSet(params.agentId, params.name, params.content);
    if (method === "agents.files.get") return gateway.agentsFileGet(params.agentId, params.name);
    if (method === "agents.list") return gateway.agentsList();
    if (method === "agents.delete") return gateway.agentsDelete(params.agentId, params.deleteFiles);
    throw new Error(`Unknown RPC method: ${method}`);
  });

  registerGatewayConfigUpdatedHandler(async (channelId) => {
    await invalidateGatewayConnectionForChannel(channelId);
  });

  const httpServer = createServer((req, res) => {
    const parsedUrl = parse(req.url!, true);
    handle(req, res, parsedUrl);
  });

  const io = new SocketServer(httpServer, {
    path: "/socket.io",
  });

  if (process.env.NODE_ENV !== "production") {
    io.engine.on("connection_error", (error) => {
      console.warn("[socket:engine] connection_error", {
        code: error.code,
        message: error.message,
        transport: error.context?.transport,
        url: error.req?.url,
        hasCookieHeader: !!error.req?.headers?.cookie,
        userAgent: error.req?.headers?.["user-agent"] || "",
      });
    });
  }

  setupSocketHandlers(io);

  httpServer.listen(port, () => {
    console.log(`> Dev server ready on http://${hostname}:${port}`);
  });
});
