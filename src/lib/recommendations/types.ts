/**
 * Part 13 — recommendation engine types.
 *
 * This module is deliberately free of database and framework imports. Every
 * scoring, ranking, diversity and exclusion rule lives here or beside it as a
 * pure function, which is what makes the engine unit-testable without a
 * database and swappable for a learned model later without touching callers.
 */

/* ── Recommendation types ─────────────────────────────────────────────── */

export const RECOMMENDATION_TYPES = [
  "SIMILAR_PRODUCTS",
  "RELATED_PRODUCTS",
  "FREQUENTLY_BOUGHT_TOGETHER",
  "CUSTOMER_ALSO_BOUGHT",
  "CUSTOMER_ALSO_VIEWED",
  "TRENDING_PRODUCTS",
  "POPULAR_IN_CATEGORY",
  "RECENTLY_VIEWED",
  "CONTINUE_SHOPPING",
  "PERSONALIZED_FOR_YOU",
  "CART_RECOMMENDATIONS",
  "CHECKOUT_RECOMMENDATIONS",
  "POST_PURCHASE_RECOMMENDATIONS",
  "CROSS_SELL",
  "UPSELL",
  "NEW_USER_RECOMMENDATIONS",
  "ANONYMOUS_RECOMMENDATIONS",
] as const;

export type RecommendationType = (typeof RECOMMENDATION_TYPES)[number];

/** URL-friendly aliases accepted by the public API. */
export const RECOMMENDATION_TYPE_ALIASES: Readonly<Record<string, RecommendationType>> = {
  similar: "SIMILAR_PRODUCTS",
  related: "RELATED_PRODUCTS",
  "frequently-bought": "FREQUENTLY_BOUGHT_TOGETHER",
  "frequently-bought-together": "FREQUENTLY_BOUGHT_TOGETHER",
  "also-bought": "CUSTOMER_ALSO_BOUGHT",
  "also-viewed": "CUSTOMER_ALSO_VIEWED",
  trending: "TRENDING_PRODUCTS",
  "popular-in-category": "POPULAR_IN_CATEGORY",
  "recently-viewed": "RECENTLY_VIEWED",
  "continue-shopping": "CONTINUE_SHOPPING",
  "for-you": "PERSONALIZED_FOR_YOU",
  cart: "CART_RECOMMENDATIONS",
  checkout: "CHECKOUT_RECOMMENDATIONS",
  "post-purchase": "POST_PURCHASE_RECOMMENDATIONS",
  "cross-sell": "CROSS_SELL",
  upsell: "UPSELL",
  "new-user": "NEW_USER_RECOMMENDATIONS",
  anonymous: "ANONYMOUS_RECOMMENDATIONS",
};

export function isRecommendationType(value: string): value is RecommendationType {
  return (RECOMMENDATION_TYPES as readonly string[]).includes(value);
}

export function resolveRecommendationType(raw: string | null | undefined): RecommendationType | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (isRecommendationType(trimmed)) return trimmed;
  const upper = trimmed.toUpperCase().replace(/-/g, "_");
  if (isRecommendationType(upper)) return upper;
  return RECOMMENDATION_TYPE_ALIASES[trimmed.toLowerCase()] ?? null;
}

/* ── Candidate generation ─────────────────────────────────────────────── */

/**
 * Where a candidate came from.
 *
 * Recorded per candidate rather than per request because the whole point of
 * keeping generation separate from ranking is being able to say, afterwards,
 * that the top item came from co-purchase and not from similarity.
 */
export const CANDIDATE_SOURCES = [
  "SIMILARITY",
  "CO_PURCHASE",
  "CO_VIEW",
  "CURATED",
  "POPULARITY",
  "TRENDING",
  "INTEREST",
  "CATEGORY",
  "CART_AFFINITY",
  "RECENTLY_VIEWED",
  "NEW_ARRIVAL",
] as const;

export type CandidateSource = (typeof CANDIDATE_SOURCES)[number];

/**
 * A product under consideration, before ranking.
 *
 * Carries every signal the ranker might need, so ranking never has to touch
 * the database — candidates are hydrated once, in a batch.
 */
export interface RecommendationCandidate {
  productId: string;
  slug: string;
  name: string;
  brandId: string | null;
  brandName: string | null;
  categoryId: string | null;
  categoryPath: string | null;
  sellerId: string | null;
  /** Lowest variant price, in minor units. */
  pricePaise: number;
  compareAtPaise: number | null;
  ratingAverage: number | null;
  ratingCount: number;
  /** In stock across at least one purchasable variant. */
  inStock: boolean;
  stockQuantity: number;
  publishedAt: string | null;
  isNew: boolean;
  /** Which generators proposed it, and how strongly each did. */
  sources: Partial<Record<CandidateSource, number>>;
}

/* ── Interest ─────────────────────────────────────────────────────────── */

