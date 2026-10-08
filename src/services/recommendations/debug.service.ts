import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  productCoPurchases,
  productPopularity,
  productSimilarity,
  recommendationEvents,
  recommendationRequests,
} from "@/db/schema";
import type { DbClient } from "@/db/utils";
import { exclusionPolicyFor, type ExclusionReason } from "@/lib/recommendations/policy";
import { scoreCandidate, sortByScore, weightsForType } from "@/lib/recommendations/ranking";
import { scoreInterest, priceAffinity } from "@/lib/recommendations/interest";
import { computeSimilarity } from "@/lib/recommendations/similarity";
import type {
  RecommendationCandidate,
  RecommendationType,
  ScoredCandidate,
} from "@/lib/recommendations/types";
import { getConfig } from "./config.service";
import { hydrateCandidates, RECOMMENDATION_ENGINE_INTERNALS } from "./engine.service";
import { getProfile } from "./profile.service";

/**
 * The recommendation debugger (§42).
 *
 * Answers one question: *why did this rail look like that?* Every other metric
 * in the system tells you what happened; this tells you why, at the level of
 * an individual candidate.
 *
 * It is the tool that makes the difference between tuning a recommender and
 * guessing at it. Without it, "the cross-sell rail is showing phones instead
 * of cases" is a bug report with no diagnostic path — with it, the answer is
 * visible in one screen: the co-purchase generator returned nothing, so the
 * engine fell back to similarity, and similarity ranks a phone above a case.
 *
 * Admin-only. It exposes score breakdowns and exclusion reasons, which are
 * exactly the internals §36 keeps out of the public response.
 */

export interface DebugInput {
  type: RecommendationType;
  productId?: string | null;
  categoryId?: string | null;
  userId?: string | null;
  sessionHash?: string | null;
  limit?: number;
  cartProductIds?: readonly string[];
  purchasedProductIds?: readonly string[];
}

export interface CandidateTrace {
  productId: string;
  name: string;
  slug: string;
  /** Which generator proposed it, and how strongly. */
  sources: Array<{ source: string; strength: number }>;
  /** Every scoring component, for the breakdown view. */
  components: Record<string, number>;
  finalScore: number;
  dominant: string;
  position: number | null;
  /** Set when the candidate was dropped, with the reason. */
  excludedReason: ExclusionReason | null;
}

export interface DebugResult {
  type: RecommendationType;
  algorithmVersion: string;
  configVersion: string;
  weights: Record<string, number>;
  strategy: string;
  degraded: boolean;
  profile: {
    confidence: number;
    signalCount: number;
    personalized: boolean;
    /** Top keys per dimension — names, never raw user data. */
    topInterests: Record<string, Array<{ key: string; weight: number }>>;
  };
  candidateCount: number;
  resultCount: number;
  tookMs: number;
  candidates: CandidateTrace[];
  /** Counts per exclusion reason, so a systemic problem is visible at a glance. */
  exclusionSummary: Record<string, number>;
  /** Precomputed-table coverage for the seed, which explains an empty rail. */
  seedCoverage: {
    similarityRows: number;
    coPurchaseRows: number;
    popularityRow: boolean;
  } | null;
}

/**
 * Trace a recommendation request end to end.
 *
 * Re-runs the real pipeline rather than replaying a stored result, because the
 * question is usually "what would happen *now*", and a stored trace would be
 * describing a candidate pool that has since changed.
 *
 * Unlike the production path, nothing is persisted: a debug run must not
 * create a request row or pollute the metrics it is trying to explain.
 */
