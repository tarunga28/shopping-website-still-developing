import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import authConfig from "@/auth.config";

/**
 * Edge proxy (Next.js 16 convention — superseded `middleware.ts`).
 *
 * Responsibilities, in order:
 *  1. Attach a correlation ID to every request/response.
 *  2. Gate private segments using Auth.js token claims (edge-cheap,
 *     no DB): /account requires any session, /admin requires an admin
 *     role. Guests keep their intended destination in `?redirect=`.
 *  3. Everything mutating privileges is re-verified against the DB on
 *     the server (see `src/server/auth/session.ts`) — token claims are
 *     never the only line of defense.
 */

const { auth } = NextAuth(authConfig);

export const proxy = auth(function proxied(request) {
  const requestId = crypto.randomUUID();

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-request-id", requestId);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("x-request-id", requestId);
  return response;
});

export const config = {
  matcher: [
    // Run on everything except Next internals, the auth API and static files.
    "/((?!api/auth|_next/static|_next/image|icon.svg|images/|robots.txt|sitemap.xml|manifest.webmanifest).*)",
  ],
};
