/**
 * Rate-limit-ready architecture.
 *
 * Current backend: in-memory fixed window per key — correct for a single
 * instance and perfectly fine during early traffic. The `RateLimiter`
 * interface is deliberately small so it can be swapped for a Redis /
 * Upstash backend (multi-instance safety) without touching call sites.
 */

export interface RateLimiter {
  check(key: string): { success: boolean; remaining: number; reset: number };
}

interface Bucket {
  count: number;
  reset: number;
}

export interface RateLimiterOptions {
  /** Max requests per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Optional namespace to isolate buckets per route. */
  namespace?: string;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { limit, windowMs, namespace = "default" } = options;
  const buckets = new Map<string, Bucket>();

  // Periodic sweep so the map can't grow without bound.
  const sweep = () => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.reset <= now) buckets.delete(key);
    }
  };
  if (typeof setInterval !== "undefined") {
    const timer = setInterval(sweep, Math.max(windowMs, 60_000));
    // Don't keep the process alive for the sweeper.
    timer.unref?.();
  }

  return {
    check(key: string) {
      const now = Date.now();
      const namespaced = `${namespace}:${key}`;
      const existing = buckets.get(namespaced);

      if (!existing || existing.reset <= now) {
        const bucket: Bucket = { count: 1, reset: now + windowMs };
        buckets.set(namespaced, bucket);
        return { success: true, remaining: limit - 1, reset: bucket.reset };
      }

      existing.count += 1;
      const remaining = Math.max(0, limit - existing.count);
      return { success: existing.count <= limit, remaining, reset: existing.reset };
    },
  };
}

/** Best-effort client IP extraction from a request. */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip") ?? "anonymous";
}
