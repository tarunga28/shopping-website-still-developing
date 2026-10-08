import { z } from "zod";

import { apiOk, withErrorHandling } from "@/lib/api-response";
import { catalogApiLimiter, enforceRateLimit } from "@/lib/catalog/api";
import { ValidationError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { searchSessionHash, looksLikeBot } from "@/lib/search/session";
import {
  resolveRecommendationType,
  DEFAULT_RECOMMENDATION_LIMIT,
  MAX_RECOMMENDATION_LIMIT,
  type RecommendationType,
} from "@/lib/recommendations/types";
import { recommend } from "@/services/recommendations/engine.service";
import { getProfile, shouldPersonalize } from "@/services/recommendations/profile.service";
import { getFeatureFlags } from "@/services/recommendations/config.service";
import { listPurchasedProductIds } from "@/services/recommendations/events.service";
import { getOptionalUser } from "@/server/auth/session";

export const dynamic = "force-dynamic";

/**
 * Recommendations are called once per rail on a page, and a product page can
 * carry four of them. The limit is tighter than the catalog listing's because
 * the work behind one request — candidate generation, hydration, ranking — is
 * heavier than a filtered listing.
 *
 * Not CDN-cached: the response is personalized by session, so a shared cache
 * would serve one shopper's recommendations to another.
 */
const limiter = catalogApiLimiter("api-recommendations", 90);

const querySchema = z.object({
  type: z.string().min(1).max(64),
  productId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_RECOMMENDATION_LIMIT).optional(),
  /** Comma-separated ids already in the basket. */
  cart: z.string().max(2000).optional(),
  /** Comma-separated ids already shown on this page. */
  exclude: z.string().max(2000).optional(),
});

function parseIdList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
    .slice(0, 60);
}

/**
 * GET /api/recommendations
 *
 *   type        recommendation type, or a URL alias (similar, for-you,
 *               frequently-bought, cross-sell, upsell, cart, trending, ...)
 *   productId   seed product, required for product-page slots
 *   categoryId  category scope, used by trending / popular-in-category
 *   limit       1–40
 *   cart        comma-separated product ids in the basket
 *   exclude     comma-separated ids already rendered on the page
 *
 * The response carries `recommendationId`, which the client must echo back on
 * impression and click events. Without it there is no attribution, and the
 * dashboard can report impressions but never conversions.
 *
 * A `userId` parameter is deliberately *not* accepted. Identity comes from the
 * session only — accepting it from the query string would let anyone request
 * another shopper's personalized rail (§58).
 */
export const GET = withErrorHandling(async (request: Request) => {
  enforceRateLimit(limiter, request);

  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    type: url.searchParams.get("type") ?? "",
    productId: url.searchParams.get("productId") ?? undefined,
    categoryId: url.searchParams.get("categoryId") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
    cart: url.searchParams.get("cart") ?? undefined,
    exclude: url.searchParams.get("exclude") ?? undefined,
  });
  if (!parsed.success) {
    throw new ValidationError("Invalid recommendation request", parsed.error.flatten());
  }

  const type = resolveRecommendationType(parsed.data.type);
  if (!type) {
    throw new ValidationError(`Unknown recommendation type: ${parsed.data.type}`);
  }

  const user = await getOptionalUser().catch(() => null);
  const sessionHash = searchSessionHash({ userId: user?.id ?? null, request });

  const flags = await getFeatureFlags();
  const personalizable = flags.personalizedRecommendations && shouldPersonalizeType(type);

  // Anonymous visitors get session-scoped recommendations. §20 is explicit
  // that account creation must not be a precondition for basic discovery.
  const profile = await getProfile(
    user?.id ? { userId: user.id } : { sessionHash },
    { now: new Date() },
  ).catch(() => null);

  const personalized = personalizable && shouldPersonalize(profile?.confidence ?? 0);

  // Purchased ids are loaded only for the slots that suppress them, because
  // the query touches the order tables and most slots do not need it.
  const purchasedProductIds =
    user?.id && needsPurchaseHistory(type)
      ? await listPurchasedProductIds(user.id, { limit: 200 }).catch(() => [] as string[])
      : [];

  const result = await recommend({
    type,
    productId: parsed.data.productId ?? null,
    categoryId: parsed.data.categoryId ?? null,
    userId: user?.id ?? null,
    sessionHash,
    limit: parsed.data.limit ?? DEFAULT_RECOMMENDATION_LIMIT,
    interests: personalized ? profile?.interests : {},
    pricePreference: personalized ? profile?.pricePreference : {},
    confidence: personalized ? (profile?.confidence ?? 0) : 0,
    context: {
      cartProductIds: parseIdList(parsed.data.cart),
      purchasedProductIds,
      viewedProductIds: parseIdList(parsed.data.exclude),
    },
  });

  logger.info("recommendation api served", {
    type,
    results: result.items.length,
    strategy: result.strategy,
    tookMs: result.tookMs,
    degraded: result.degraded,
  });

  // Explanations are behind a flag so a bad template can be turned off without
  // a deploy taking the rail with it.
  const items = flags.explanations
    ? result.items
    : result.items.map((item) => ({ ...item, explanation: null }));

  return apiOk(
    {
      recommendationId: result.recommendationId,
      type: result.type,
      algorithmVersion: result.algorithmVersion,
      generatedAt: result.generatedAt,
      heading: result.heading,
      // Whether the rail is genuinely personalized, so the client can label it
      // honestly rather than calling a trending list "for you".
      personalized,
      degraded: result.degraded,
      sourceSignals: result.sourceSignals,
      items,
    },
    // Short private cache: the same shopper reloading a page should not pay for
    // a fresh ranking, but a shared cache would leak one shopper's rail.
    { headers: { "Cache-Control": "private, max-age=60, stale-while-revalidate=120" } },
  );
});

/** Types whose whole purpose is personalization. */
function shouldPersonalizeType(type: RecommendationType): boolean {
  return (
    type === "PERSONALIZED_FOR_YOU" ||
    type === "CONTINUE_SHOPPING" ||
    type === "RECENTLY_VIEWED" ||
    type === "POST_PURCHASE_RECOMMENDATIONS"
  );
}

/** Types that must know what the shopper already owns. */
function needsPurchaseHistory(type: RecommendationType): boolean {
  return (
    type === "POST_PURCHASE_RECOMMENDATIONS" ||
    type === "CONTINUE_SHOPPING" ||
    type === "CUSTOMER_ALSO_BOUGHT" ||
    type === "PERSONALIZED_FOR_YOU"
  );
}
