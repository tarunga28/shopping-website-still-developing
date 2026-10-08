import { apiOk, withErrorHandling } from "@/lib/api-response";
import { catalogApiLimiter, enforceRateLimit } from "@/lib/catalog/api";
import { searchSessionHash } from "@/lib/search/session";
import { MAX_SUGGESTION_PREFIX, getSuggestions } from "@/services/search/suggest.service";
import { getSearchHistory, historyToSuggestions } from "@/services/search/history.service";
import { getOptionalUser } from "@/server/auth/session";

export const dynamic = "force-dynamic";

/**
 * Autocomplete fires on every keystroke, so it gets the tightest limit of any
 * endpoint here — a client that polls it aggressively is either a bug or a
 * scraper, and neither should be served.
 */
const limiter = catalogApiLimiter("api-search-suggestions", 180);

/**
 * GET /api/search/suggestions?q=iph&limit=8
 *
 * Returns typed suggestions: PRODUCT, BRAND, CATEGORY, SEARCH_QUERY,
 * TRENDING_QUERY, HISTORY. The type is the contract that lets the frontend
 * render each differently — a product with a thumbnail, a brand with a logo, a
 * plain query as text.
 *
 * History is included only for a signed-in shopper, and only their own.
 *
 * This endpoint never runs the search pipeline. That is deliberate: autocomplete
 * has to answer in single-digit milliseconds, and spell correction over the
 * vocabulary costs far more than that.
 */
export const GET = withErrorHandling(async (request: Request) => {
  enforceRateLimit(limiter, request);

  const url = new URL(request.url);
  const prefix = (url.searchParams.get("q") ?? "").slice(0, MAX_SUGGESTION_PREFIX);

  const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 20) : 10;

  const user = await getOptionalUser().catch(() => null);

  // History is fetched in parallel with nothing else depending on it, so a
  // failure leaves autocomplete working rather than broken.
  const history = user
    ? await getSearchHistory(user.id, { limit: 5 }).then(historyToSuggestions).catch(() => [])
    : [];

  const result = await getSuggestions({ prefix, limit, history });

  const sessionHash = searchSessionHash({ userId: user?.id ?? null, request });

  return apiOk({
    ...result,
    // Exposed so a client can attribute a click without a second round trip.
    sessionHash,
  });
}, "api-search-suggestions");
