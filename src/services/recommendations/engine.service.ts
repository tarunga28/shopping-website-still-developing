import "server-only";

import { and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "@/db";
import {
  productCoPurchases,
  productPopularity,
  productSimilarity,
  productSearchIndex,
  recommendationRequests,
} from "@/db/schema";
import type { DbClient } from "@/db/utils";
import { logger } from "@/lib/logger";
import { applyDiversity, DIVERSITY_BUDGETS } from "@/lib/recommendations/diversity";
import { describeSourceSignals, explainItem, headingForType, trimSourceSignals } from "@/lib/recommendations/explain";
import { priceAffinity, scoreInterest } from "@/lib/recommendations/interest";
import {
  applyExclusions,
  capSellerShare,
  exclusionPolicyFor,
  isViableUpsell,
  type ExclusionReason,
} from "@/lib/recommendations/policy";
import { coldStartScore, trendingBlend } from "@/lib/recommendations/popularity";
import { scoreCandidate, sortByScore, weightsForType, applyExploration } from "@/lib/recommendations/ranking";
import type {
  CandidateSource,
  InterestProfile,
  RecommendationCandidate,
  RecommendationResponse,
  RecommendationType,
  RecommendedItem,
  ScoredCandidate,
} from "@/lib/recommendations/types";
import {
  cachedCandidates,
  candidateCacheKey,
  isCacheableType,
} from "./cached.service";
import {
  DEFAULT_CANDIDATE_POOL,
  DEFAULT_RECOMMENDATION_LIMIT,
  MAX_CANDIDATE_POOL,
  MAX_RECOMMENDATION_LIMIT,
} from "@/lib/recommendations/types";

/**
 * The recommendation engine.
 *
 * Pipeline, in the order §3 specifies:
 *
 *   profile + context  →  candidates  →  rank  →  filter  →  diversify  →  result
 *
 * Two structural rules hold throughout:
 *
 * 1. **Candidate generation is separate from ranking.** A generator proposes
 *    ids and a strength; it never decides the final order. That separation is
 *    what lets a new generator be added without touching the ranker, and what
 *    makes "where did this come from?" answerable after the fact.
 * 2. **Everything expensive is precomputed.** Similarity, co-purchase and
 *    popularity are read from tables written by the offline job. A page render
 *    re-ranks; it never recomputes a similarity matrix.
 *
 * Failure never propagates. Every stage degrades to the next rung of the
 * fallback ladder, and the ladder ends at "popular products", so a
 * recommendation outage cannot take a product page down with it.
 */

export const ALGORITHM_VERSION = "recommendation-v1";

export interface RecommendationInput {
  type: RecommendationType;
  /** Seed product, for product-page slots. */
  productId?: string | null;
  categoryId?: string | null;
  userId?: string | null;
  sessionHash?: string | null;
  limit?: number;
  context?: {
    cartProductIds?: readonly string[];
    purchasedProductIds?: readonly string[];
    viewedProductIds?: readonly string[];
    query?: string | null;
    surface?: string | null;
  };
  interests?: InterestProfile;
  pricePreference?: Record<string, { minPaise: number; maxPaise: number }>;
  confidence?: number;
  candidateLimit?: number;
  /** Persist the request row so impressions can be attributed to it. */
  persist?: boolean;
}

export interface RecommendationResult extends RecommendationResponse {
  heading: string;
  /** Which strategy actually served the request, for the debugger and metrics. */
  strategy: string;
  /** Excluded ids and why — surfaced only to the admin debugger. */
  exclusions: Map<string, ExclusionReason>;
  candidateCount: number;
  tookMs: number;
}

interface CandidateSeed {
  productId: string;
  source: CandidateSource;
  /** Generator-specific strength, 0–1. */
  strength: number;
  /** Precomputed similarity, when the generator has it. */
  similarity?: number;
  /** Co-purchase lift, when the generator has it. */
  affinity?: number;
}

/* ── Candidate generation ─────────────────────────────────────────────── */

/**
 * Generate candidate seeds for a recommendation type.
 *
 * Each branch answers a different question and reads a different table. That
 * is the point of §4's type system: `SIMILAR_PRODUCTS` and `CROSS_SELL` must
 * not share a generator, because a phone case is a legitimate cross-sell for a
 * phone and a nonsensical "similar product" to one.
 */
async function generateCandidates(
  input: RecommendationInput,
  client: DbClient,
): Promise<{ seeds: CandidateSeed[]; strategy: string }> {
  const pool = Math.min(input.candidateLimit ?? DEFAULT_CANDIDATE_POOL, MAX_CANDIDATE_POOL);
  const type = input.type;

  switch (type) {
    case "SIMILAR_PRODUCTS":
    case "RELATED_PRODUCTS": {
      if (!input.productId) return { seeds: [], strategy: "no-seed" };
      const seeds = await similarCandidates(input.productId, pool, client);
      if (seeds.length > 0) return { seeds, strategy: "precomputed-similarity" };
      // No precomputed rows yet (job has not run, or a brand-new product).
      const fallback = await contentSimilarCandidates(input.productId, pool, client);
      return { seeds: fallback, strategy: fallback.length > 0 ? "content-similarity" : "empty" };
    }

    case "FREQUENTLY_BOUGHT_TOGETHER":
    case "CUSTOMER_ALSO_BOUGHT": {
      if (!input.productId) return { seeds: [], strategy: "no-seed" };
      const seeds = await coPurchaseCandidates(input.productId, pool, client);
      return { seeds, strategy: seeds.length > 0 ? "co-purchase" : "empty" };
    }

    case "CUSTOMER_ALSO_VIEWED": {
      if (!input.productId) return { seeds: [], strategy: "no-seed" };
      // Co-view is not stored separately; similarity plus popularity is the
      // honest approximation until view-pair volume justifies its own table.
      const seeds = await similarCandidates(input.productId, pool, client);
      return { seeds, strategy: seeds.length > 0 ? "co-view-approximation" : "empty" };
    }

    case "CROSS_SELL": {
      if (!input.productId) return { seeds: [], strategy: "no-seed" };
      const seeds = await crossSellCandidates(input.productId, pool, client);
      return { seeds, strategy: seeds.length > 0 ? "cross-sell" : "empty" };
    }

    case "UPSELL": {
      if (!input.productId) return { seeds: [], strategy: "no-seed" };
      const seeds = await upsellCandidates(input.productId, pool, client);
      return { seeds, strategy: seeds.length > 0 ? "upsell" : "empty" };
    }

    case "CART_RECOMMENDATIONS":
    case "CHECKOUT_RECOMMENDATIONS":
    case "POST_PURCHASE_RECOMMENDATIONS": {
      const seedIds = input.context?.cartProductIds ?? [];
      if (type === "POST_PURCHASE_RECOMMENDATIONS") {
        // For post-purchase, the "basket" is what was just bought.
        const purchased = input.context?.purchasedProductIds ?? [];
        const seeds = await basketAffinityCandidates(purchased, pool, client);
        return { seeds, strategy: seeds.length > 0 ? "basket-affinity" : "empty" };
      }
      if (seedIds.length === 0) return { seeds: [], strategy: "no-basket" };
      const seeds = await basketAffinityCandidates(seedIds, pool, client);
      return { seeds, strategy: seeds.length > 0 ? "basket-affinity" : "empty" };
    }

    case "TRENDING_PRODUCTS": {
      const seeds = await trendingCandidates(input.categoryId ?? null, pool, client);
      return { seeds, strategy: seeds.length > 0 ? "trending" : "empty" };
    }

    case "POPULAR_IN_CATEGORY": {
      const seeds = await popularCandidates(input.categoryId ?? null, pool, client);
      return { seeds, strategy: seeds.length > 0 ? "popularity" : "empty" };
    }

    case "RECENTLY_VIEWED": {
      const viewed = input.context?.viewedProductIds ?? [];
      if (viewed.length === 0) return { seeds: [], strategy: "no-history" };
      return {
        seeds: viewed.slice(0, pool).map((productId, index) => ({
          productId,
          source: "RECENTLY_VIEWED" as const,
          // Most recent first.
          strength: 1 - index / Math.max(viewed.length, 1),
        })),
        strategy: "recently-viewed",
      };
    }

    case "CONTINUE_SHOPPING":
    case "PERSONALIZED_FOR_YOU": {
      const seeds = await interestCandidates(input, pool, client);
      return { seeds, strategy: seeds.length > 0 ? "interest" : "empty" };
    }

    case "NEW_USER_RECOMMENDATIONS":
    case "ANONYMOUS_RECOMMENDATIONS":
    default: {
      // Cold start: no signal to personalize from, so do not pretend.
      const seeds = await coldStartCandidates(input, pool, client);
      return { seeds, strategy: seeds.length > 0 ? "cold-start" : "empty" };
    }
  }
}

/** Precomputed content-based similarity. */
async function similarCandidates(
  productId: string,
  pool: number,
  client: DbClient,
): Promise<CandidateSeed[]> {
  const rows = await client
    .select({
      productId: productSimilarity.similarProductId,
      score: productSimilarity.score,
    })
    .from(productSimilarity)
    .where(eq(productSimilarity.productId, productId))
    .orderBy(desc(productSimilarity.score))
    .limit(pool);

  return rows.map((row) => ({
    productId: row.productId,
    source: "SIMILARITY" as const,
    strength: row.score,
    similarity: row.score,
  }));
}

/**
 * On-the-fly content similarity, for products the offline job has not covered.
 *
 * Deliberately narrow: same category, ranked by rating and popularity. This is
 * a floor, not a substitute for the precomputed matrix — it exists so a
 * brand-new product is not invisible until the next job run.
 */
async function contentSimilarCandidates(
  productId: string,
  pool: number,
  client: DbClient,
): Promise<CandidateSeed[]> {
  const [seed] = await client
    .select({ categoryId: productSearchIndex.categoryId, brandId: productSearchIndex.brandId })
    .from(productSearchIndex)
    .where(eq(productSearchIndex.productId, productId))
    .limit(1);
  if (!seed?.categoryId) return [];

  const rows = await client
    .select({
      productId: productSearchIndex.productId,
      ratingAverage: productSearchIndex.ratingAverage,
      ratingCount: productSearchIndex.ratingCount,
      popularity: productSearchIndex.popularity,
    })
    .from(productSearchIndex)
    .where(
      and(
        eq(productSearchIndex.categoryId, seed.categoryId),
        ne(productSearchIndex.productId, productId),
        eq(productSearchIndex.isSearchable, true),
      ),
    )
    .orderBy(sql`${productSearchIndex.popularity} desc`, sql`${productSearchIndex.ratingAverage} desc nulls last`)
    .limit(pool);

  return rows.map((row) => ({
    productId: row.productId,
    source: "SIMILARITY" as const,
    // Content-similarity fallback is weaker evidence than a computed score.
    strength: 0.4,
    similarity: 0.4,
  }));
}

/** Precomputed co-purchase, ranked by lift. */
async function coPurchaseCandidates(
  productId: string,
  pool: number,
  client: DbClient,
): Promise<CandidateSeed[]> {
  const rows = await client
    .select({
      productId: productCoPurchases.coProductId,
      lift: productCoPurchases.lift,
      confidence: productCoPurchases.confidence,
    })
    .from(productCoPurchases)
    .where(eq(productCoPurchases.productId, productId))
    .orderBy(desc(productCoPurchases.lift))
    .limit(pool);

  return rows
    // lift <= 1 means "co-occurs no more than chance" — that is a popular
    // product, not an associated one, and it does not belong in this slot.
    .filter((row) => row.lift > 1.05)
    .map((row) => ({
      productId: row.productId,
      source: "CO_PURCHASE" as const,
      // Bounded so one extreme lift value cannot dominate the ranking.
      strength: Math.min(1, Math.log1p(row.lift) / Math.log1p(20)),
      affinity: Math.min(1, row.confidence),
    }));
}

/**
 * Cross-sell: complements, not substitutes.
 *
 * Reads the same co-purchase table but requires the companion to be in a
 * *different* category. That single predicate is the whole distinction — a
 * co-purchased item in the same category is a substitute the shopper chose
 * instead, and recommending it as an accessory is the mistake §28 warns about.
 */
async function crossSellCandidates(
  productId: string,
  pool: number,
  client: DbClient,
): Promise<CandidateSeed[]> {
  const rows = await client.execute<{
    co_product_id: string;
    lift: number;
    confidence: number;
  }>(sql`
    select cp.co_product_id, cp.lift, cp.confidence
      from product_co_purchases cp
      join product_search_index seed on seed.product_id = cp.product_id
      join product_search_index co on co.product_id = cp.co_product_id
     where cp.product_id = ${productId}
       and cp.lift > 1.05
       and co.category_id is distinct from seed.category_id
     order by cp.lift desc
     limit ${pool}
  `);

  return rows.rows.map((row) => ({
    productId: row.co_product_id,
    source: "CO_PURCHASE" as const,
    strength: Math.min(1, Math.log1p(row.lift) / Math.log1p(20)),
    affinity: Math.min(1, row.confidence),
  }));
}

/**
 * Upsell: a genuine step up in the same category.
 *
 * Filters in SQL on the price window and category, because pulling the whole
 * catalog into the app to apply §29's thresholds would be a full scan on every
 * product page view. The relevance and rating checks still run in
 * `isViableUpsell` during ranking, where the seed's details are available.
 */
async function upsellCandidates(
  productId: string,
  pool: number,
  client: DbClient,
): Promise<CandidateSeed[]> {
  const rows = await client.execute<{
    co_product_id: string;
    similarity: number;
  }>(sql`
    select ps.similar_product_id as co_product_id, ps.score as similarity
      from product_similarity ps
      join product_search_index seed on seed.product_id = ps.product_id
      join product_search_index cand on cand.product_id = ps.similar_product_id
     where ps.product_id = ${productId}
       and cand.category_id = seed.category_id
       and cand.price_paise between seed.price_paise * 1.1 and seed.price_paise * 1.8
       and cand.is_searchable = true
     order by ps.score desc
     limit ${pool}
  `);

  return rows.rows.map((row) => ({
    productId: row.co_product_id,
    source: "SIMILARITY" as const,
    strength: row.similarity,
    similarity: row.similarity,
  }));
}

/** Affinity with everything currently in the basket. */
async function basketAffinityCandidates(
  basketProductIds: readonly string[],
  pool: number,
  client: DbClient,
): Promise<CandidateSeed[]> {
  const ids = [...new Set(basketProductIds)].slice(0, 20);
  if (ids.length === 0) return [];

  const rows = await client
    .select({
      productId: productCoPurchases.coProductId,
      // Sum across basket lines: an item associated with two things in the
      // basket is a stronger suggestion than one associated with a single line.
      lift: sql<number>`sum(${productCoPurchases.lift})`,
    })
    .from(productCoPurchases)
    .where(and(inArray(productCoPurchases.productId, ids), sql`${productCoPurchases.lift} > 1.05`))
    .groupBy(productCoPurchases.coProductId)
    .orderBy(sql`sum(${productCoPurchases.lift}) desc`)
    .limit(pool);

  return rows.map((row) => ({
    productId: row.productId,
    source: "CART_AFFINITY" as const,
    strength: Math.min(1, Math.log1p(row.lift) / Math.log1p(30)),
    affinity: Math.min(1, row.lift / 10),
  }));
}

/** Trending, by precomputed momentum. */
async function trendingCandidates(
  categoryId: string | null,
  pool: number,
  client: DbClient,
): Promise<CandidateSeed[]> {
  const rows = await client
    .select({
      productId: productPopularity.productId,
      score: productPopularity.score,
      trendingScore: productPopularity.trendingScore,
    })
    .from(productPopularity)
    .where(
      categoryId
        ? and(eq(productPopularity.scope, "CATEGORY"), eq(productPopularity.scopeId, categoryId))
        : eq(productPopularity.scope, "GLOBAL"),
    )
    .orderBy(desc(productPopularity.trendingScore))
    .limit(pool);

  return rows
    .filter((row) => row.trendingScore > 0)
    .map((row) => ({
      productId: row.productId,
      source: "TRENDING" as const,
      strength: Math.min(1, trendingBlend(row.trendingScore, row.score) / 5),
    }));
}

/** Popular, by precomputed lifetime score. */
async function popularCandidates(
  categoryId: string | null,
  pool: number,
  client: DbClient,
): Promise<CandidateSeed[]> {
  const rows = await client
    .select({
      productId: productPopularity.productId,
      score: productPopularity.score,
    })
    .from(productPopularity)
    .where(
      categoryId
        ? and(eq(productPopularity.scope, "CATEGORY"), eq(productPopularity.scopeId, categoryId))
        : eq(productPopularity.scope, "GLOBAL"),
    )
    .orderBy(desc(productPopularity.score))
    .limit(pool);

  const max = rows.reduce((best, row) => Math.max(best, row.score), 0);
  return rows.map((row) => ({
    productId: row.productId,
    source: "POPULARITY" as const,
    strength: max > 0 ? row.score / max : 0,
  }));
}

/** Personalized: candidates from the subject's strongest interest axes. */
async function interestCandidates(
  input: RecommendationInput,
  pool: number,
  client: DbClient,
): Promise<CandidateSeed[]> {
  const interests = input.interests ?? {};
  const categoryKeys = topKeys(interests.CATEGORY, 6);
  const brandKeys = topKeys(interests.BRAND, 6);
  if (categoryKeys.length === 0 && brandKeys.length === 0) return [];

  const conditions = [];
  if (categoryKeys.length > 0) conditions.push(inArray(productSearchIndex.categoryId, categoryKeys));
  if (brandKeys.length > 0) conditions.push(inArray(productSearchIndex.brandId, brandKeys));

  const rows = await client
    .select({
      productId: productSearchIndex.productId,
      categoryId: productSearchIndex.categoryId,
      brandId: productSearchIndex.brandId,
      popularity: productSearchIndex.popularity,
    })
    .from(productSearchIndex)
    .where(and(or(...conditions), eq(productSearchIndex.isSearchable, true)))
    .orderBy(sql`${productSearchIndex.popularity} desc`)
    .limit(pool);

  const categoryWeight = new Map(categoryKeys.map((key, index) => [key, 1 - index / Math.max(categoryKeys.length, 1)]));
  const brandWeight = new Map(brandKeys.map((key, index) => [key, 1 - index / Math.max(brandKeys.length, 1)]));

  return rows.map((row) => {
    const categoryStrength = row.categoryId ? (categoryWeight.get(row.categoryId) ?? 0) : 0;
    const brandStrength = row.brandId ? (brandWeight.get(row.brandId) ?? 0) : 0;
    return {
      productId: row.productId,
      source: "INTEREST" as const,
      strength: Math.min(1, Math.max(categoryStrength, brandStrength)),
    };
  });
}

/**
 * Cold start: no behavioural signal, so score on what is knowable.
 *
 * §19 is explicit that we must not pretend to personalize without signals.
 * This returns trending, new, and well-rated products with deliberate
 * diversity across categories — a broad first impression rather than a
 * confident guess about a shopper we know nothing about.
 */
async function coldStartCandidates(
  input: RecommendationInput,
  pool: number,
  client: DbClient,
): Promise<CandidateSeed[]> {
  const rows = await client
    .select({
      productId: productSearchIndex.productId,
      categoryId: productSearchIndex.categoryId,
      ratingAverage: productSearchIndex.ratingAverage,
      ratingCount: productSearchIndex.ratingCount,
      popularity: productSearchIndex.popularity,
      indexedAt: productSearchIndex.indexedAt,
    })
    .from(productSearchIndex)
    .where(
      input.categoryId
        ? and(eq(productSearchIndex.categoryId, input.categoryId), eq(productSearchIndex.isSearchable, true))
        : eq(productSearchIndex.isSearchable, true),
    )
    .orderBy(sql`${productSearchIndex.popularity} desc`)
    .limit(pool * 2);

  const now = Date.now();
  const scored = rows.map((row) => ({
    productId: row.productId,
    categoryId: row.categoryId,
    strength: coldStartScore({
      ageDays: row.indexedAt ? (now - new Date(row.indexedAt).getTime()) / 86_400_000 : 365,
      ratingAverage: row.ratingAverage,
      ratingCount: row.ratingCount,
      inStock: true,
    }),
  }));

  scored.sort((a, b) => b.strength - a.strength);

  // Spread across categories so a cold-start rail is not ten items from
  // whichever category dominates site traffic.
  const perCategory = new Map<string, number>();
  const selected: CandidateSeed[] = [];
  for (const row of scored) {
    const key = row.categoryId ?? "__none__";
    const seen = perCategory.get(key) ?? 0;
    if (seen >= 3) continue;
    perCategory.set(key, seen + 1);
    selected.push({
      productId: row.productId,
      source: row.strength > 0.6 ? ("NEW_ARRIVAL" as const) : ("POPULARITY" as const),
      strength: row.strength,
    });
    if (selected.length >= pool) break;
  }
  return selected;
}

function topKeys(dimension: Record<string, number> | undefined, limit: number): string[] {
  if (!dimension) return [];
  return Object.entries(dimension)
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key]) => key);
}

