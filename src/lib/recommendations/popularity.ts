/**
 * Popularity and trending.
 *
 * These are deliberately two separate scores, not one.
 *
 * A single combined number has a specific failure mode: a three-year-old
 * bestseller accumulates so much lifetime volume that it stays on top forever,
 * and "trending" becomes a permanent label for the same four products. Keeping
 * lifetime popularity and momentum apart is what lets a product with 20 views
 * yesterday and 800 today surface as trending even though its lifetime sales
 * are unremarkable.
 *
 * Popularity is also not simply total sales. Sales alone reward products that
 * have been listed longest and that happen to be cheap; blending views,
 * add-to-carts, wishlist adds and conversion produces a measure of actual
 * demand that a brand-new product can climb.
 */

/** Raw behavioural counters for one product within one scope. */
export interface PopularityCounters {
  viewCount: number;
  addToCartCount: number;
  wishlistCount: number;
  purchaseCount: number;
  revenuePaise: number;
}

export const EMPTY_COUNTERS: PopularityCounters = {
  viewCount: 0,
  addToCartCount: 0,
  wishlistCount: 0,
  purchaseCount: 0,
  revenuePaise: 0,
};

/**
 * How much each behaviour counts toward popularity.
 *
 * Purchase dominates, but does not swamp: add-to-cart is a strong intent
 * signal that a product which has not yet converted still earns, and a
 * purchase-only score would ignore everything a shopper did before paying.
 */
export const POPULARITY_WEIGHTS = {
  view: 1,
  addToCart: 6,
  wishlist: 5,
  purchase: 25,
} as const;

/**
 * Lifetime popularity score.
 *
 * Log-scaled so a product with 100,000 views does not make one with 1,000
 * invisible. Popularity is used as a ranking component alongside relevance,
 * and an unbounded linear score would eventually drown every other signal —
 * which is how a recommender quietly becomes a bestseller list.
 */
export function popularityScore(counters: PopularityCounters): number {
  const weighted =
    counters.viewCount * POPULARITY_WEIGHTS.view +
    counters.addToCartCount * POPULARITY_WEIGHTS.addToCart +
    counters.wishlistCount * POPULARITY_WEIGHTS.wishlist +
    counters.purchaseCount * POPULARITY_WEIGHTS.purchase;
  if (weighted <= 0) return 0;
  return Number(Math.log1p(weighted).toFixed(4));
}

/**
 * Conversion rate, guarded against a zero-view denominator.
 *
 * Reported alongside popularity rather than folded into it, because a high
 * conversion on three views is noise while a high conversion on three thousand
 * is signal — and collapsing them into one number loses which is which.
 */
export function conversionRate(counters: PopularityCounters): number {
  if (counters.viewCount <= 0) return 0;
  return Number(Math.min(1, counters.purchaseCount / counters.viewCount).toFixed(6));
}

/* ── Trending / momentum ──────────────────────────────────────────────── */

export interface TrendingInput {
  /** Activity in the recent window (e.g. last 24h). */
  recent: PopularityCounters;
  /** Activity in the baseline window (e.g. prior 30d), for normalization. */
  baseline: PopularityCounters;
  /** Days in the baseline window — needed to make the rates comparable. */
  baselineDays: number;
  /** Days in the recent window. */
  recentDays?: number;
}

export const DEFAULT_TRENDING_OPTIONS = {
  baselineDays: 30,
  recentDays: 1,
  /** Below this much recent activity, momentum is noise rather than a trend. */
  minRecentActivity: 20,
  /** Dampens momentum for products with a thin baseline. */
  baselineSmoothing: 5,
} as const;

/**
 * Momentum: recent activity against the product's own baseline rate.
 *
 * Compared to *its own* history rather than to other products, because the
 * question "is this gaining attention?" is about change, and a category leader
 * and a niche product can both legitimately be trending.
 *
 * Smoothing matters: a product with one historical view that gets two today
 * has technically doubled, and an unsmoothed ratio would call that a trend.
 * Adding a small constant to the baseline rate makes small numbers behave
 * sensibly without suppressing genuine spikes on larger ones.
 */
