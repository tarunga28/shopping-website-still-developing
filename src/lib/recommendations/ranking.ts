/**
 * Recommendation ranking.
 *
 * An additive, component-wise pipeline:
 *
 *   finalScore = relevance + userInterest + similarity + popularity
 *              + quality + freshness + purchaseAffinity + context
 *              - duplicationPenalty - outOfStockPenalty - stalePenalty
 *
 * Additive rather than a learned combination because every component stays
 * inspectable. The debugger can print the breakdown, the explanation layer can
 * name the dominant term, and an operator can change one weight without
 * retraining anything. A learned ranker can replace `scoreCandidates` later
 * behind the same `RecommendationModel` interface.
 *
 * Penalties are subtracted, not multiplied, so a heavily-penalised item sinks
 * below the others without the whole score collapsing to zero — which matters
 * when the candidate pool is thin and even a weak result is better than an
 * empty rail.
 */

import type {
  RankingWeights,
  RecommendationCandidate,
  RecommendationType,
  ScoreComponents,
  ScoredCandidate,
} from "./types";

/**
 * Default weights.
 *
 * The invariant that keeps this honest: the sum of the *soft* signals
 * (popularity, quality, freshness) must stay below `relevance`, or the rail
 * quietly becomes a bestseller list that ignores what the shopper is actually
 * looking at. `assertWeightBalance` enforces that on load and on save.
 */
export const DEFAULT_RANKING_WEIGHTS: RankingWeights = {
  relevance: 100,
  userInterest: 45,
  similarity: 40,
  popularity: 18,
  quality: 14,
  freshness: 8,
  purchaseAffinity: 30,
  context: 35,
  duplicationPenalty: 25,
  outOfStockPenalty: 60,
  stalePenalty: 12,
};

/**
 * Per-type overrides.
 *
 * One weight vector for every slot would be wrong in a specific, visible way:
 * a cross-sell rail scored like a similarity rail recommends a second phone
 * instead of a case. Each type states what it is optimising for.
 */
export const TYPE_WEIGHT_OVERRIDES: Partial<Record<RecommendationType, Partial<RankingWeights>>> = {
  SIMILAR_PRODUCTS: { similarity: 70, popularity: 14 },
  RELATED_PRODUCTS: { similarity: 55, context: 25 },
  FREQUENTLY_BOUGHT_TOGETHER: { purchaseAffinity: 70, similarity: 8 },
  CUSTOMER_ALSO_BOUGHT: { purchaseAffinity: 65, similarity: 10 },
  CUSTOMER_ALSO_VIEWED: { relevance: 70, purchaseAffinity: 20 },
  TRENDING_PRODUCTS: { popularity: 45, freshness: 30, userInterest: 12 },
  POPULAR_IN_CATEGORY: { popularity: 50, context: 40, userInterest: 15 },
  RECENTLY_VIEWED: { relevance: 60, freshness: 25, userInterest: 10 },
  CONTINUE_SHOPPING: { userInterest: 60, freshness: 20, relevance: 50 },
  PERSONALIZED_FOR_YOU: { userInterest: 70, popularity: 15 },
  CART_RECOMMENDATIONS: { purchaseAffinity: 65, context: 45, similarity: 10 },
  // Checkout is deliberately conservative: a slot that distracts from paying
  // costs more than the incremental order it might win.
  CHECKOUT_RECOMMENDATIONS: { purchaseAffinity: 60, popularity: 12, context: 40, freshness: 4 },
  POST_PURCHASE_RECOMMENDATIONS: { purchaseAffinity: 60, similarity: 20, context: 30 },
  CROSS_SELL: { purchaseAffinity: 70, context: 40, similarity: 5 },
  UPSELL: { similarity: 55, quality: 30, popularity: 10 },
  NEW_USER_RECOMMENDATIONS: { popularity: 45, freshness: 25, quality: 20, userInterest: 0 },
  ANONYMOUS_RECOMMENDATIONS: { context: 55, popularity: 25, userInterest: 20 },
};

export function weightsForType(type: RecommendationType): RankingWeights {
  return { ...DEFAULT_RANKING_WEIGHTS, ...(TYPE_WEIGHT_OVERRIDES[type] ?? {}) };
}

/**
 * The invariant that stops a recommender becoming a bestseller list.
 *
 * Soft signals — popularity, quality, freshness — are things the *platform*
 * knows. If together they outweigh relevance, then what the shopper is looking
 * at stops mattering and every rail converges on the same popular items.
 */
