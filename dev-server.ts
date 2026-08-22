// Dev server — runs Next.js dev mode + Socket.io on the same HTTP server
// Usage: npx tsx dev-server.ts

import { createServer } from "node:http";
import { parse } from "node:url";
import next from "next";
import { Server as SocketServer } from "socket.io";
import { registerGatewayConfigUpdatedHandler, registerRpcHandler } from "./src/lib/rpc-registry";

const envLoader = (
  process as typeof process & {
    loadEnvFile?: (path?: string) => void;
  }
).loadEnvFile;

try {
  envLoader?.(process.env.DESKRPG_ENV_PATH || ".env.local");
  envLoader?.(".env");
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
  const port = await findAvailablePort(preferredPort);
  if (port !== preferredPort) {
    console.log(`⚠ Port ${preferredPort} in use, using ${port} instead`);
  }
  const { setupSocketHandlers } = await import("./src/server/socket-handlers");

  // 예전에는 여기서 in-process RPC 핸들러를 등록해 API 라우트가 OpenClaw 게이트웨이의
  // agents.* 를 직접 부를 수 있게 했다(포트 의존 없이). OpenClaw 가 사라지면서 그 메서드
  // 들도 함께 없어졌다 — server.js 의 /_internal/rpc 브리지와 짝을 맞춰 제거한다.

  const httpServer = createServer((req, res) => {
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

  httpServer.listen(port, () => {
    console.log(`> Dev server ready on http://${hostname}:${port}`);
  });
});