/* ── Hydration ────────────────────────────────────────────────────────── */

/**
 * Batch-hydrate candidates in one query.
 *
 * Reads from `product_search_index`, which is already denormalized to one row
 * per product with brand, category, price and rating inline. Hydrating from
 * the normalized tables instead would mean a join per candidate — the N+1 §59
 * forbids, and the reason a recommendation rail can feel slower than the page
 * it sits on.
 *
 * Stock is summed across active variants rather than read from
 * `products.stock_quantity`, because the rollup on the product row is a cache
 * and the variants are the source of truth.
 */
export async function hydrateCandidates(
  productIds: readonly string[],
  client: DbClient = db,
): Promise<Map<string, RecommendationCandidate>> {
  const ids = [...new Set(productIds)].slice(0, MAX_CANDIDATE_POOL);
  if (ids.length === 0) return new Map();

  const rows = await client.execute<{
    product_id: string;
    slug: string;
    name: string;
    brand_id: string | null;
    brand_name: string | null;
    category_id: string | null;
    category_path: string | null;
    seller_id: string | null;
    price_paise: number;
    compare_at_paise: number | null;
    rating_average: number | null;
    rating_count: number;
    is_searchable: boolean;
    stock: number;
    published_at: Date | null;
    is_new: boolean;
  }>(sql`
    select psi.product_id,
           psi.slug,
           psi.name,
           psi.brand_id,
           psi.brand_name,
           psi.category_id,
           psi.category_path,
           psi.seller_id,
           psi.price_paise,
           psi.compare_at_paise,
           psi.rating_average,
           psi.rating_count,
           psi.is_searchable,
           coalesce((
             select sum(pv.stock_quantity)
               from product_variants pv
              where pv.product_id = psi.product_id
                and pv.is_active = true
           ), 0)::int as stock,
           p.published_at,
           p.is_new
      from product_search_index psi
      join products p on p.id = psi.product_id
     where psi.product_id in (${sql.join(
       ids.map((id) => sql`${id}`),
       sql`, `,
     )})
  `);

  const hydrated = new Map<string, RecommendationCandidate>();
  for (const row of rows.rows) {
    hydrated.set(row.product_id, {
      productId: row.product_id,
      slug: row.slug,
      name: row.name,
      brandId: row.brand_id,
      brandName: row.brand_name,
      categoryId: row.category_id,
      categoryPath: row.category_path,
      sellerId: row.seller_id,
      pricePaise: row.price_paise,
      compareAtPaise: row.compare_at_paise,
      ratingAverage: row.rating_average,
      ratingCount: row.rating_count,
      // Only a searchable, in-stock product is recommendable. Checking
      // `is_searchable` here reuses the exact predicate the storefront uses to
      // decide visibility, so a hidden product can never leak into a rail.
      inStock: row.is_searchable && row.stock > 0,
      stockQuantity: row.stock,
      publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
      isNew: row.is_new,
      sources: {},
    });
  }
  return hydrated;
}

