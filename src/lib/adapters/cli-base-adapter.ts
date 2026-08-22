import crypto from "node:crypto";

import { subprocessPool } from "./subprocess-pool";
import { workspaceManager } from "./workspace-manager";
import type {
  AdapterExecuteOptions,
  AdapterHealthResult,
  AdapterSessionInfo,
  NpcAdapter,
} from "./types";

const sessionStore = new Map<string, string>();

export abstract class CliBaseAdapter implements NpcAdapter {
  abstract readonly type: string;
  abstract readonly cliCommand: string;

  abstract buildArgs(options: AdapterExecuteOptions, sessionRef?: string): string[];
  abstract parseStreamChunk(raw: string): string;
  abstract extractSessionId(fullOutput: string): string | undefined;

  async execute(options: AdapterExecuteOptions): Promise<{
    response: string;
    session: AdapterSessionInfo;
  }> {
    const { sessionKey, prompt, onDelta, timeoutMs, userId, projectId } = options;
    const existingRef = sessionStore.get(sessionKey);
    const cwd = projectId ? await workspaceManager.ensureWorkspace(projectId) : process.cwd();

    const env: Record<string, string> = {};
    if (userId) {
      env.HOME = workspaceManager.getUserAuthHome(userId);
    }

    const args = this.buildArgs(options, existingRef);
    let fullResponse = "";
    let streamBuffer = "";

    const appendParsedChunk = (raw: string) => {
      const parsed = this.parseStreamChunk(raw);
      if (!parsed) return;
      fullResponse += parsed;
      onDelta?.(parsed);
    };

    const result = await subprocessPool.execute({
      command: this.cliCommand,
      args,
      cwd,
      env,
      stdin: prompt,
      onStdout: (chunk) => {
        streamBuffer += chunk;
        const lines = streamBuffer.split(/\r?\n/g);
        streamBuffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line) continue;
          appendParsedChunk(line);
        }
      },
      timeoutMs: timeoutMs ?? 180_000,
    });

    if (streamBuffer) {
      appendParsedChunk(streamBuffer);
    }

    if (!fullResponse) {
      fullResponse = result.fullOutput;
    }

    const sessionRef =
      this.extractSessionId(result.fullOutput) || existingRef || crypto.randomUUID();
    sessionStore.set(sessionKey, sessionRef);

    return {
      response: fullResponse,
      session: { sessionRef },
    };
  }

  async testConnection(_config: Record<string, unknown>): Promise<AdapterHealthResult> {
    try {
      const result = await subprocessPool.execute({
        command: this.cliCommand,
        args: ["--version"],
        timeoutMs: 10_000,
      });

      if (result.exitCode === 0) {
        return { status: "ok", version: result.fullOutput.trim() };
      }

      return { status: "error", message: result.stderr || "Non-zero exit code" };
    } catch {
      return { status: "not_installed", message: `${this.cliCommand} not found in PATH` };
    }
  }

  async getSessionSummary(sessionKey: string): Promise<string> {
    const result = await this.execute({
      sessionKey,
      prompt: "Summarize what we have done in this session in 3 lines.",
    });
    return result.response;
  }

  async resetSession(sessionKey: string): Promise<void> {
    sessionStore.delete(sessionKey);
  }
}
