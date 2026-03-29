import { db, mapTemplates } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  try {
    const [template] = await db
      .select()
      .from(mapTemplates)
      .where(eq(mapTemplates.id, id))
      .limit(1);

    if (!template) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    const tiledJson = typeof template.tiledJson === "string"
      ? template.tiledJson
      : JSON.stringify(template.tiledJson, null, 2);

    if (!tiledJson || tiledJson === "null") {
      return NextResponse.json({ error: "No Tiled JSON data available" }, { status: 404 });
    }

    return new NextResponse(tiledJson, {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${template.name.replace(/[^a-zA-Z0-9가-힣_-]/g, "_")}.tmj"`,
      },
    });
  } catch (err) {
    console.error("Failed to download template:", err);
    return NextResponse.json({ error: "Failed to download" }, { status: 500 });
  }
}
