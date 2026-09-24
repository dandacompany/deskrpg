import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createServer, isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { prepareFixture, type FixtureApi, type CaptureFixture } from "./fixture";
import { startMockHermes } from "./mock-hermes";

export type SessionDeps = {
  spawn: typeof import("node:child_process").spawn;
  fetch: typeof globalThis.fetch;
  root: string;
  signals: SignalSource;
  kill: typeof process.kill;
  ports: CapturePorts;
};

/**
 * Ports the capture uses. The real capture uses 3310, which the README points to, as a fixed port.
 *
 * Tests inject them — unit tests with a fake child still do the real port-in-use check and mock Hermes bind,
 * so with the defaults they broke with `EADDRINUSE 127.0.0.1:38642` when another session ran the same file concurrently
 * (2026-09-21, measured with two full runs at once).
 */
export type CapturePorts = { app: number; internal: number; hermes: number };
export const DEFAULT_CAPTURE_PORTS: CapturePorts = { app: 3310, internal: 3311, hermes: 38642 };

export type SignalSource = {
  on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
};

const CAPTURE_ARTIFACT_DIR = ".artifacts/readme-capture";

export function captureStages(recordOnly: boolean): Array<"record" | "media" | "verify"> {
  return recordOnly ? ["record"] : ["record", "media", "verify"];
}

export function persistFixture(root: string, fixture: CaptureFixture): string {
  const target = path.join(root, CAPTURE_ARTIFACT_DIR, "fixture.json");
  assertCaptureRuntimePath(root, target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(fixture, null, 2), { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, target);
  return target;
}

function isLoopbackUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      (host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127.")))
    );
  } catch {
    return false;
  }
}

export function assertCaptureRuntimePath(root: string, runtimePath: string): void {
  const resolvedRoot = path.resolve(root);
  if (resolvedRoot === path.parse(resolvedRoot).root) {
    throw new Error("Capture session refuses a broad repository root");
  }
  const captureRoot = path.join(resolvedRoot, CAPTURE_ARTIFACT_DIR);
  const resolvedRuntime = path.resolve(runtimePath);
  const relative = path.relative(captureRoot, resolvedRuntime);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Runtime must be below the repository capture artifact directory");
  }

  let candidate = resolvedRoot;
  for (const segment of path.relative(resolvedRoot, resolvedRuntime).split(path.sep)) {
    candidate = path.join(candidate, segment);
    if (fs.lstatSync(candidate, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error("Capture runtime must not traverse a symlink");
    }
  }

  let existing = resolvedRuntime;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const realRoot = fs.realpathSync(resolvedRoot);
  const realExisting = fs.realpathSync(existing);
  const realRelative = path.relative(realRoot, realExisting);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new Error("Runtime capture artifact path resolves outside the repository");
  }
}

function captureCookie(headers: Headers): string | null {
  const values =
    "getSetCookie" in headers && typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : [headers.get("set-cookie")].filter((value): value is string => Boolean(value));
  const cookie = values[0]?.split(";", 1)[0]?.trim();
  return cookie || null;
}

