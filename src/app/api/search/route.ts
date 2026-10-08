import { apiOk, withErrorHandling } from "@/lib/api-response";
import { catalogApiLimiter, enforceRateLimit } from "@/lib/catalog/api";
import { ValidationError } from "@/lib/errors";
import { searchSessionHash, looksLikeBot } from "@/lib/search/session";
import {
  parseSearchFilters,
  parseSearchSort,
  parseSearchLimit,
} from "@/lib/search/filters";
import { executeSearch } from "@/services/search/query.service";
import { recordSearch } from "@/services/search/history.service";
import { getOptionalUser } from "@/server/auth/session";
import { SEARCH_SORTS } from "@/lib/search/types";

export const dynamic = "force-dynamic";

/**
 * Search is the most-hammered endpoint on the site: it fires on every filter
 * change and every keystroke if a client prefetches. The limit is therefore
 * tighter than the catalog listing's, and the response is not cached in the
 * shared CDN cache because relevance is personalised by session and filters.
 */
const limiter = catalogApiLimiter("api-search", 60);

/**
 * GET /api/search
 *
 *   q         free-text query, max 120 characters
 *   category  comma-separated category ids
 *   brand     comma-separated brand ids
 *   minPrice  rupees
 *   maxPrice  rupees
 *   rating    minimum rating, 1–5
 *   availability  any | in_stock | out_of_stock | on_sale
 *   sale      "1" to restrict to discounted products
 *   attr.<axis>   comma-separated values, e.g. attr.color=black,white
 *   sort      relevance | popularity | newest | price-asc | price-desc |
 *             rating | discount | best-selling
 *   limit     1–100
 *   cursor    opaque cursor from a previous response
 *
 * Every parameter is validated. An unparseable value is dropped rather than
 * rejected, so a hand-edited URL degrades to a working search instead of a 400.
 */
export const GET = withErrorHandling(async (request: Request) => {
  enforceRateLimit(limiter, request);

  const url = new URL(request.url);
  const rawQuery = typeof url.searchParams.get("q") === "string" ? (url.searchParams.get("q") as string) : "";

  if (rawQuery.length > 120) {
    // Rejected rather than truncated: a 500-character query is not a search, and
    // silently truncating it would return results for a query the shopper never
    // typed.
    throw new ValidationError("Search query is too long (maximum 120 characters).");
  }

  const filters = parseSearchFilters(url.searchParams);
  const sort = parseSearchSort(url.searchParams);
  const limit = parseSearchLimit(url.searchParams, 24, 100);
  const cursor = url.searchParams.get("cursor");

  const user = await getOptionalUser().catch(() => null);
  const sessionHash = searchSessionHash({ userId: user?.id ?? null, request });

  const result = await executeSearch({
    query: rawQuery,
    filters,
    sort,
    limit,
    cursor,
    sessionHash,
  });

  // History is recorded for signed-in shoppers only, out of band: it must not
  // delay the response, and it must not fail it.
  if (user && rawQuery.trim().length >= 2 && !looksLikeBot(request)) {
    void recordSearch({ userId: user.id, query: rawQuery, resultCount: result.results.length }).catch(
      () => undefined,
    );
  }

  return apiOk({
    ...result,
    // Never echoed to the client: it exists so the server can attribute a
    // subsequent click, and the client only needs to send it back.
    metadata: { ...result.metadata },
    availableSorts: SEARCH_SORTS,
  });
}, "api-search");
