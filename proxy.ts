import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, authMode, verifySession } from "@/web/session";

/**
 * Every page and API route requires the owner's session, except endpoints that
 * authenticate themselves (cron secret, signed webhooks, signed lead intake).
 */
const PUBLIC = [/^\/login$/, /^\/api\/auth\/login$/, /^\/api\/cron\//, /^\/api\/webhooks\//, /^\/api\/intake\//, /^\/api\/health$/];

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC.some((re) => re.test(pathname))) return NextResponse.next();
  const mode = authMode();
  if (mode === "open-dev") return NextResponse.next();
  if (mode === "misconfigured") return new NextResponse("BINGO is not configured: set BINGO_OWNER_PASSWORD and BINGO_MASTER_KEY.", { status: 503 });
  if (await verifySession(req.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