export const INTEREST_DIMENSIONS = [
  "CATEGORY",
  "BRAND",
  "PRODUCT",
  "ATTRIBUTE",
  "PRICE_BAND",
  "PRODUCT_TYPE",
] as const;

export type InterestDimension = (typeof INTEREST_DIMENSIONS)[number];

/**
 * A raw behavioural signal, before decay.
 *
 * `occurredAt` is carried so decay is applied at read time rather than baked
 * in at write time — otherwise changing the decay function would require
 * re-deriving every historical signal.
 */
export interface InterestSignal {
  dimension: InterestDimension;
  key: string;
  /** Base weight of the event type: PURCHASE outranks VIEW. */
  weight: number;
  occurredAt: Date;
  /** Optional magnitude, e.g. order value for a purchase. */
  magnitude?: number;
}

/** Normalized interest weights, 0–1 within each dimension. */
export type InterestProfile = Partial<Record<InterestDimension, Record<string, number>>>;

/* ── Context ──────────────────────────────────────────────────────────── */

/**
 * What is true right now, independent of who the shopper is.
 *
 * Kept separate from the interest profile on purpose: context is strong and
 * immediate (the product being viewed), while a profile is weak and
 * historical. Blending them into one bag of weights loses that distinction.
 */
export interface RecommendationContext {
  productId?: string | null;
  categoryId?: string | null;
  brandId?: string | null;
  /** Product ids currently in the basket. */
  cartProductIds?: readonly string[];
  /** Product ids already bought — suppressed where inappropriate. */
  purchasedProductIds?: readonly string[];
  /** Product ids the shopper has already seen in this session. */
  viewedProductIds?: readonly string[];
  /** Free-text query, when the request came from a search page. */
  query?: string | null;
  /** Page surface the slot is on: pdp, cart, checkout, home, order. */
  surface?: string | null;
}

/* ── Ranking ──────────────────────────────────────────────────────────── */

/**
 * The additive components of a final score.
 *
 * Every component is named so the debugger can show the breakdown and the
 * explanation layer can name the dominant one. A single opaque float would
 * make "why was this recommended?" unanswerable.
 */
export interface ScoreComponents {
  relevance: number;
  userInterest: number;
  similarity: number;
  popularity: number;
  quality: number;
  freshness: number;
  purchaseAffinity: number;
  context: number;
  duplicationPenalty: number;
  outOfStockPenalty: number;
  stalePenalty: number;
}

export type RankingWeights = Record<keyof ScoreComponents, number>;

export interface ScoredCandidate {
  candidate: RecommendationCandidate;
  score: number;
  components: ScoreComponents;
  /** The component that contributed most, used for explanations. */
  dominant: keyof ScoreComponents;
}

/* ── Response ─────────────────────────────────────────────────────────── */

export interface RecommendedItem {
  productId: string;
  slug: string;
  position: number;
  score: number;
  /** Which generator(s) produced it — never the raw weights. */
  sources: CandidateSource[];
  /** Human-readable reason, safe to show a shopper. */
  explanation: string | null;
}

export interface RecommendationResponse {
  recommendationId: string;
  type: RecommendationType;
  algorithmVersion: string;
  generatedAt: string;
  items: RecommendedItem[];
  /** Named signals that shaped the result — no internal weights or user data. */
  sourceSignals: string[];
  /** True when a fallback ladder was used instead of the primary strategy. */
  degraded: boolean;
}

/* ── Model interface (§51) ────────────────────────────────────────────── */

/**
 * The seam a learned model will plug into.
 *
 * Generation, scoring and ranking are separate methods rather than one
 * `recommend()` because a hybrid system typically keeps rule-based candidate
 * generation while swapping the scorer — collapsing them would force a
 * replacement of both at once.
 */
export interface RecommendationModel {
  readonly name: string;
  readonly version: string;
  generateCandidates(input: ModelInput): Promise<RecommendationCandidate[]>;
  scoreCandidates(
    candidates: readonly RecommendationCandidate[],
    input: ModelInput,
  ): Promise<ScoredCandidate[]>;
  rankCandidates(scored: readonly ScoredCandidate[], input: ModelInput): Promise<ScoredCandidate[]>;
  explainRecommendation(item: ScoredCandidate, input: ModelInput): string | null;
}

export interface ModelInput {
  type: RecommendationType;
  context: RecommendationContext;
  interests: InterestProfile;
  limit: number;
  /** Candidate pool ceiling — bounds the work a page render can trigger. */
  candidateLimit: number;
}

/* ── Limits ───────────────────────────────────────────────────────────── */

export const MAX_RECOMMENDATION_LIMIT = 40;
export const DEFAULT_RECOMMENDATION_LIMIT = 12;
/** Ceiling on the candidate pool, so a render can never scan the catalog. */
export const MAX_CANDIDATE_POOL = 500;
export const DEFAULT_CANDIDATE_POOL = 200;
/** Below this much evidence the engine stops pretending to personalize. */
export const MIN_PERSONALIZATION_CONFIDENCE = 0.15;
