import { db, users } from "@/db";
import { count } from "drizzle-orm";
import { NextResponse } from "next/server";

export async function GET() {
  const [{ value: userCount }] = await db.select({ value: count() }).from(users);
  return NextResponse.json({ hasUsers: Number(userCount) > 0 });
}
