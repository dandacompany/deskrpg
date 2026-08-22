import { NextRequest, NextResponse } from "next/server";

import { ClaudeAdapter } from "@/lib/adapters/claude-adapter";
import { CodexAdapter } from "@/lib/adapters/codex-adapter";
import { GeminiAdapter } from "@/lib/adapters/gemini-adapter";
import { OpencodeAdapter } from "@/lib/adapters/opencode-adapter";
import { type AdapterHealthResult, AdapterRegistry } from "@/lib/adapters/types";
import { getUserId } from "@/lib/internal-rpc";

interface AdapterStatusPayload {
  installed: boolean;
  status: AdapterHealthResult["status"];
  version?: string;
  model?: string;
  message?: string;
}

function createHealthRegistry() {
  const registry = new AdapterRegistry();

  for (const adapter of [
    new ClaudeAdapter(),
    new CodexAdapter(),
    new GeminiAdapter(),
    new OpencodeAdapter(),
  ]) {
    registry.register(adapter);
  }

  return registry;
}

function toStatusPayload(result: AdapterHealthResult): AdapterStatusPayload {
  return {
    installed: result.status !== "not_installed",
    status: result.status,
    ...(result.version ? { version: result.version } : {}),
    ...(result.model ? { model: result.model } : {}),
    ...(result.message ? { message: result.message } : {}),
  };
}

export async function GET(req: NextRequest) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }

  const registry = createHealthRegistry();
  const adapterEntries = await Promise.all(
    registry
      .listInstalled()
      .sort()
      .map(async (type) => {
        const result = await registry.get(type).testConnection({});
        return [type, toStatusPayload(result)] as const;
      }),
  );

  return NextResponse.json({
    adapters: Object.fromEntries(adapterEntries),
  });
}