export function assertWeightBalance(weights: RankingWeights): void {
  const soft = weights.popularity + weights.quality + weights.freshness;
  const hard = weights.relevance + weights.userInterest + weights.similarity + weights.context;
  if (soft >= hard) {
    throw new Error(
      `unbalanced ranking weights: soft signals (popularity+quality+freshness=${soft}) ` +
        `must stay below contextual signals (relevance+userInterest+similarity+context=${hard}), ` +
        `or recommendations become a bestseller list that ignores the shopper`,
    );
  }
  for (const [name, value] of Object.entries(weights)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`ranking weight ${name} must be a non-negative finite number, got ${value}`);
    }
  }
}

/* ── Component scorers ────────────────────────────────────────────────── */

/**
 * Quality from rating, with a confidence discount.
 *
 * A product with one 5-star review is not better than one with 400 reviews
 * averaging 4.6, and an unguarded average says it is. The Bayesian-style
 * discount pulls low-volume ratings toward the middle.
 */
export function qualityScore(ratingAverage: number | null, ratingCount: number): number {
  if (ratingAverage === null || ratingCount <= 0) return 0.35;
  const confidence = ratingCount / (ratingCount + 10);
  return (ratingAverage / 5) * confidence;
}

/**
 * Freshness from publication age.
 *
 * Decays to zero over `windowDays`, so "new" is a bounded boost rather than a
 * permanent advantage. A product should not keep a freshness edge for years.
 */
export function freshnessScore(publishedAt: string | null, now: Date = new Date(), windowDays = 90): number {
  if (!publishedAt) return 0;
  const published = new Date(publishedAt).getTime();
  if (!Number.isFinite(published)) return 0;
  const ageDays = (now.getTime() - published) / 86_400_000;
  if (ageDays <= 0) return 1;
  if (ageDays >= windowDays) return 0;
  return 1 - ageDays / windowDays;
}

/**
 * How strongly the candidate matches the current context.
 *
 * Strongest for sharing the seed's category, weaker for a shared brand: a
 * shopper on a phone page wants other phones, and same-brand-but-different-
 * category is a plausible but lesser signal.
 */
export function contextScore(
  candidate: RecommendationCandidate,
  context: { categoryId?: string | null; brandId?: string | null; productId?: string | null },
): number {
  let score = 0;
  if (context.categoryId && candidate.categoryId === context.categoryId) score += 0.7;
  if (context.brandId && candidate.brandId === context.brandId) score += 0.3;
  // Never score the seed against itself; it is excluded upstream, but a
  // duplicate id in the pool should not silently earn the top slot.
  if (context.productId && candidate.productId === context.productId) return 0;
  return Math.min(1, score);
}

/**
 * Discount depth, 0–1.
 *
 * Used by upsell and sale-oriented slots. Bounded so a mispriced product
 * (sale price far below cost through an operator error) does not outrank
 * everything by showing an absurd discount.
 */
export function discountDepth(pricePaise: number, compareAtPaise: number | null): number {
  if (!compareAtPaise || compareAtPaise <= 0 || pricePaise <= 0) return 0;
  if (pricePaise >= compareAtPaise) return 0;
  return Math.min(0.9, (compareAtPaise - pricePaise) / compareAtPaise);
}

/* ── The pipeline ─────────────────────────────────────────────────────── */

export interface ScoringInput {
  type: RecommendationType;
  candidate: RecommendationCandidate;
  /** 0–1, from the interest profile. */
  userInterest?: number;
  /** 0–1, precomputed similarity to the seed. */
  similarity?: number;
  /** 0–1, precomputed popularity (normalized). */
  popularity?: number;
  /** 0–1, co-purchase affinity with the seed or basket. */
  purchaseAffinity?: number;
  /** 0–1, lexical or category relevance to a query. */
  relevance?: number;
  context?: { categoryId?: string | null; brandId?: string | null; productId?: string | null };
  /** Product ids already in the result set, for the duplication penalty. */
  alreadySelected?: ReadonlySet<string>;
  /** Product ids the shopper has seen many times without acting. */
  overExposed?: ReadonlySet<string>;
  weights?: RankingWeights;
  now?: Date;
}

const clamp01 = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

/**
 * Score one candidate, returning the component breakdown.
 *
 * The breakdown is not a debugging convenience — the explanation layer reads
 * `dominant` to decide what to tell the shopper, so removing it would make the
 * explanations unprincipled guesses.
 */