export function createFixtureApi(
  appBaseUrl: string,
  request: typeof globalThis.fetch = globalThis.fetch,
): FixtureApi {
  if (!isLoopbackUrl(appBaseUrl)) {
    throw new Error("DeskRPG capture app URL must use a loopback host");
  }
  const baseUrl = new URL(appBaseUrl);
  let cookie: string | null = null;

  const send = async (
    method: "GET" | "POST" | "PUT" | "PATCH",
    requestPath: string,
    body?: unknown,
  ): Promise<{ response: Response; data: unknown }> => {
    const url = new URL(requestPath, baseUrl);
    if (url.origin !== baseUrl.origin)
      throw new Error("Fixture requests must stay on the local app");
    const response = await request(url, {
      method,
      redirect: "error",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const nextCookie = captureCookie(response.headers);
    if (nextCookie) cookie = nextCookie;
    const data = await response.json().catch(() => null);
    return { response, data };
  };

  return {
    async request<T>(
      method: "GET" | "POST" | "PUT" | "PATCH",
      requestPath: string,
      body?: unknown,
    ): Promise<T> {
      const result = await send(method, requestPath, body);
      if (
        method === "POST" &&
        requestPath === "/api/auth/register" &&
        result.response.status === 409 &&
        (result.data as { errorCode?: string } | null)?.errorCode === "login_id_taken"
      ) {
        const account = body as { loginId?: string; password?: string };
        const login = await send("POST", "/api/auth/login", {
          loginId: account.loginId,
          password: account.password,
        });
        if (!login.response.ok)
          throw new Error("Existing capture account could not be authenticated");
        return { ...(login.data as object), existing: true } as T;
      }
      if (!result.response.ok) {
        const error = result.data as { errorCode?: string; error?: string } | null;
        throw new Error(
          `Fixture request failed (${result.response.status}): ${error?.errorCode ?? error?.error ?? requestPath}`,
        );
      }
      return result.data as T;
    },
  };
}

function safeChildEnvironment(
  root: string,
  runtimePath: string,
  sqlitePath: string,
  instanceId: string,
  ports: CapturePorts,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    TERM: process.env.TERM,
    HOME: runtimePath,
    XDG_CACHE_HOME: path.join(runtimePath, "cache"),
    npm_config_cache: path.join(runtimePath, "npm-cache"),
    DESKRPG_HOME: runtimePath,
    SQLITE_PATH: sqlitePath,
    DB_TYPE: "sqlite",
    JWT_SECRET: "readme-capture-jwt-secret-local-only-2026",
    COMING_SOON: "false",
    NEXT_PUBLIC_COMING_SOON: "false",
    NEXT_PUBLIC_README_CAPTURE: "1",
    PORT: String(ports.app),
    INTERNAL_PORT: String(ports.internal),
    HOSTNAME: "127.0.0.1",
    NODE_ENV: "development",
    DESKRPG_CAPTURE_MODE: "1",
    DESKRPG_CAPTURE_INSTANCE_ID: instanceId,
    DESKRPG_PROJECT_ROOT: root,
    DESKRPG_CAPTURE_PARENT_PID: String(process.pid),
    README_CAPTURE_DRY_RUN: process.env.README_CAPTURE_DRY_RUN === "1" ? "1" : "0",
  };
  const browserCache =
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library/Caches/ms-playwright")
      : path.join(os.homedir(), ".cache/ms-playwright");
  if (fs.existsSync(browserCache)) environment.PLAYWRIGHT_BROWSERS_PATH = browserCache;
  return environment;
}

function childExit(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

export async function terminateOwnedChild(
  child: ChildProcess,
  kill: typeof process.kill = process.kill,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = childExit(child).catch(() => ({ code: null, signal: null }));
  const groupPid = process.platform !== "win32" && child.pid ? -child.pid : null;
  try {
    if (groupPid !== null) kill(groupPid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const terminated = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
  ]);
  if (terminated) return;
  try {
    if (groupPid !== null) kill(groupPid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
}

async function waitForHealth(
  request: typeof globalThis.fetch,
  appUrl: string,
  child: ChildProcess,
  instanceId: string,
  signal: AbortSignal,
): Promise<void> {
  let exited = false;
  const markExited = () => {
    exited = true;
  };
  child.once("exit", markExited);
  try {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      signal.throwIfAborted();
      if (exited || child.exitCode !== null || child.signalCode !== null) {
        throw new Error("DeskRPG exited before its health check became ready");
      }
      let response: Response | null = null;
      try {
        response = await request(`${appUrl}/__readme-capture/health`, {
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(1_000)]),
        });
      } catch {
        // The server is expected to refuse connections during startup.
      }
      if (response?.ok) {
        const health = (await response.json().catch(() => null)) as {
          instanceId?: string;
          listenerAddress?: string;
          repositoryEnvLoaded?: boolean;
        } | null;
        if (
          health?.instanceId !== instanceId ||
          health.listenerAddress !== "127.0.0.1" ||
          health.repositoryEnvLoaded !== false
        ) {
          throw new Error("Health response does not belong to the owned capture instance");
        }
        return;
      }
      if (response) throw new Error(`DeskRPG health check failed with HTTP ${response.status}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("DeskRPG health check timed out");
  } finally {
    child.off("exit", markExited);
  }
}

async function assertExclusivePort(host: string, port: number): Promise<void> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "EADDRINUSE"
          ? new Error(
              `Capture requires exclusive ownership of ${host}:${port}; port is already in use`,
            )
          : error,
      );
    });
    probe.listen(port, host, resolve);
  });
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
}

function abortableFetch(
  request: typeof globalThis.fetch,
  sessionSignal: AbortSignal,
): typeof globalThis.fetch {
  return ((input: string | URL | Request, init?: RequestInit) =>
    request(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([sessionSignal, init.signal]) : sessionSignal,
    })) as typeof globalThis.fetch;
}

export async function runCaptureSession(deps: Partial<SessionDeps> = {}): Promise<void> {
  const root = path.resolve(deps.root ?? path.resolve(import.meta.dirname, "../.."));
  const spawn = deps.spawn ?? nodeSpawn;
  const request = deps.fetch ?? globalThis.fetch;
  const signals = deps.signals ?? process;
  const kill = deps.kill ?? process.kill;
  const runtimePath = path.join(root, CAPTURE_ARTIFACT_DIR, "runtime");
  const dataPath = path.join(runtimePath, "data");
  const sqlitePath = path.join(dataPath, "db.sqlite");
  // SQLite bootstraps during app startup, before prepareFixture can inspect the path.
  assertCaptureRuntimePath(root, sqlitePath);
  fs.mkdirSync(dataPath, { recursive: true });

  const ownedChildren = new Set<ChildProcess>();
  let mockHermes: Awaited<ReturnType<typeof startMockHermes>> | null = null;
  const instanceId = `readme-capture-${randomUUID()}`;
  const ports = deps.ports ?? DEFAULT_CAPTURE_PORTS;
  const appUrl = `http://127.0.0.1:${ports.app}`;
  const environment = safeChildEnvironment(root, runtimePath, sqlitePath, instanceId, ports);
  const cancellation = new AbortController();
  const interrupt = (signal: "SIGINT" | "SIGTERM") => () => {
    cancellation.abort(new Error(`README capture interrupted by ${signal}`));
  };
  const onSigint = interrupt("SIGINT");
  const onSigterm = interrupt("SIGTERM");
  signals.on("SIGINT", onSigint);
  signals.on("SIGTERM", onSigterm);
  const sessionFetch = abortableFetch(request, cancellation.signal);

  const startOwned = (command: string, args: string[]): ChildProcess => {
    const child = spawn(command, args, {
      cwd: root,
      env: environment,
      stdio: "inherit",
      detached: process.platform !== "win32",
    });
    ownedChildren.add(child);
    child.once("exit", () => ownedChildren.delete(child));
    return child;
  };

  const runStage = async (name: string, command: string, args: string[]): Promise<void> => {
    cancellation.signal.throwIfAborted();
    const child = startOwned(command, args);
    const result = await Promise.race([
      childExit(child),
      cancellation.signal.aborted
        ? Promise.reject(cancellation.signal.reason)
        : new Promise<never>((_resolve, reject) => {
            cancellation.signal.addEventListener(
              "abort",
              () => reject(cancellation.signal.reason),
              { once: true },
            );
          }),
    ]);
    if (result.code !== 0) {
      throw new Error(`${name} failed with ${result.signal ?? `exit code ${result.code}`}`);
    }
  };

  try {
    await assertExclusivePort("127.0.0.1", ports.app);
    cancellation.signal.throwIfAborted();
    mockHermes = await startMockHermes({ host: "127.0.0.1", port: ports.hermes });
    cancellation.signal.throwIfAborted();
    const app = startOwned(process.execPath, [
      "--import",
      "tsx",
      path.join(root, "scripts/readme-capture/server-launcher.ts"),
    ]);
    await waitForHealth(sessionFetch, appUrl, app, instanceId, cancellation.signal);
    cancellation.signal.throwIfAborted();
    const fixture = await prepareFixture(
      createFixtureApi(appUrl, sessionFetch),
      mockHermes.baseUrl,
      sqlitePath,
    );
    persistFixture(root, fixture);
    cancellation.signal.throwIfAborted();
    await runStage("capture:readme:record", process.execPath, [
      path.join(root, "node_modules/@playwright/test/cli.js"),
      "test",
      "--config",
      path.join(root, "playwright.readme-capture.config.ts"),
    ]);
    if (captureStages(process.env.README_CAPTURE_RECORD_ONLY === "1").includes("media")) {
      await runStage("capture:readme:media", process.execPath, [
        "--import",
        "tsx",
        path.join(root, "scripts/readme-capture/media.ts"),
      ]);
      await runStage("capture:readme:verify", process.execPath, [
        "--import",
        "tsx",
        path.join(root, "scripts/readme-capture/verify-readme.ts"),
      ]);
    }
  } finally {
    try {
      await Promise.all([...ownedChildren].map((child) => terminateOwnedChild(child, kill)));
      await mockHermes?.close();
    } finally {
      signals.off("SIGINT", onSigint);
      signals.off("SIGTERM", onSigterm);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runCaptureSession().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
