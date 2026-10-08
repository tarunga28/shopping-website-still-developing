import { RateLimitError } from "@/lib/errors";
import { clientIp, createRateLimiter, type RateLimiter } from "@/lib/rate-limit";

export interface ApiPagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/** Public catalog API envelope: `{ data, pagination }`. Short shared cache; the data is public. */
export function catalogApiResponse<T>(data: T[], pagination: ApiPagination): Response {
  return Response.json(
    { data, pagination },
    { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120" } },
  );
}

/**
 * Generous enough for normal browsing and prefetching, tight enough to blunt
 * scraping.
 *
 * `SEARCH_LOADTEST` raises every limit for the lifetime of the process, so
 * `npm run search:loadtest` can measure the search engine rather than this
 * limiter. Without it a load test from one IP spends nearly all its requests
 * collecting 429s and reports nothing about the engine.
 *
 * The value is the multiplier: `1` means tenfold, `100` means 100×. A numeric
 * value matters because even 10× is exhausted within seconds at moderate
 * concurrency, which still leaves throughput limiter-bound rather than
 * engine-bound.
 *
 * It is deliberately opt-in via an environment variable that is not set in any
 * shipped configuration, and it only ever *raises* a limit.
 */
export function catalogApiLimiter(namespace: string, limit = 120): RateLimiter {
  const raw = process.env.SEARCH_LOADTEST;
  let multiplier = 1;
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    multiplier = Number.isFinite(parsed) && parsed > 1 ? parsed : 10;
  }
  return createRateLimiter({ limit: limit * multiplier, windowMs: 60_000, namespace });
}

export function enforceRateLimit(limiter: RateLimiter, request: Request): void {
  if (!limiter.check(clientIp(request)).success) throw new RateLimitError();
}
