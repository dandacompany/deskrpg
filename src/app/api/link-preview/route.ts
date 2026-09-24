import { NextResponse, type NextRequest } from "next/server";

import { getUserId } from "@/lib/internal-rpc";
import { buildLinkPreview } from "@/lib/link-preview/service";

export const runtime = "nodejs";

/**
 * Link preview. Logged-in users only — this route is a tool for our server to send requests to someone else's
 * address, so leaving it open makes it an open proxy. SSRF guards, limits and caching live in `link-preview/service.ts`.
 *
 * No preview means 204. Not 404 or 500 — the screen treats "no card" as normal and
 * quietly falls back to the current underlined link.
 */
export async function GET(req: NextRequest) {
  if (!getUserId(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.searchParams.get("url");
  if (!url) return NextResponse.json({ error: "url_required" }, { status: 400 });

  const preview = await buildLinkPreview(url);
  if (!preview) return new NextResponse(null, { status: 204 });
  return NextResponse.json(preview, {
    headers: { "cache-control": "private, max-age=3600" },
  });
}
