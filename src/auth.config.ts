import type { NextAuthConfig } from "next-auth";

/**
 * Edge-safe Auth.js config — NO node-only imports (db, crypto services)
 * so it can power the edge proxy. Providers attach in `src/auth.ts`.
 */

/** Roles allowed to touch /admin surfaces. */
export const ADMIN_ROLES = ["ADMIN", "SUPER_ADMIN", "PRODUCT_MANAGER", "ORDER_MANAGER", "SUPPORT"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export function isAdminRole(role: string | undefined | null): boolean {
  return ADMIN_ROLES.includes(role as AdminRole);
}

export const authConfig = {
  pages: {
    signIn: "/login",
  },
  session: {
    strategy: "jwt",
    maxAge: 30 * 24 * 60 * 60, // 30 days
    updateAge: 24 * 60 * 60, // rolling refresh daily
  },
  cookies: {
    // httpOnly + sameSite=lax + Secure (in prod) come from Auth.js defaults.
    sessionToken: {
      options: {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
      },
    },
  },
  callbacks: {
    /** Route gating used by the edge proxy (token claims only, no DB). */
    authorized({ auth, request }) {
      const { pathname, search } = request.nextUrl;
      const isAuthed = Boolean(auth?.user?.id);

      if (pathname.startsWith("/admin")) {
        if (!isAuthed) {
          const url = new URL("/login", request.nextUrl.origin);
          url.searchParams.set("redirect", pathname + search);
          return Response.redirect(url);
        }
        // Customers are bounced quietly — no confirmation the area exists.
        if (!isAdminRole(auth?.user?.role)) {
          return Response.redirect(new URL("/", request.nextUrl.origin));
        }
        return true;
      }

      if (pathname.startsWith("/account")) {
        if (!isAuthed) {
          const url = new URL("/login", request.nextUrl.origin);
          url.searchParams.set("redirect", pathname + search);
          return Response.redirect(url);
        }
        return true;
      }

      return true;
    },

    jwt({ token, user, trigger, session }) {
      // On sign-in, persist identity + authorization claims.
      if (user) {
        token.sub = user.id;
        token.name = user.name;
        token.email = user.email;
        token.role = user.role;
        token.status = user.status;
        token.stamp = user.securityStamp;
        token.emailVerified = Boolean(user.emailVerifiedAt);
      }
      if (trigger === "update" && session) {
        // Session refresh path (e.g. after profile verification).
        if (typeof session === "object") {
          const update = session as { emailVerified?: boolean; name?: string };
          if (update.emailVerified !== undefined) token.emailVerified = update.emailVerified;
          if (update.name !== undefined) token.name = update.name;
        }
      }
      return token;
    },

    session({ session, token }) {
      if (token.sub) session.user.id = token.sub;
      session.user.role = token.role ?? "CUSTOMER";
      session.user.status = token.status ?? "ACTIVE";
      session.user.verified = Boolean(token.emailVerified);
      session.user.stamp = typeof token.stamp === "number" ? token.stamp : undefined;
      return session;
    },
  },
  providers: [], // attached in src/auth.ts (node runtime only)
  trustHost: true,
} satisfies NextAuthConfig;

export default authConfig;
