import { NextRequest, NextResponse } from "next/server";

import { subprocessPool } from "@/lib/adapters/subprocess-pool";
import { workspaceManager } from "@/lib/adapters/workspace-manager";
import { getUserId } from "@/lib/internal-rpc";
import { getOwnedProviderResource } from "@/lib/provider-resources";

interface CliLoginCommand {
  command: string;
  args: string[];
}

function getCliLoginCommand(providerType: string): CliLoginCommand | null {
  switch (providerType) {
    case "claude":
      return { command: "claude", args: ["auth", "login"] };
    case "codex":
      return { command: "codex", args: ["login", "--device-auth"] };
    case "gemini":
      return { command: "gemini", args: ["auth", "login"] };
    case "opencode":
      return { command: "opencode", args: ["auth", "login"] };
    default:
      return null;
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  const owned = await getOwnedProviderResource(userId, id);
  if (!owned) {
    return NextResponse.json({ errorCode: "forbidden", error: "forbidden" }, { status: 403 });
  }

  const cliLogin = getCliLoginCommand(owned.providerType);
  if (!cliLogin) {
    return NextResponse.json(
      { errorCode: "unsupported_provider_type", error: "Provider type does not support CLI login" },
      { status: 400 },
    );
  }

  const userHome = await workspaceManager.ensureUserAuthHome(userId);
  let requestId = "pending";
  const execution = subprocessPool.execute({
    command: cliLogin.command,
    args: cliLogin.args,
    cwd: userHome,
    env: {
      HOME: userHome,
    },
    timeoutMs: 15 * 60 * 1000,
    onStdout: (chunk) => {
      console.log(`[providers cli-login:${requestId}] ${chunk.trimEnd()}`);
    },
    onStderr: (chunk) => {
      console.error(`[providers cli-login:${requestId}:stderr] ${chunk.trimEnd()}`);
    },
  });
  requestId = execution.requestId;

  void execution
    .then((result) => {
      console.log(
        `[providers cli-login:${requestId}] exited code=${result.exitCode} durationMs=${result.durationMs}`,
      );
      if (result.stderr) {
        console.error(`[providers cli-login:${requestId}:stderr] ${result.stderr.trimEnd()}`);
      }
    })
    .catch((error) => {
      console.error(`[providers cli-login:${requestId}] failed`, error);
    });

  return NextResponse.json({
    status: "pending",
    message: "Check CLI output for auth URL",
    requestId,
  });
}