export function scoreCandidate(input: ScoringInput): ScoredCandidate {
  const weights = input.weights ?? weightsForType(input.type);
  const candidate = input.candidate;
  const now = input.now ?? new Date();

  const components: ScoreComponents = {
    relevance: clamp01(input.relevance) * weights.relevance,
    userInterest: clamp01(input.userInterest) * weights.userInterest,
    similarity: clamp01(input.similarity) * weights.similarity,
    popularity: clamp01(input.popularity) * weights.popularity,
    quality: qualityScore(candidate.ratingAverage, candidate.ratingCount) * weights.quality,
    freshness: freshnessScore(candidate.publishedAt, now) * weights.freshness,
    purchaseAffinity: clamp01(input.purchaseAffinity) * weights.purchaseAffinity,
    context: contextScore(candidate, input.context ?? {}) * weights.context,
    duplicationPenalty: 0,
    outOfStockPenalty: 0,
    stalePenalty: 0,
  };

  // A duplicate of something already shown — same product under another seed —
  // wastes a slot the shopper could have spent discovering something else.
  if (input.alreadySelected?.has(candidate.productId)) {
    components.duplicationPenalty = weights.duplicationPenalty;
  }
  if (!candidate.inStock) {
    components.outOfStockPenalty = weights.outOfStockPenalty;
  }
  // Shown repeatedly and never acted on: fade it rather than remove it, because
  // a shopper may simply not have been ready yet.
  if (input.overExposed?.has(candidate.productId)) {
    components.stalePenalty = weights.stalePenalty;
  }

  const positive =
    components.relevance +
    components.userInterest +
    components.similarity +
    components.popularity +
    components.quality +
    components.freshness +
    components.purchaseAffinity +
    components.context;
  const negative =
    components.duplicationPenalty + components.outOfStockPenalty + components.stalePenalty;

  const rounded: ScoreComponents = {} as ScoreComponents;
  for (const [key, value] of Object.entries(components)) {
    rounded[key as keyof ScoreComponents] = Number(value.toFixed(4));
  }

  return {
    candidate,
    score: Number((positive - negative).toFixed(4)),
    components: rounded,
    dominant: dominantComponent(rounded),
  };
}

const POSITIVE_COMPONENTS: ReadonlyArray<keyof ScoreComponents> = [
  "relevance",
  "userInterest",
  "similarity",
  "popularity",
  "quality",
  "freshness",
  "purchaseAffinity",
  "context",
];

/** The largest positive contributor — what the explanation layer cites. */
export function dominantComponent(components: ScoreComponents): keyof ScoreComponents {
  let best: keyof ScoreComponents = "relevance";
  let bestValue = -Infinity;
  for (const key of POSITIVE_COMPONENTS) {
    const value = components[key];
    if (value > bestValue) {
      bestValue = value;
      best = key;
    }
  }
  return best;
}

/**
 * Sort scored candidates.
 *
 * Ties break on rating then price, which is deterministic — so the same
 * request returns the same order rather than shuffling on every render and
 * making A/B results uninterpretable.
 */
export function sortByScore(scored: readonly ScoredCandidate[]): ScoredCandidate[] {
  return [...scored].sort((a, b) => {
    if (Math.abs(b.score - a.score) > 1e-9) return b.score - a.score;
    const ratingA = a.candidate.ratingAverage ?? 0;
    const ratingB = b.candidate.ratingAverage ?? 0;
    if (Math.abs(ratingB - ratingA) > 1e-9) return ratingB - ratingA;
    if (a.candidate.pricePaise !== b.candidate.pricePaise) {
      return a.candidate.pricePaise - b.candidate.pricePaise;
    }
    return a.candidate.productId.localeCompare(b.candidate.productId);
  });
}

/**
 * Exploration: replace a bounded slice of the tail with less-certain items.
 *
 * Only ever draws from candidates that already cleared the relevance bar —
 * §24 is explicit that exploration must not surface irrelevant products. What
 * it changes is *which* relevant products get seen, so a good product that is
 * simply new can gather the impressions it needs to prove itself.
 */
export function applyExploration(
  ranked: readonly ScoredCandidate[],
  options: { probability: number; limit: number; random?: () => number },
): ScoredCandidate[] {
  const random = options.random ?? Math.random;
  const probability = Math.min(0.5, Math.max(0, options.probability));
  if (probability <= 0 || ranked.length <= 1) return [...ranked];

  const result = [...ranked];
  // Explore only in the back half. Swapping the top slot would make the
  // headline recommendation visibly random, which reads as a bug.
  const exploreFrom = Math.max(1, Math.floor(result.length / 2));
  for (let i = exploreFrom; i < result.length; i += 1) {
    if (random() >= probability) continue;
    const j = exploreFrom + Math.floor(random() * (result.length - exploreFrom));
    if (j === i || j >= result.length) continue;
    const [moved] = result.splice(j, 1);
    if (moved) result.splice(i, 0, moved);
  }
  return result.slice(0, options.limit);
}
