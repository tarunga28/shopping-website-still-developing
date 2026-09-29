import "server-only";
import { pool } from "@/db";
import { logger } from "@/lib/logger";

/**
 * Database-backed fixed-window rate limiting.
 *
 * Correct across horizontally-scaled instances (PostgreSQL is the shared
 * state) and executed as ONE atomic upsert, so concurrent requests can't
 * read-and-overwrite each other's counters. Fails open with a warning if
 * the counter table is momentarily unavailable (auth traffic must not
 * 500 because a throttle counters can't be written).
 */

export interface RateLimitRule {
  /** Requests allowed per window. */
  limit: number;
  windowMs: number;
}

export interface RateLimitOutcome {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export async function checkRateLimit(
  bucket: string,
  identity: string,
  rule: RateLimitRule,
): Promise<RateLimitOutcome> {
  const key = `${bucket}:${identity.toLowerCase().slice(0, 180)}`;
  const windowReset = new Date(Date.now() + rule.windowMs);

  try {
    const result = await pool.query<{ hits: number; reset_at: Date }>(
      `INSERT INTO rate_limits (key, hits, reset_at)
       VALUES ($1, 1, $2)
       ON CONFLICT (key) DO UPDATE SET
         hits = CASE WHEN rate_limits.reset_at <= now() THEN 1 ELSE rate_limits.hits + 1 END,
         reset_at = CASE WHEN rate_limits.reset_at <= now() THEN $2 ELSE rate_limits.reset_at END
       RETURNING hits, reset_at`,
      [key, windowReset],
    );

    const row = result.rows[0];
    const retryAfterMs = Math.max(0, row.reset_at.getTime() - Date.now());
    return {
      allowed: row.hits <= rule.limit,
      remaining: Math.max(0, rule.limit - row.hits),
      retryAfterMs,
    };
  } catch (error) {
    logger.warn("Rate-limiter unavailable, failing open", {
      bucket,
      error: error instanceof Error ? error.message : "unknown",
    });
    return { allowed: true, remaining: rule.limit, retryAfterMs: 0 };
  }
}

/** Shared rule presets for sensitive endpoints. */
export const AUTH_RATE_RULES = {
  login: { limit: 10, windowMs: 10 * 60 * 1000 }, // 10 attempts / 10 min / identity
  register: { limit: 8, windowMs: 60 * 60 * 1000 },
  forgotPassword: { limit: 5, windowMs: 60 * 60 * 1000 },
  resetPassword: { limit: 10, windowMs: 60 * 60 * 1000 },
  verification: { limit: 5, windowMs: 60 * 60 * 1000 },
  changePassword: { limit: 10, windowMs: 60 * 60 * 1000 },
} as const satisfies Record<string, RateLimitRule>;
