import type { UserRole, UserStatus } from "@/db/schema";
import { DefaultSession } from "next-auth";

/**
 * Auth.js type augmentation — authorization claims travel typed through
 * the JWT and session.
 */
declare module "next-auth" {
  interface User {
    role?: UserRole;
    status?: UserStatus;
    securityStamp?: number;
    emailVerifiedAt?: Date | null;
  }

  interface Session {
    user: {
      id: string;
      role: UserRole;
      status: UserStatus;
      /** True once the account email has been verified. */
      verified: boolean;
      /** Server-side session invalidation counter (integer, non-secret). */
      stamp?: number;
    } & Omit<DefaultSession["user"], "emailVerified">;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    role?: UserRole;
    status?: UserStatus;
    stamp?: number;
    emailVerified?: boolean;
  }
}
