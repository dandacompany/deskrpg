import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";

const DEFAULT_MAX_CONCURRENT = 10;
const DEFAULT_TIMEOUT_MS = 180_000;
const KILL_GRACE_MS = 5_000;

export interface SubprocessRequest {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  timeoutMs?: number;
}

export interface SubprocessResult {
  fullOutput: string;
  exitCode: number;
  stderr: string;
  durationMs: number;
}

export interface SubprocessExecution extends Promise<SubprocessResult> {
  requestId: string;
  result: Promise<SubprocessResult>;
}

export interface SubprocessPoolStatus {
  maxConcurrent: number;
  active: number;
  queued: number;
  activeCount: number;
  queuedCount: number;
  activeRequestIds: string[];
  queuedRequestIds: string[];
}

interface PendingRequest {
  requestId: string;
  request: SubprocessRequest;
  result: Promise<SubprocessResult>;
  resolve: (value: SubprocessResult) => void;
  reject: (reason?: unknown) => void;
}

/** All three streams are pipes, so spawn's own overload types them non-null — no cast needed. */
type PipedChild = ChildProcessByStdio<Writable, Readable, Readable>;

interface RunningRequest extends PendingRequest {
  child: PipedChild;
  startedAt: number;
  stdout: string;
  stderr: string;
  timeoutHandle?: NodeJS.Timeout;
  killHandle?: NodeJS.Timeout;
  settled: boolean;
  terminationMessage?: string;
}

interface SubprocessPoolOptions {
  maxConcurrent?: number;
  timeoutMs?: number;
}

export class SubprocessPool {
  private readonly maxConcurrent: number;
  private readonly defaultTimeoutMs: number;
  private readonly active = new Map<string, RunningRequest>();
  private readonly queue: PendingRequest[] = [];

  constructor(options: SubprocessPoolOptions = {}) {
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
    this.defaultTimeoutMs = Math.max(0, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  execute(request: SubprocessRequest): SubprocessExecution {
    const requestId = randomUUID();

    let resolvePromise!: (value: SubprocessResult) => void;
    let rejectPromise!: (reason?: unknown) => void;

    const result = new Promise<SubprocessResult>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    const execution = result as SubprocessExecution;
    execution.requestId = requestId;
    execution.result = result;

    const pending: PendingRequest = {
      requestId,
      request,
      result,
      resolve: resolvePromise,
      reject: rejectPromise,
    };

    if (this.active.size < this.maxConcurrent) {
      this.startRequest(pending);
    } else {
      this.queue.push(pending);
    }

    return execution;
  }

  kill(requestId: string): boolean {
    const queuedIndex = this.queue.findIndex((entry) => entry.requestId === requestId);
    if (queuedIndex >= 0) {
      const [entry] = this.queue.splice(queuedIndex, 1);
      entry.reject(new Error(`Subprocess request ${requestId} was aborted before start.`));
      return true;
    }

    const activeEntry = this.active.get(requestId);
    if (!activeEntry) {
      return false;
    }

    this.terminate(activeEntry, `Subprocess request ${requestId} was aborted.`);
    return true;
  }

  getStatus(): SubprocessPoolStatus {
    const activeRequestIds = [...this.active.keys()];
    const queuedRequestIds = this.queue.map((entry) => entry.requestId);

    return {
      maxConcurrent: this.maxConcurrent,
      active: activeRequestIds.length,
      queued: queuedRequestIds.length,
      activeCount: activeRequestIds.length,
      queuedCount: queuedRequestIds.length,
      activeRequestIds,
      queuedRequestIds,
    };
  }

  private startRequest(pending: PendingRequest): void {
    let child: PipedChild;

    try {
      child = spawn(pending.request.command, pending.request.args, {
        cwd: pending.request.cwd,
        env: {
          ...process.env,
          ...(pending.request.env ?? {}),
        },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      pending.reject(error);
      this.drainQueue();
      return;
    }

    const running: RunningRequest = {
      ...pending,
      child,
      startedAt: Date.now(),
      stdout: "",
      stderr: "",
      settled: false,
    };

    this.active.set(running.requestId, running);

    const timeoutMs = pending.request.timeoutMs ?? this.defaultTimeoutMs;
    if (timeoutMs > 0) {
      running.timeoutHandle = setTimeout(() => {
        this.terminate(
          running,
          `Subprocess request ${running.requestId} timed out after ${timeoutMs}ms.`,
        );
      }, timeoutMs);
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string | Buffer) => {
      const text = String(chunk);
      running.stdout += text;
      running.request.onStdout?.(text);
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string | Buffer) => {
      const text = String(chunk);
      running.stderr += text;
      running.request.onStderr?.(text);
    });

    child.stdin.on("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPIPE" && code !== "ERR_STREAM_DESTROYED") {
        this.finishWithError(running, error);
      }
    });

    child.once("error", (error) => {
      this.finishWithError(running, error);
    });

    child.once("close", (code, signal) => {
      this.finishWithResult(running, code, signal);
    });

    try {
      if (typeof running.request.stdin === "string") {
        child.stdin.write(running.request.stdin);
      }
      child.stdin.end();
    } catch (error) {
      this.finishWithError(running, error);
    }
  }

  private terminate(entry: RunningRequest, message: string): void {
    if (entry.settled) {
      return;
    }

    entry.terminationMessage ??= message;

    if (entry.timeoutHandle) {
      clearTimeout(entry.timeoutHandle);
      entry.timeoutHandle = undefined;
    }

    const sent = entry.child.kill("SIGTERM");
    if (!sent) {
      this.forceKill(entry);
      return;
    }

    if (!entry.killHandle) {
      entry.killHandle = setTimeout(() => {
        this.forceKill(entry);
      }, KILL_GRACE_MS);
    }
  }

  private forceKill(entry: RunningRequest): void {
    if (entry.settled) {
      return;
    }

    try {
      entry.child.kill("SIGKILL");
    } catch {
      // Ignore races where the process exits between SIGTERM and SIGKILL.
    }
  }

  private finishWithResult(
    entry: RunningRequest,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (entry.settled) {
      return;
    }

    entry.settled = true;
    this.cleanup(entry);

    const durationMs = Date.now() - entry.startedAt;
    const stderr = this.withTerminationMessage(entry.stderr, entry.terminationMessage);

    entry.resolve({
      fullOutput: entry.stdout,
      exitCode: code ?? (signal ? -1 : 0),
      stderr,
      durationMs,
    });
  }

  private finishWithError(entry: RunningRequest, error: unknown): void {
    if (entry.settled) {
      return;
    }

    entry.settled = true;
    this.cleanup(entry);
    entry.reject(error);
  }

  private cleanup(entry: RunningRequest): void {
    if (entry.timeoutHandle) {
      clearTimeout(entry.timeoutHandle);
      entry.timeoutHandle = undefined;
    }

    if (entry.killHandle) {
      clearTimeout(entry.killHandle);
      entry.killHandle = undefined;
    }

    this.active.delete(entry.requestId);
    this.drainQueue();
  }

  private drainQueue(): void {
    while (this.active.size < this.maxConcurrent) {
      const next = this.queue.shift();
      if (!next) {
        return;
      }

      this.startRequest(next);
    }
  }

  private withTerminationMessage(stderr: string, message?: string): string {
    if (!message) {
      return stderr;
    }

    if (!stderr) {
      return message;
    }

    return stderr.endsWith("\n") ? `${stderr}${message}` : `${stderr}\n${message}`;
  }
}

export const subprocessPool = new SubprocessPool();
