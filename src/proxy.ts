import { NextRequest, NextResponse } from "next/server";
import { verifyJWT } from "@/lib/jwt";

const PUBLIC_PATHS = ["/", "/auth", "/api/auth", "/api/health", "/robots.txt", "/sitemap.xml"];

/** Set only by this proxy from a verified token — never trusted from the client. */
const IDENTITY_HEADERS = ["x-user-id", "x-user-nickname"];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

function withoutIdentityHeaders(req: NextRequest): Headers {
  const headers = new Headers(req.headers);
  for (const name of IDENTITY_HEADERS) headers.delete(name);
  return headers;
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (isPublic(pathname) || pathname.startsWith("/_next") || pathname.startsWith("/assets")) {
    return NextResponse.next({ request: { headers: withoutIdentityHeaders(req) } });
  }

  const token = req.cookies.get("token")?.value;
  if (!token) {
    return NextResponse.redirect(new URL("/auth", req.url));
  }

  const payload = await verifyJWT(token);
  if (!payload) {
    const response = NextResponse.redirect(new URL("/auth", req.url));
    response.cookies.delete("token");
    return response;
  }

  const requestHeaders = withoutIdentityHeaders(req);
  requestHeaders.set("x-user-id", payload.userId);
  requestHeaders.set("x-user-nickname", encodeURIComponent(payload.nickname));

  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
