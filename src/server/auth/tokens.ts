import "server-only";
import { createHash, randomBytes } from "node:crypto";

/**
 * One-time auth tokens (email verification, password reset).
 *
 *  - Raw token: 32 random bytes, URL-safe base64 — only ever appears in
 *    the email/link, never in the database or logs.
 *  - Stored: SHA-256 hash of the raw token → a DB leak can't mint links.
 *  - Short, purpose-specific TTLs; tokens are single-use and older
 *    tokens of the same type are superseded on re-issue.
 */

const RAW_BYTES = 32;

export const TOKEN_TTL_MINUTES = {
  EMAIL_VERIFICATION: 60 * 24, // 24 hours
  PASSWORD_RESET: 30, // 30 minutes
  EMAIL_CHANGE: 60 * 2, // 2 hours — email change confirmations
} as const;

export function generateRawToken(): string {
  return randomBytes(RAW_BYTES).toString("base64url");
}

export function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

export function isTokenUsable(token: {
  expiresAt: Date;
  consumedAt: Date | null;
}): boolean {
  return token.consumedAt === null && token.expiresAt.getTime() > Date.now();
}