export async function traceRecommendation(
  input: DebugInput,
  client: DbClient = db,
): Promise<DebugResult> {
  const startedAt = Date.now();
  const type = input.type;
  const limit = Math.min(Math.max(input.limit ?? 12, 1), 40);

  const config = await getConfig(type, client);

  // ── Profile ──────────────────────────────────────────────────────────
  let profile = {
    confidence: 0,
    signalCount: 0,
    interests: {} as Record<string, Record<string, number>>,
    pricePreference: {} as Record<string, { minPaise: number; maxPaise: number }>,
  };
  if (input.userId || input.sessionHash) {
    try {
      const loaded = await getProfile(
        input.userId ? { userId: input.userId } : { sessionHash: input.sessionHash! },
        { now: new Date() },
        client,
      );
      profile = {
        confidence: loaded.confidence,
        signalCount: loaded.signalCount,
        interests: loaded.interests as Record<string, Record<string, number>>,
        pricePreference: loaded.pricePreference,
      };
    } catch {
      // A missing profile is a legitimate state (new shopper), not an error.
    }
  }
  const personalized = profile.confidence >= 0.15;

  // ── Candidates ───────────────────────────────────────────────────────
  const { seeds, strategy } = await RECOMMENDATION_ENGINE_INTERNALS.generateCandidates(
    {
      type,
      productId: input.productId,
      categoryId: input.categoryId,
      userId: input.userId,
      sessionHash: input.sessionHash,
      limit,
      candidateLimit: 120,
      context: {
        cartProductIds: input.cartProductIds,
        purchasedProductIds: input.purchasedProductIds,
      },
      interests: profile.interests,
      confidence: profile.confidence,
    },
    client,
  );

  const hydrated = await hydrateCandidates(
    seeds.map((seed) => seed.productId),
    client,
  );

  const candidates: RecommendationCandidate[] = [];
  const seedById = new Map(seeds.map((seed) => [seed.productId, seed]));
  for (const seed of seeds) {
    const candidate = hydrated.get(seed.productId);
    if (!candidate) continue;
    candidate.sources[seed.source] = Math.max(candidate.sources[seed.source] ?? 0, seed.strength);
    candidates.push(candidate);
  }

  // ── Score, using the same code path production uses ──────────────────
  const popularity = await RECOMMENDATION_ENGINE_INTERNALS.loadPopularity(
    candidates.map((candidate) => candidate.productId),
    client,
  );
  const seedCandidate = input.productId ? hydrated.get(input.productId) : undefined;

  const scored: ScoredCandidate[] = candidates.map((candidate) => {
    const seed = seedById.get(candidate.productId);
    const band = candidate.categoryId ? profile.pricePreference[candidate.categoryId] : undefined;
    return scoreCandidate({
      type,
      candidate,
      weights: config.weights,
      userInterest: personalized
        ? scoreInterest(profile.interests, {
            CATEGORY: candidate.categoryId,
            BRAND: candidate.brandId,
          }) * priceAffinity(candidate.pricePaise, band)
        : 0,
      similarity: seed?.similarity,
      purchaseAffinity: seed?.affinity,
      popularity: popularity.get(candidate.productId)?.normalized,
      context: { categoryId: input.categoryId, productId: input.productId },
    });
  });

  const ranked = sortByScore(scored);
  const orderedIds = ranked.map((entry) => entry.candidate.productId);

  // ── Exclusions, traced ───────────────────────────────────────────────
  const { applyExclusions } = await import("@/lib/recommendations/policy");
  const { kept, excluded } = applyExclusions(
    ranked.map((entry) => entry.candidate),
    {
      type,
      policy: exclusionPolicyFor(type),
      seedProductId: input.productId,
      cartProductIds: input.cartProductIds,
      purchasedProductIds: input.purchasedProductIds,
    },
  );
  const keptSet = new Set(kept.map((candidate) => candidate.productId));

  const traces: CandidateTrace[] = ranked.map((entry) => {
    const candidate = entry.candidate;
    const survived = keptSet.has(candidate.productId);
    // Position is only meaningful for items that survived filtering.
    const position = survived ? orderedIds.filter((id) => keptSet.has(id)).indexOf(candidate.productId) + 1 : null;
    return {
      productId: candidate.productId,
      name: candidate.name,
      slug: candidate.slug,
      sources: Object.entries(candidate.sources).map(([source, strength]) => ({
        source,
        strength: Number((strength ?? 0).toFixed(4)),
      })),
      components: entry.components as unknown as Record<string, number>,
      finalScore: entry.score,
      dominant: entry.dominant,
      position: position !== null && position > 0 && position <= limit ? position : null,
      excludedReason: survived ? null : (excluded.get(candidate.productId) ?? null),
    };
  });

  const exclusionSummary: Record<string, number> = {};
  for (const reason of excluded.values()) {
    exclusionSummary[reason] = (exclusionSummary[reason] ?? 0) + 1;
  }

  const seedCoverage = input.productId ? await seedTableCoverage(input.productId, client) : null;

  const topInterests: Record<string, Array<{ key: string; weight: number }>> = {};
  for (const [dimension, keys] of Object.entries(profile.interests)) {
    topInterests[dimension] = Object.entries(keys)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([key, weight]) => ({ key, weight }));
  }

  return {
    type,
    algorithmVersion: "recommendation-v1",
    configVersion: config.version,
    weights: config.weights,
    strategy,
    degraded: seeds.length === 0,
    profile: {
      confidence: profile.confidence,
      signalCount: profile.signalCount,
      personalized,
      topInterests,
    },
    candidateCount: candidates.length,
    resultCount: kept.length,
    tookMs: Date.now() - startedAt,
    candidates: traces,
    exclusionSummary,
    seedCoverage,
  };
}

/**
 * How much precomputed data exists for a seed product.
 *
 * The first thing to check when a rail is empty or thin. A product with zero
 * similarity rows and zero co-purchase rows will fall back to the
 * content-similarity floor, and that is a data problem — the offline job has
 * not covered it — not a ranking problem.
 */
export async function seedTableCoverage(
  productId: string,
  client: DbClient = db,
): Promise<{ similarityRows: number; coPurchaseRows: number; popularityRow: boolean }> {
  const [similarity] = await client
    .select({ count: sql<number>`count(*)::int` })
    .from(productSimilarity)
    .where(eq(productSimilarity.productId, productId));
  const [coPurchase] = await client
    .select({ count: sql<number>`count(*)::int` })
    .from(productCoPurchases)
    .where(eq(productCoPurchases.productId, productId));
  const [popularity] = await client
    .select({ count: sql<number>`count(*)::int` })
    .from(productPopularity)
    .where(and(eq(productPopularity.productId, productId), eq(productPopularity.scope, "GLOBAL")));

  return {
    similarityRows: similarity?.count ?? 0,
    coPurchaseRows: coPurchase?.count ?? 0,
    popularityRow: (popularity?.count ?? 0) > 0,
  };
}

