import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import authConfig from "@/auth.config";
import { AuthError, verifyLoginCredentials } from "@/services/auth.service";
import { loginSchema, normalizeEmail } from "@/validations/auth";
import { clientIp } from "@/lib/rate-limit";

/**
 * Auth.js (node runtime) — Credentials provider over the scrypt-verified
 * users table, with JWT sessions carrying id/role/status claims.
 *
 * Sensitive identity (id, role) only ever originates here, server-side —
 * never from client-supplied values.
 */

export class InklineSigninError extends CredentialsSignin {
  constructor(code: string) {
    super();
    this.code = code;
    this.message = code;
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      id: "credentials",
      name: "Email & password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials, request) {
        const parsed = loginSchema.safeParse(credentials);
        if (!parsed.success) throw new InklineSigninError("INVALID_CREDENTIALS");

        try {
          const forwarded = request?.headers?.get?.("x-forwarded-for");
          const ip = forwarded?.split(",")[0]?.trim() ?? clientIp(request as unknown as Request);
          const user = await verifyLoginCredentials(normalizeEmail(parsed.data.email), parsed.data.password, {
            ip,
            userAgent: request?.headers?.get?.("user-agent") ?? undefined,
          });
          return user;
        } catch (error) {
          if (error instanceof AuthError) throw new InklineSigninError(error.code);
          // Rate-limits and unexpected errors surface as a generic failure.
          throw new InklineSigninError("SIGNIN_UNAVAILABLE");
        }
      },
    }),
  ],
});
