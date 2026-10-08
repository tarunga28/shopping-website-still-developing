import { apiOk, withErrorHandling } from "@/lib/api-response";
import { catalogApiLimiter, enforceRateLimit } from "@/lib/catalog/api";
import { requireCatalogEditorApi } from "@/server/auth/catalog-access";
import {
  clickPositions,
  lowClickQueries,
  popularQueries,
  risingQueries,
  searchOverview,
  zeroResultQueries,
} from "@/services/search/analytics.service";
import { indexStatus } from "@/services/search/index.service";
import { synonymStats } from "@/services/search/synonym.service";
import { lexiconStats } from "@/services/search/lexicon.service";
import { vocabularyStats } from "@/services/search/vocabulary.service";
import { getActiveRankingConfig } from "@/services/search/config.service";

export const dynamic = "force-dynamic";

/** Analytics queries scan the log table, so they are rate limited tightly. */
const limiter = catalogApiLimiter("api-admin-search-analytics", 30);

function parseWindow(url: URL): number {
  const raw = Number.parseInt(url.searchParams.get("days") ?? "", 10);
  if (!Number.isFinite(raw) || raw <= 0) return 30;
  return Math.min(raw, 90);
}

/**
 * GET /api/admin/search/analytics?days=30
 *
 * Everything the search dashboard needs in one round trip. Aggregated rather
 * than paginated raw rows, because the questions here are "is search healthy?"
 * and "what is failing?", not "show me every query".
 */
export const GET = withErrorHandling(async (request: Request) => {
  enforceRateLimit(limiter, request);
  await requireCatalogEditorApi();

  const url = new URL(request.url);
  const days = parseWindow(url);

  const [overview, popular, rising, zeroResults, lowClick, positions, index, synonyms, lexicon, vocabulary, ranking] =
    await Promise.all([
      searchOverview({ windowDays: days }),
      popularQueries({ windowDays: days, limit: 20 }),
      risingQueries({ windowDays: days, limit: 10 }),
      zeroResultQueries({ windowDays: days, limit: 30 }),
      lowClickQueries({ windowDays: days, limit: 20 }),
      clickPositions({ windowDays: days }),
      indexStatus(),
      synonymStats(),
      lexiconStats(),
      vocabularyStats(),
      getActiveRankingConfig(),
    ]);

  return apiOk({
    windowDays: days,
    overview,
    popular,
    rising,
    zeroResults,
    lowClick,
    clickPositions: positions,
    index,
    synonyms,
    lexicon,
    vocabulary,
    ranking: {
      version: ranking.version,
      label: ranking.label,
      outOfStockMode: ranking.outOfStockMode,
      fuzzyThreshold: ranking.fuzzyThreshold,
      maxEditDistance: ranking.maxEditDistance,
    },
  });
}, "api-admin-search-analytics");
