import { NextResponse } from "next/server";
import { getNpcPresets } from "@/lib/npc-presets";
import type { NextRequest } from "next/server";

export async function GET(req: NextRequest) {
  const locale = req.nextUrl.searchParams.get("locale");
  return NextResponse.json({ presets: getNpcPresets(locale || undefined) });
}