export function trendingScore(input: TrendingInput): number {
  const recentDays = input.recentDays ?? DEFAULT_TRENDING_OPTIONS.recentDays;
  const baselineDays = Math.max(input.baselineDays, 1);
  const smoothing = DEFAULT_TRENDING_OPTIONS.baselineSmoothing;

  const recentActivity =
    input.recent.viewCount * POPULARITY_WEIGHTS.view +
    input.recent.addToCartCount * POPULARITY_WEIGHTS.addToCart +
    input.recent.wishlistCount * POPULARITY_WEIGHTS.wishlist +
    input.recent.purchaseCount * POPULARITY_WEIGHTS.purchase;

  if (recentActivity < DEFAULT_TRENDING_OPTIONS.minRecentActivity) return 0;

  const baselineActivity =
    input.baseline.viewCount * POPULARITY_WEIGHTS.view +
    input.baseline.addToCartCount * POPULARITY_WEIGHTS.addToCart +
    input.baseline.wishlistCount * POPULARITY_WEIGHTS.wishlist +
    input.baseline.purchaseCount * POPULARITY_WEIGHTS.purchase;

  const recentRate = recentActivity / Math.max(recentDays, 1);
  const baselineRate = baselineActivity / baselineDays;

  // Ratio of current rate to expected rate. A brand-new product with no
  // baseline gets a real score, because "no history" is not "no momentum".
  const ratio = recentRate / (baselineRate + smoothing);
  if (ratio <= 1) return 0;

  // log-scaled so a 100x spike does not outrank everything else forever.
  return Number(Math.log1p(ratio - 1).toFixed(4));
}

/**
 * Blend trending and popularity for a "trending now" rail.
 *
 * Momentum leads, but lifetime popularity is not ignored entirely: a product
 * that is suddenly getting attention *and* has a track record of converting is
 * a safer recommendation than one that is merely being looked at.
 */
export function trendingBlend(
  trending: number,
  popularity: number,
  options: { momentumWeight?: number } = {},
): number {
  const momentumWeight = options.momentumWeight ?? 0.75;
  const popularityWeight = 1 - momentumWeight;
  return Number((trending * momentumWeight + popularity * popularityWeight).toFixed(4));
}

/* ── Cold start ───────────────────────────────────────────────────────── */

export interface ColdStartInput {
  /** Days since publication. */
  ageDays: number;
  ratingAverage: number | null;
  ratingCount: number;
  inStock: boolean;
  /** Similarity to at least one already-popular product, 0–1. */
  similarityToPopular?: number;
}

/**
 * Exposure score for a product with no behavioural history.
 *
 * A new product cannot earn popularity, so it is scored on what is actually
 * knowable: quality signals, stock, and resemblance to products that already
 * perform. Without this, cold-start products never enter any candidate pool
 * and therefore never accumulate the history that would let them in — the
 * feedback loop that freezes a catalog in place.
 *
 * The age boost is deliberately modest and capped. §18 asks for *controlled*
 * exposure, not a novelty rail: a new product should get a chance to be seen,
 * not dominate the page.
 */
export function coldStartScore(
  input: ColdStartInput,
  options: { maxAgeBoostDays?: number; minRatings?: number } = {},
): number {
  const maxAgeBoostDays = options.maxAgeBoostDays ?? 14;
  const minRatings = options.minRatings ?? 5;

  if (!input.inStock) return 0;

  // Quality: Wilson-ish floor so one 5-star review does not read as perfect.
  let quality = 0;
  if (input.ratingAverage !== null && input.ratingCount >= minRatings) {
    const confidence = input.ratingCount / (input.ratingCount + 10);
    quality = (input.ratingAverage / 5) * confidence;
  }

  // Newness: full boost on day 0, gone by maxAgeBoostDays.
  const age = Math.max(0, input.ageDays);
  const newness = age >= maxAgeBoostDays ? 0 : 1 - age / maxAgeBoostDays;

  const resemblance = input.similarityToPopular ?? 0;

  // Quality carries the most weight — exposure should go to products that are
  // likely to convert, not merely to the newest arrivals.
  const score = quality * 0.5 + newness * 0.3 + resemblance * 0.2;
  return Number(Math.min(1, Math.max(0, score)).toFixed(4));
}

/* ── Diversity across scopes ──────────────────────────────────────────── */

/**
 * Pick a balanced set from several popularity scopes.
 *
 * Prevents a "popular" rail from being ten items out of one category, which is
 * what happens when a single category dominates site traffic and the rail is
 * filled purely by global score.
 */
export function diversifyByScope<T>(
  items: readonly T[],
  keyOf: (item: T) => string | null,
  options: { limit: number; maxPerKey?: number },
): T[] {
  const maxPerKey = options.maxPerKey ?? Math.max(2, Math.ceil(options.limit / 4));
  const counts = new Map<string, number>();
  const selected: T[] = [];
  const deferred: T[] = [];

  for (const item of items) {
    const key = keyOf(item) ?? "__none__";
    const seen = counts.get(key) ?? 0;
    if (seen < maxPerKey) {
      counts.set(key, seen + 1);
      selected.push(item);
      if (selected.length >= options.limit) return selected;
    } else {
      deferred.push(item);
    }
  }

  // Fill any remaining slots rather than returning a short rail: capping
  // diversity is better than showing nothing, but an empty page is worse than
  // a slightly repetitive one.
  for (const item of deferred) {
    if (selected.length >= options.limit) break;
    selected.push(item);
  }
  return selected;
}
