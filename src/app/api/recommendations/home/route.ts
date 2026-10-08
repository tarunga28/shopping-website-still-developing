import { z } from "zod";

import { apiOk, withErrorHandling } from "@/lib/api-response";
import { catalogApiLimiter, enforceRateLimit } from "@/lib/catalog/api";
import { ValidationError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { searchSessionHash, looksLikeBot } from "@/lib/search/session";
import { DEFAULT_RECOMMENDATION_LIMIT, MAX_RECOMMENDATION_LIMIT } from "@/lib/recommendations/types";
import { recommend } from "@/services/recommendations/engine.service";
import { getFeatureFlags, getSettings } from "@/services/recommendations/config.service";
import { getProfile, shouldPersonalize } from "@/services/recommendations/profile.service";
import { listRecentlyViewed, listPurchasedProductIds } from "@/services/recommendations/events.service";
import { getOptionalUser } from "@/server/auth/session";

export const dynamic = "force-dynamic";

const limiter = catalogApiLimiter("api-recommendations-home", 60);

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_RECOMMENDATION_LIMIT).optional(),
  /** Which rails the page actually needs. Defaults to the full home set. */
  sections: z.string().max(300).optional(),
});

const HOME_SECTIONS = ["forYou", "trending", "recentlyViewed", "popular", "newArrivals"] as const;
type HomeSection = (typeof HOME_SECTIONS)[number];

const SECTION_TYPES: Record<HomeSection, "PERSONALIZED_FOR_YOU" | "TRENDING_PRODUCTS" | "RECENTLY_VIEWED" | "POPULAR_IN_CATEGORY" | "NEW_USER_RECOMMENDATIONS"> = {
  forYou: "PERSONALIZED_FOR_YOU",
  trending: "TRENDING_PRODUCTS",
  recentlyViewed: "RECENTLY_VIEWED",
  popular: "POPULAR_IN_CATEGORY",
  newArrivals: "NEW_USER_RECOMMENDATIONS",
};

/**
 * GET /api/recommendations/home
 *
 *   limit     items per rail, 1–40
 *   sections  comma-separated subset of forYou, trending, recentlyViewed,
 *             popular, newArrivals
 *
 * Five rails in one request rather than five round trips (§35). On a mobile
 * connection five sequential fetches for a home page is the difference between
 * a page that feels instant and one that visibly assembles itself.
 *
 * The rails are generated concurrently. They are independent, so there is no
 * reason to serialize them — and the profile lookup happens once and is shared,
 * which is the other saving over five separate calls.
 *
 * A rail that fails returns an empty list rather than failing the response.
 * The home page should render with four rails if the fifth is broken.
 */
export const GET = withErrorHandling(async (request: Request) => {
  enforceRateLimit(limiter, request);

  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    limit: url.searchParams.get("limit") ?? undefined,
    sections: url.searchParams.get("sections") ?? undefined,
  });
  if (!parsed.success) {
    throw new ValidationError("Invalid home recommendation request", parsed.error.flatten());
  }

  const requested = parsed.data.sections
    ? parsed.data.sections
        .split(",")
        .map((value) => value.trim())
        .filter((value): value is HomeSection => (HOME_SECTIONS as readonly string[]).includes(value))
    : [...HOME_SECTIONS];

  if (requested.length === 0) {
    throw new ValidationError("No valid sections requested");
  }

  const user = await getOptionalUser().catch(() => null);
  const sessionHash = searchSessionHash({ userId: user?.id ?? null, request });
  const limit = parsed.data.limit ?? DEFAULT_RECOMMENDATION_LIMIT;

  const [flags, settings] = await Promise.all([
    getFeatureFlags().catch(() => null),
    getSettings().catch(() => null),
  ]);

  const profile = await getProfile(
    user?.id ? { userId: user.id } : { sessionHash },
    { now: new Date() },
  ).catch(() => null);

  const personalized = Boolean(
    flags?.personalizedRecommendations && shouldPersonalize(profile?.confidence ?? 0),
  );

  // Recently-viewed ids are needed by two rails and are cheap to share.
  const recentlyViewed = await listRecentlyViewed(
    user?.id ? { userId: user.id } : { sessionId: sessionHash },
    { limit: 24 },
  ).catch(() => [] as Array<{ productId: string }>);
  const viewedProductIds = recentlyViewed.map((entry) => entry.productId);

  const purchasedProductIds =
    user?.id && flags?.personalizedRecommendations
      ? await listPurchasedProductIds(user.id, { limit: 100 }).catch(() => [] as string[])
      : [];

  const startedAt = Date.now();

  // Concurrent, bounded. `Promise.all` rather than a serial loop: the rails are
  // independent, and serializing them would make the home page latency the sum
  // of five rankings instead of the slowest one.
  const entries = await Promise.all(
    requested.map(async (section) => {
      const type = SECTION_TYPES[section];

      // A rail with no possible signal is skipped rather than served empty.
      // §66: only render personalized sections when useful data exists.
      if (section === "forYou" && !personalized) {
        return [section, null] as const;
      }
      if (section === "recentlyViewed" && viewedProductIds.length === 0) {
        return [section, null] as const;
      }
      if (section === "trending" && flags && !flags.trendingEngine) {
        return [section, null] as const;
      }

      try {
        const result = await recommend({
          type,
          userId: user?.id ?? null,
          sessionHash,
          limit,
          interests: personalized ? profile?.interests : {},
          pricePreference: personalized ? profile?.pricePreference : {},
          confidence: personalized ? (profile?.confidence ?? 0) : 0,
          context: { viewedProductIds, purchasedProductIds },
        });
        return [
          section,
          {
            recommendationId: result.recommendationId,
            type: result.type,
            algorithmVersion: result.algorithmVersion,
            heading: result.heading,
            degraded: result.degraded,
            sourceSignals: result.sourceSignals,
            items: flags?.explanations === false
              ? result.items.map((item) => ({ ...item, explanation: null }))
              : result.items,
          },
        ] as const;
      } catch (error) {
        // One broken rail must not take the home page down with it.
        logger.warn("home recommendation rail failed", {
          section,
          error: error instanceof Error ? error.message : String(error),
        });
        return [section, null] as const;
      }
    }),
  );

  const rails: Record<string, unknown> = {};
  for (const [section, payload] of entries) {
    rails[section] = payload;
  }

  logger.info("home recommendations served", {
    sections: requested.join(","),
    personalized,
    tookMs: Date.now() - startedAt,
  });

  return apiOk(
    {
      personalized,
      confidence: profile?.confidence ?? 0,
      // Echoed so the client can tell a personalized home from a cold-start
      // one without inferring it from the contents.
      profileSignalCount: profile?.signalCount ?? 0,
      attributionWindowDays: settings?.attributionWindowDays ?? 7,
      rails,
    },
    { headers: { "Cache-Control": "private, max-age=60, stale-while-revalidate=120" } },
  );
});
