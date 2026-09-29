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

/** Generous enough for normal browsing and prefetching, tight enough to blunt scraping. */
export function catalogApiLimiter(namespace: string, limit = 120): RateLimiter {
  return createRateLimiter({ limit, windowMs: 60_000, namespace });
}

export function enforceRateLimit(limiter: RateLimiter, request: Request): void {
  if (!limiter.check(clientIp(request)).success) throw new RateLimitError();
}