/* ── Popularity normalization ─────────────────────────────────────────── */

/**
 * Popularity scores, normalized to 0–1 across the candidate set.
 *
 * Normalized against the pool rather than against an absolute scale, because
 * the stored score is log-scaled and unbounded. Without normalization a
 * candidate set drawn from a busy category would saturate the popularity
 * component while one from a quiet category never used it — the same weight
 * meaning two different things depending on where the candidates came from.
 */
async function loadPopularity(
  productIds: readonly string[],
  client: DbClient,
): Promise<Map<string, { score: number; trending: number; normalized: number }>> {
  if (productIds.length === 0) return new Map();
  const rows = await client
    .select({
      productId: productPopularity.productId,
      score: productPopularity.score,
      trendingScore: productPopularity.trendingScore,
    })
    .from(productPopularity)
    .where(and(eq(productPopularity.scope, "GLOBAL"), inArray(productPopularity.productId, [...productIds])));

  const max = rows.reduce((best, row) => Math.max(best, row.score), 0);
  const map = new Map<string, { score: number; trending: number; normalized: number }>();
  for (const row of rows) {
    map.set(row.productId, {
      score: row.score,
      trending: row.trendingScore,
      normalized: max > 0 ? row.score / max : 0,
    });
  }
  return map;
}

/* ── The pipeline ─────────────────────────────────────────────────────── */

