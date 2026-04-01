import fs from "node:fs/promises";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

import { resolveRuntimeUploadRequestPath } from "@/lib/runtime-assets";

const CONTENT_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
]);

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path: pathSegments } = await params;
  const requestPath = `/assets/uploads/${pathSegments.join("/")}`;
  const filePath = resolveRuntimeUploadRequestPath(requestPath);

  if (!filePath) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  try {
    const file = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();

    return new NextResponse(new Uint8Array(file), {
      status: 200,
      headers: {
        "Content-Type": CONTENT_TYPES.get(ext) || "application/octet-stream",
        "Cache-Control": "public, max-age=60",
      },
    });
  } catch {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
}
