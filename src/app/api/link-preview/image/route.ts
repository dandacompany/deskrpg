import { NextResponse, type NextRequest } from "next/server";

import { getUserId } from "@/lib/internal-rpc";
import { fetchGuarded } from "@/lib/link-preview/fetch";
import { isSafeImageType, normalizePreviewUrl } from "@/lib/link-preview/guard";
import { withPreviewSlot } from "@/lib/link-preview/service";

export const runtime = "nodejs";

/** Accept og:image only up to 2MB — a preview thumbnail needs no more. */
const IMAGE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The server fetches og:image on the browser's behalf. If the browser hit someone else's CDN directly, the user's IP and referrer
 * would leak to that site, and a domain allowlist could not be maintained (every site has a different CDN).
 * The guards are the same as for the page fetch — the image address is also a user-supplied address.
 */
export async function GET(req: NextRequest) {
  if (!getUserId(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const raw = req.nextUrl.searchParams.get("url");
  const target = raw ? normalizePreviewUrl(raw) : null;
  if (!target) return new NextResponse(null, { status: 204 });

  const result = await withPreviewSlot(() =>
    fetchGuarded(target, { accept: "image/", maxBytes: IMAGE_MAX_BYTES }),
  );
  if (!result.admitted) return new NextResponse(null, { status: 204 });
  const fetched = result.value;
  if (!fetched) return new NextResponse(null, { status: 204 });
  // SVG is not an image but a document that can carry scripts — opened on our origin it becomes XSS.
  if (!isSafeImageType(fetched.contentType)) return new NextResponse(null, { status: 204 });

  return new NextResponse(new Uint8Array(fetched.bytes), {
    headers: {
      "content-type": fetched.contentType,
      "content-length": String(fetched.bytes.byteLength),
      "cache-control": "private, max-age=3600",
      // These are bytes someone else gave us. Leave no room for them to be interpreted as script.
      "content-disposition": "inline",
      "x-content-type-options": "nosniff",
      // Even if the returned bytes are for some reason interpreted as a document, let them do nothing.
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}