/**
 * Produce recommendations.
 *
 * Never throws. On any failure it falls through the ladder — primary strategy,
 * then contextual, then popular — and returns whatever it can. A recommendation
 * rail is a nice-to-have; the page it sits on is not.
 */
export async function recommend(
  input: RecommendationInput,
  client: DbClient = db,
): Promise<RecommendationResult> {
  const startedAt = Date.now();
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_RECOMMENDATION_LIMIT, 1), MAX_RECOMMENDATION_LIMIT);
  const recommendationId = randomUUID();
  const type = input.type;

  let seeds: CandidateSeed[] = [];
  let strategy = "empty";
  let degraded = false;
  let fallbackReason: string | null = null;
  let cacheStatus: "HIT" | "MISS" | "SKIP" = "SKIP";

  // ── Rung 1: the strategy this type actually calls for ──────────────────
  try {
    /* Candidate seeds are cached for the types whose candidate set is a pure
     * function of the seed. A seed is an id plus a strength — no price, no
     * stock — so a cached entry cannot serve stale inventory; price and stock
     * are read live during hydration. Ranking stays per-request, because it
     * depends on the shopper. */
    if (isCacheableType(type)) {
      const generated = await cachedCandidates(
        candidateCacheKey(type, {
          productId: input.productId,
          categoryId: input.categoryId,
          candidateLimit: input.candidateLimit,
        }),
        () => generateCandidates(input, client),
      );
      seeds = generated.value.seeds;
      strategy = generated.value.strategy;
      cacheStatus = generated.fromCache ? "HIT" : "MISS";
    } else {
      const generated = await generateCandidates(input, client);
      seeds = generated.seeds;
      strategy = generated.strategy;
      cacheStatus = "SKIP";
    }
  } catch (error) {
    degraded = true;
    fallbackReason = "candidate-generation-failed";
    logger.warn("recommendation candidate generation failed", {
      type,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // ── Rung 2: contextual fallback (same category) ────────────────────────
  if (seeds.length === 0 && input.categoryId) {
    try {
      seeds = await popularCandidates(input.categoryId, Math.min(limit * 4, DEFAULT_CANDIDATE_POOL), client);
      if (seeds.length > 0) {
        degraded = true;
        fallbackReason = fallbackReason ?? "primary-empty-used-category";
        strategy = "category-fallback";
      }
    } catch (error) {
      logger.warn("category fallback failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ── Rung 3: global popularity ──────────────────────────────────────────
  if (seeds.length === 0) {
    try {
      seeds = await popularCandidates(null, Math.min(limit * 4, DEFAULT_CANDIDATE_POOL), client);
      if (seeds.length > 0) {
        degraded = true;
        fallbackReason = fallbackReason ?? "primary-empty-used-global-popular";
        strategy = "popularity-fallback";
      }
    } catch (error) {
      logger.warn("popularity fallback failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ── Hydrate ────────────────────────────────────────────────────────────
  const seedIds = seeds.map((seed) => seed.productId);
  let hydrated = new Map<string, RecommendationCandidate>();
  try {
    hydrated = await hydrateCandidates(seedIds, client);
  } catch (error) {
    logger.error("recommendation hydration failed", {
      type,
      error: error instanceof Error ? error.message : String(error),
    });
    return emptyResult(recommendationId, type, startedAt, strategy, "hydration-failed");
  }

  const candidates: RecommendationCandidate[] = [];
  for (const seed of seeds) {
    const candidate = hydrated.get(seed.productId);
    if (!candidate) continue;
    candidate.sources[seed.source] = Math.max(candidate.sources[seed.source] ?? 0, seed.strength);
    candidates.push(candidate);
  }

  if (candidates.length === 0) {
    return emptyResult(recommendationId, type, startedAt, strategy, fallbackReason ?? "no-candidates");
  }

  // ── Score ──────────────────────────────────────────────────────────────
  const seedById = new Map(seeds.map((seed) => [seed.productId, seed]));
  let popularity = new Map<string, { score: number; trending: number; normalized: number }>();
  try {
    popularity = await loadPopularity(candidates.map((candidate) => candidate.productId), client);
  } catch {
    // Popularity is a soft signal; a missing row just means no boost.
  }

  const interests = input.interests ?? {};
  const confidence = input.confidence ?? 0;
  const personalized = confidence >= 0.15;
  const pricePreference = input.pricePreference ?? {};
  const weights = weightsForType(type);
  const seedCandidate = input.productId ? hydrated.get(input.productId) : undefined;

  const scored: ScoredCandidate[] = candidates.map((candidate) => {
    const seed = seedById.get(candidate.productId);
    const band = candidate.categoryId ? pricePreference[candidate.categoryId] : undefined;

    return scoreCandidate({
      type,
      candidate,
      weights,
      userInterest: personalized
        ? scoreInterest(interests, {
            CATEGORY: candidate.categoryId,
            BRAND: candidate.brandId,
            PRICE_BAND: undefined,
          }) * priceAffinity(candidate.pricePaise, band)
        : 0,
      similarity: seed?.similarity,
      purchaseAffinity: seed?.affinity,
      popularity: popularity.get(candidate.productId)?.normalized,
      context: {
        categoryId: input.categoryId,
        productId: input.productId,
      },
      // An upsell that is not a real step up should not be shown as one.
      relevance:
        type === "UPSELL" && seedCandidate
          ? isViableUpsell(
              { pricePaise: seedCandidate.pricePaise, categoryId: seedCandidate.categoryId },
              {
                pricePaise: candidate.pricePaise,
                categoryId: candidate.categoryId,
                ratingAverage: candidate.ratingAverage,
              },
              { similarity: seed?.similarity },
            )
            ? 1
            : 0
          : undefined,
    });
  });

  // ── Rank ───────────────────────────────────────────────────────────────
  const ranked = sortByScore(scored);

  // ── Filter (centralized exclusions, after ranking) ─────────────────────
  const policy = exclusionPolicyFor(type);
  const { kept, excluded } = applyExclusions(
    ranked.map((entry) => entry.candidate),
    {
      type,
      policy,
      seedProductId: input.productId,
      cartProductIds: input.context?.cartProductIds,
      purchasedProductIds: input.context?.purchasedProductIds,
      alreadyShownProductIds: input.context?.viewedProductIds,
    },
  );

  const keptSet = new Set(kept.map((candidate) => candidate.productId));
  const rankedKept = ranked.filter((entry) => keptSet.has(entry.candidate.productId));

  if (rankedKept.length === 0) {
    return {
      ...emptyResult(recommendationId, type, startedAt, strategy, "all-excluded"),
      exclusions: excluded,
      candidateCount: candidates.length,
    };
  }

  // ── Diversify, then bound seller share ─────────────────────────────────
  const diversified = applyDiversity(
    rankedKept,
    (entry) => ({
      brand: entry.candidate.brandId ?? entry.candidate.brandName,
      category: entry.candidate.categoryId ?? entry.candidate.categoryPath,
      seller: entry.candidate.sellerId,
      productType: null,
    }),
    DIVERSITY_BUDGETS[type] ?? { maxPerBrand: 3, maxPerCategory: 4, maxPerSeller: 3 },
    // Over-fetch slightly so exploration has somewhere to draw from.
    Math.min(limit + 4, rankedKept.length),
  );

  const sellerCapped = capSellerShare(diversified, (entry) => entry.candidate.sellerId, {
    limit,
    maxShare: type === "TRENDING_PRODUCTS" || type === "NEW_USER_RECOMMENDATIONS" ? 0.3 : 0.4,
  });

  const explored = applyExploration(sellerCapped, {
    probability: type === "PERSONALIZED_FOR_YOU" || type === "NEW_USER_RECOMMENDATIONS" ? 0.12 : 0,
    limit,
  });

  // ── Explain and shape ──────────────────────────────────────────────────
  const usedSources = new Set<CandidateSource>();
  const items: RecommendedItem[] = explored.map((entry, index) => {
    for (const source of Object.keys(entry.candidate.sources)) {
      usedSources.add(source as CandidateSource);
    }
    const fromCoPurchase =
      entry.candidate.sources.CO_PURCHASE !== undefined || entry.candidate.sources.CART_AFFINITY !== undefined;
    return {
      productId: entry.candidate.productId,
      slug: entry.candidate.slug,
      position: index + 1,
      score: entry.score,
      sources: Object.keys(entry.candidate.sources) as CandidateSource[],
      explanation: explainItem({
        type,
        components: entry.components,
        dominant: entry.dominant,
        personalized,
        categoryName: entry.candidate.categoryPath?.split("/").filter(Boolean).pop() ?? null,
        brandName: entry.candidate.brandName,
        fromCoPurchase,
        isUpsell: type === "UPSELL",
      }),
    };
  });

  const tookMs = Date.now() - startedAt;

  if (input.persist !== false) {
    await persistRequest(
      {
        recommendationId,
        type,
        input,
        algorithmVersion: ALGORITHM_VERSION,
        candidateCount: candidates.length,
        resultCount: items.length,
        tookMs,
        cacheStatus,
        fallbackUsed: degraded,
        fallbackReason,
      },
      client,
    );
  }

  logger.info("recommendation served", {
    type,
    strategy,
    candidates: candidates.length,
    results: items.length,
    tookMs,
    degraded,
  });

  return {
    recommendationId,
    type,
    algorithmVersion: ALGORITHM_VERSION,
    generatedAt: new Date().toISOString(),
    items,
    sourceSignals: trimSourceSignals(
      describeSourceSignals({
        type,
        personalized,
        usedCoPurchase: usedSources.has("CO_PURCHASE") || usedSources.has("CART_AFFINITY"),
        usedSimilarity: usedSources.has("SIMILARITY"),
        usedPopularity: usedSources.has("POPULARITY") || usedSources.has("TRENDING"),
        usedTrending: usedSources.has("TRENDING"),
        usedCart: usedSources.has("CART_AFFINITY"),
        categoryName: input.categoryId
          ? (items[0] ? null : null)
          : null,
      }),
    ),
    degraded,
    heading: headingForType(type),
    strategy,
    exclusions: excluded,
    candidateCount: candidates.length,
    tookMs,
  };
}

function emptyResult(
  recommendationId: string,
  type: RecommendationType,
  startedAt: number,
  strategy: string,
  reason: string,
): RecommendationResult {
  return {
    recommendationId,
    type,
    algorithmVersion: ALGORITHM_VERSION,
    generatedAt: new Date().toISOString(),
    items: [],
    sourceSignals: [],
    degraded: true,
    heading: headingForType(type),
    strategy,
    exclusions: new Map(),
    candidateCount: 0,
    tookMs: Date.now() - startedAt,
  };
}

interface PersistInput {
  recommendationId: string;
  type: RecommendationType;
  input: RecommendationInput;
  algorithmVersion: string;
  candidateCount: number;
  resultCount: number;
  tookMs: number;
  cacheStatus: string;
  fallbackUsed: boolean;
  fallbackReason: string | null;
}

/**
 * Record the request row.
 *
 * Failures are swallowed: this row exists so impressions can be attributed,
 * and losing it must not cost the shopper their recommendations. Unattributed
 * impressions are still counted, just not tied back to this request.
 */
async function persistRequest(record: PersistInput, client: DbClient): Promise<void> {
  try {
    await client.insert(recommendationRequests).values({
      recommendationId: record.recommendationId,
      recommendationType: record.type,
      userId: record.input.userId ?? null,
      sessionHash: record.input.sessionHash ?? null,
      contextProductId: record.input.productId ?? null,
      contextCategoryId: record.input.categoryId ?? null,
      algorithmVersion: record.algorithmVersion,
      candidateCount: record.candidateCount,
      resultCount: record.resultCount,
      tookMs: record.tookMs,
      cacheStatus: record.cacheStatus,
      fallbackUsed: record.fallbackUsed,
      fallbackReason: record.fallbackReason,
    });
  } catch (error) {
    logger.warn("failed to persist recommendation request", {
      recommendationId: record.recommendationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export const RECOMMENDATION_ENGINE_INTERNALS = {
  topKeys,
  generateCandidates,
  loadPopularity,
};
