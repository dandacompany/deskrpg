// NPC MCP connector REST — the dispatch table is `@/lib/connector-routes`.
import type { NextRequest } from "next/server";

import { handleConnectorRoute } from "@/lib/connector-routes";

type Ctx = { params: Promise<{ id: string; npcId: string; path?: string[] }> };

const handle = async (req: NextRequest, { params }: Ctx) => handleConnectorRoute(req, await params);

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