/**
 * Why two specific products are similar.
 *
 * Recomputes the breakdown rather than reading the stored `sources` jsonb, so
 * the answer reflects the current scoring code. A stored breakdown would keep
 * explaining a weight vector that has since changed.
 */
export async function explainSimilarity(
  productA: string,
  productB: string,
  client: DbClient = db,
): Promise<{
  score: number;
  parts: Record<string, number>;
  storedScore: number | null;
  /** Set when the recomputed score differs materially from what is stored. */
  drift: boolean;
} | null> {
  const rows = await client.execute<{
    product_id: string;
    category_id: string | null;
    category_path: string | null;
    brand_id: string | null;
    price_paise: number;
    attribute_text: string;
    name: string;
    product_type: string | null;
  }>(sql`
    select psi.product_id, psi.category_id, psi.category_path, psi.brand_id,
           psi.price_paise, psi.attribute_text, psi.name, p.product_type::text as product_type
      from product_search_index psi
      join products p on p.id = psi.product_id
     where psi.product_id in (${productA}, ${productB})
  `);
  if (rows.rows.length < 2) return null;

  const [a, b] = rows.rows.map((row) => ({
    categoryId: row.category_id,
    categoryPath: row.category_path,
    brandId: row.brand_id,
    productType: row.product_type,
    pricePaise: row.price_paise,
    attributes: row.attribute_text.split(/\s+/).filter(Boolean),
  }));

  const breakdown = computeSimilarity(a!, b!);

  const [stored] = await client
    .select({ score: productSimilarity.score })
    .from(productSimilarity)
    .where(and(eq(productSimilarity.productId, productA), eq(productSimilarity.similarProductId, productB)))
    .limit(1);

  return {
    score: breakdown.score,
    parts: breakdown.parts,
    storedScore: stored?.score ?? null,
    // A material gap means the stored matrix predates a change to the scoring
    // code and the offline job needs to run.
    drift: stored ? Math.abs(stored.score - breakdown.score) > 0.05 : false,
  };
}

/**
 * Recent requests, for the admin list view.
 *
 * Ordered by recency with the fallback flag surfaced, because a spike in
 * fallbacks is the earliest visible sign that a precomputed table has gone
 * stale — earlier than any CTR change, since the fallback still returns
 * plausible-looking products.
 */
export async function listRecentRequests(
  options: { limit?: number; type?: RecommendationType; degradedOnly?: boolean } = {},
  client: DbClient = db,
): Promise<
  Array<{
    id: string;
    recommendationId: string;
    recommendationType: RecommendationType;
    contextProductId: string | null;
    algorithmVersion: string;
    candidateCount: number;
    resultCount: number;
    tookMs: number | null;
    fallbackUsed: boolean;
    fallbackReason: string | null;
    createdAt: Date;
  }>
> {
  const limit = Math.min(options.limit ?? 50, 200);
  const filters = [];
  if (options.type) filters.push(eq(recommendationRequests.recommendationType, options.type));
  if (options.degradedOnly) filters.push(eq(recommendationRequests.fallbackUsed, true));

  const rows = await client
    .select()
    .from(recommendationRequests)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(recommendationRequests.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    recommendationId: row.recommendationId,
    recommendationType: row.recommendationType,
    contextProductId: row.contextProductId,
    algorithmVersion: row.algorithmVersion,
    candidateCount: row.candidateCount,
    resultCount: row.resultCount,
    tookMs: row.tookMs,
    fallbackUsed: row.fallbackUsed,
    fallbackReason: row.fallbackReason,
    createdAt: row.createdAt,
  }));
}

/** The items a specific request returned, in the order they were shown. */
export async function requestImpressions(
  requestId: string,
  client: DbClient = db,
): Promise<
  Array<{
    productId: string;
    name: string;
    position: number | null;
    eventType: string;
    createdAt: Date;
  }>
> {
  const rows = await client.execute<{
    product_id: string;
    name: string;
    position: number | null;
    event_type: string;
    created_at: Date;
  }>(sql`
    select re.product_id,
           coalesce(psi.name, '(removed)') as name,
           re.position,
           re.event_type,
           re.created_at
      from recommendation_events re
      left join product_search_index psi on psi.product_id = re.product_id
     where re.attributed_request_id = ${requestId}
     order by re.position nulls last, re.created_at
     limit 100
  `);

  return rows.rows.map((row) => ({
    productId: row.product_id,
    name: row.name,
    position: row.position,
    eventType: row.event_type,
    createdAt: row.created_at,
  }));
}

export const DEBUG_INTERNALS = { weightsForType, scoreCandidate };
