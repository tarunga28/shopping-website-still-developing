import "server-only";

import { unstable_cache } from "next/cache";

import { CATALOG_CACHE_TAG } from "@/lib/catalog/constants";
import { logger } from "@/lib/logger";
import type { RecommendationType } from "@/lib/recommendations/types";

/**
 * Caching for recommendation candidate sets (§48).
 *
 * The layer caches **candidate seeds**, not recommendation results, and that
 * distinction is the whole design:
 *
 *   - A seed is `{ productId, source, strength }` — an id and a number. It
 *     contains no price, no stock, no image. Caching it therefore cannot serve
 *     stale inventory, which is the specific hazard §48 warns about. Stock and
 *     price are read live during hydration on every request.
 *   - Ranking stays per-request. It depends on the shopper's profile and the
 *     current basket, so caching it would serve one shopper's rail to another.
 *
 * That split is also what §50 asks for: precomputed candidate sets, online
 * ranking.
 *
 * Only types whose candidate set is a pure function of the seed are cached.
 * `PERSONALIZED_FOR_YOU`, `CART_*` and friends depend on who is asking or what
 * is in the basket, so a seed-only cache key would be wrong for them — and
 * wrong in the dangerous direction, leaking one shopper's rail to another.
 */

/** Cache tag. Shares the catalog tag so a catalog write expires recommendations too. */
export const RECOMMENDATION_CACHE_TAG = CATALOG_CACHE_TAG;

/**
 * Upper bound on staleness.
 *
 * Short, because the offline job rewrites the underlying tables and a rail
 * should pick that up promptly. The tag handles catalog edits immediately;
 * this bounds the gap for job runs and direct SQL changes.
 */
export const RECOMMENDATION_REVALIDATE_SECONDS = 300;

/**
 * Types whose candidates depend only on the seed product or category.
 *
 * Deliberately an allowlist. Adding a subject-dependent type here would make
 * the cache key insufficient, and the failure would be silent — the wrong
 * shopper's recommendations, served with a 200.
 */
const CACHEABLE_TYPES: ReadonlySet<RecommendationType> = new Set([
  "SIMILAR_PRODUCTS",
  "RELATED_PRODUCTS",
  "FREQUENTLY_BOUGHT_TOGETHER",
  "CUSTOMER_ALSO_BOUGHT",
  "CUSTOMER_ALSO_VIEWED",
  "CROSS_SELL",
  "UPSELL",
  "TRENDING_PRODUCTS",
  "POPULAR_IN_CATEGORY",
]);

export function isCacheableType(type: RecommendationType): boolean {
  return CACHEABLE_TYPES.has(type);
}

/**
 * The cache key for a candidate set.
 *
 * Includes everything the generation reads and nothing it does not. Omitting
 * `candidateLimit` would serve a 6-item pool to a caller asking for 40; adding
 * the subject would fragment the cache into one entry per shopper and defeat
 * the point.
 */
export function candidateCacheKey(
  type: RecommendationType,
  seed: { productId?: string | null; categoryId?: string | null; candidateLimit?: number },
): string[] {
  return [
    "rec:candidates",
    type,
    seed.productId ?? "-",
    seed.categoryId ?? "-",
    String(seed.candidateLimit ?? 200),
  ];
}

/**
 * Wrap a candidate generator in the cache.
 *
 * Returns both the seeds and whether they came from the cache, so the request
 * row can record a truthful HIT or MISS. Inferring hit rate from anything else
 * — or hardcoding it — produces a dashboard number that means nothing.
 */
export async function cachedCandidates<T>(
  key: string[],
  generate: () => Promise<T>,
): Promise<{ value: T; fromCache: boolean }> {
  let computed = false;
  const run = async () => {
    computed = true;
    return generate();
  };

  try {
    const wrapped = unstable_cache(run, key, {
      tags: [RECOMMENDATION_CACHE_TAG],
      revalidate: RECOMMENDATION_REVALIDATE_SECONDS,
    });
    const value = await wrapped();
    // `computed` is only set when the underlying generator actually ran. On a
    // hit the closure is never invoked, which is exactly the signal we want.
    return { value, fromCache: !computed };
  } catch (error) {
    /* `unstable_cache` requires an incremental cache, which only exists inside
     * a Next.js request. Outside one — the offline job, a script, a test that
     * does not mock `next/cache` — it throws an invariant rather than simply
     * not caching.
     *
     * A cache is an optimization. Letting it break candidate generation would
     * mean every cacheable rail silently degrades to the popularity fallback,
     * which returns plausible-looking but wrong results — the worst possible
     * failure, because nothing looks broken. So fall back to generating
     * directly and report a MISS, which is the truthful answer. */
    if (!computed) {
      logger.warn("recommendation candidate cache unavailable; generating directly", {
        key: key.join("|"),
        error: error instanceof Error ? error.message : String(error),
      });
      return { value: await run(), fromCache: false };
    }
    throw error;
  }
}
