import "server-only";
import { cache } from "react";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { db } from "@/db";
import { users, type User } from "@/db/schema";
import { isAdminRole } from "@/auth.config";

/**
 * Server-side identity & authorization.
 *
 * The edge proxy does coarse gating with token claims. Everything happens
 * here behind it — the DB is the source of truth for status and the
 * security stamp, so a suspended/deactivated/rotated account loses access
 * immediately, not when its JWT expires.
 */

export const getSession = cache(async () => {
  return auth();
});

/** Session user + fresh DB row, validated against the JWT stamp. */
export const getFreshUser = cache(async (): Promise<User | null> => {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return null;

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user || user.status !== "ACTIVE") return null;

  // Stamp mismatch → a security event (password change/reset) happened
  // after this JWT was issued. Treat as signed out.
  const stamp = session.user.stamp;
  if (typeof stamp === "number" && stamp !== user.securityStamp) return null;

  return user;
});

/** Redirect to login preserving the requested destination. */
export async function requireUser(loginPath = "/login"): Promise<User> {
  const user = await getFreshUser();
  if (!user) redirect(loginPath);
  return user;
}

/** Role gate for admin surfaces. Throws a not-found for customers
 *  (admin internals aren't advertised), redirects guests to login. */
export async function requireAdminRole(): Promise<User> {
  const user = await getFreshUser();
  if (!user) redirect("/login?redirect=/admin");
  if (!isAdminRole(user.role)) {
    const { notFound } = await import("next/navigation");
    notFound();
  }
  return user;
}

/** Boolean helper for conditional UI (never for authorization). */
export async function getOptionalUser(): Promise<User | null> {
  return getFreshUser();
}

/** Coarse request context for audit/rate limiting. */
export async function authRequestContext(headersList: Headers): Promise<{ ip?: string; userAgent?: string }> {
  const forwarded = headersList.get("x-forwarded-for");
  return {
    ip: forwarded?.split(",")[0]?.trim() ?? headersList.get("x-real-ip") ?? undefined,
    userAgent: headersList.get("user-agent") ?? undefined,
  };
}
