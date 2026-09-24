// Dev server — runs Next.js dev mode + Socket.io on the same HTTP server
// Usage: npx tsx dev-server.ts

import { createServer } from "node:http";
import { parse } from "node:url";
import next from "next";
import { Server as SocketServer } from "socket.io";

const envLoader = (
  process as typeof process & {
    loadEnvFile?: (path?: string) => void;
  }
).loadEnvFile;
const captureMode = process.env.DESKRPG_CAPTURE_MODE === "1";

try {
  if (!captureMode) {
    envLoader?.(process.env.DESKRPG_ENV_PATH || ".env.local");
    envLoader?.(".env");
  }
} catch {
  // Ignore missing local env files in environments that inject env vars externally.
}

const hostname = process.env.HOSTNAME || "localhost";
const preferredPort = parseInt(process.env.PORT || "3000", 10);

async function findAvailablePort(start: number, maxAttempts = 10): Promise<number> {
  const net = await import("node:net");
  for (let p = start; p < start + maxAttempts; p++) {
    const available = await new Promise<boolean>((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(false));
      srv.listen(p, () => {
        srv.close(() => resolve(true));
      });
    });
    if (available) return p;
  }
  throw new Error(`No available port found in range ${start}-${start + maxAttempts - 1}`);
}

const app = next({ dev: true, hostname, port: preferredPort });
const handle = app.getRequestHandler();

app.prepare().then(async () => {
  const port = await findAvailablePort(preferredPort, captureMode ? 1 : 10);
  if (port !== preferredPort) {
    console.log(`⚠ Port ${preferredPort} in use, using ${port} instead`);
  }
  const { setupSocketHandlers } = await import("./src/server/socket-handlers");

  // This used to register an in-process RPC handler so API routes could call the OpenClaw gateway's
  // agents.* directly (without depending on a port). Those methods went away with OpenClaw
  // — removed together with the /_internal/rpc bridge in server.js.

  const httpServer = createServer((req, res) => {
    if (captureMode && req.method === "GET" && req.url === "/__readme-capture/health") {
      const address = httpServer.address();
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(
        JSON.stringify({
          instanceId: process.env.DESKRPG_CAPTURE_INSTANCE_ID ?? null,
          listenerAddress: address && typeof address === "object" ? address.address : null,
          repositoryEnvLoaded: Object.hasOwn(process.env, "README_CAPTURE_ENV_SENTINEL"),
        }),
      );
      return;
    }
    const parsedUrl = parse(req.url!, true);
    handle(req, res, parsedUrl);
  });

  const io = new SocketServer(httpServer, {
    path: "/socket.io",
    maxHttpBufferSize: 20e6, // 20 MB — supports 3 × 5 MB file attachments
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

  httpServer.listen(port, captureMode ? "127.0.0.1" : undefined, () => {
    console.log(`> Dev server ready on http://${hostname}:${port}`);
  });
});
