/**
 * Co-purchase association metrics.
 *
 * Three numbers, because one is never enough:
 *
 *   support    P(A and B)          how common the pair is at all
 *   confidence P(B | A)            given A was bought, how often B follows
 *   lift       confidence / P(B)   association beyond B's own popularity
 *
 * `lift` is the one that makes this safe to ship. Confidence alone would
 * recommend toilet paper alongside every product on the site, because everyone
 * buys toilet paper — its confidence is high everywhere. Lift divides that
 * away: a companion everyone buys anyway scores near 1.0 no matter how often
 * it appears, while a genuinely associated accessory scores well above it.
 *
 * A minimum-support floor matters for the same reason. With enough orders, any
 * two products will eventually be bought together once by coincidence, and an
 * unguarded rule would treat that as a relationship.
 */

export interface CoPurchaseCounts {
  productId: string;
  coProductId: string;
  /** Distinct orders containing both. */
  pairOrders: number;
  /** Distinct orders containing the seed. */
  productOrders: number;
  /** Distinct orders containing the companion. */
  coProductOrders: number;
  /** Total distinct orders in the window — the denominator for support. */
  totalOrders: number;
}

export interface CoPurchaseMetrics {
  support: number;
  confidence: number;
  lift: number;
  /** True when the pair clears the minimum-support floor. */
  significant: boolean;
}

export interface CoPurchaseOptions {
  /** Minimum support before a pair counts as a relationship at all. */
  minSupport?: number;
  /** Minimum lift; below this the pair is just two popular products. */
  minLift?: number;
  /** Minimum raw pair count, so tiny catalogs do not produce noise. */
  minPairOrders?: number;
}

export const DEFAULT_CO_PURCHASE_OPTIONS = {
  minSupport: 0.001,
  minLift: 1.05,
  minPairOrders: 2,
} as const;

/**
 * Compute support, confidence and lift for one pair.
 *
 * Returns zeros rather than throwing for degenerate denominators: a product
 * with no orders has no co-purchase relationships, and that is a fact about
 * the data rather than an error condition worth surfacing to a caller.
 */
export function computeCoPurchaseMetrics(
  counts: CoPurchaseCounts,
  options: CoPurchaseOptions = {},
): CoPurchaseMetrics {
  const minSupport = options.minSupport ?? DEFAULT_CO_PURCHASE_OPTIONS.minSupport;
  const minLift = options.minLift ?? DEFAULT_CO_PURCHASE_OPTIONS.minLift;
  const minPairOrders = options.minPairOrders ?? DEFAULT_CO_PURCHASE_OPTIONS.minPairOrders;

  const { pairOrders, productOrders, coProductOrders, totalOrders } = counts;
  if (
    pairOrders <= 0 ||
    productOrders <= 0 ||
    coProductOrders <= 0 ||
    totalOrders <= 0
  ) {
    return { support: 0, confidence: 0, lift: 0, significant: false };
  }

  const support = pairOrders / totalOrders;
  const confidence = pairOrders / productOrders;
  // P(B): how often the companion is bought regardless of the seed.
  const baseRate = coProductOrders / totalOrders;
  const lift = baseRate > 0 ? confidence / baseRate : 0;

  return {
    support: Number(support.toFixed(6)),
    confidence: Number(confidence.toFixed(6)),
    lift: Number(lift.toFixed(6)),
    significant: pairOrders >= minPairOrders && support >= minSupport && lift >= minLift,
  };
}

/**
 * Rank companions for a seed product.
 *
 * Ordered by lift rather than raw count. Ordering by count is the classic
 * mistake that turns "frequently bought together" into "bestsellers, again" —
 * the same four popular products under every product on the site.
 *
 * Confidence breaks ties between equally-lifted pairs, favouring the companion
 * that more reliably follows the seed.
 */
export function rankCoPurchases(
  seedProductId: string,
  pairs: ReadonlyArray<CoPurchaseCounts & { productId: string; coProductId: string }>,
  options: CoPurchaseOptions & { limit?: number; exclude?: readonly string[] } = {},
): Array<{ coProductId: string; metrics: CoPurchaseMetrics; pairOrders: number }> {
  const limit = options.limit ?? 12;
  const excluded = new Set(options.exclude ?? []);
  excluded.add(seedProductId);

  return pairs
    .filter((pair) => pair.productId === seedProductId && !excluded.has(pair.coProductId))
    .map((pair) => ({
      coProductId: pair.coProductId,
      metrics: computeCoPurchaseMetrics(pair, options),
      pairOrders: pair.pairOrders,
    }))
    .filter((entry) => entry.metrics.significant)
    .sort((a, b) => {
      const liftDelta = b.metrics.lift - a.metrics.lift;
      if (Math.abs(liftDelta) > 1e-9) return liftDelta;
      const confidenceDelta = b.metrics.confidence - a.metrics.confidence;
      if (Math.abs(confidenceDelta) > 1e-9) return confidenceDelta;
      return b.pairOrders - a.pairOrders;
    })
    .slice(0, limit);
}

/**
 * "Customers also bought", derived from co-purchase but ordered for a shopper.
 *
 * Distinct from `rankCoPurchases` in intent: that one answers "what is
 * statistically associated?", this one answers "what should we show?" — so it
 * additionally requires in-stock and applies a floor on how confident the
 * relationship must be before it is worth a slot on the page.
 */
export function rankAlsoBought(
  pairs: ReadonlyArray<CoPurchaseCounts & { inStock: boolean }>,
  options: { limit?: number; minConfidence?: number; exclude?: readonly string[] } = {},
): Array<{ coProductId: string; metrics: CoPurchaseMetrics }> {
  const limit = options.limit ?? 8;
  const minConfidence = options.minConfidence ?? 0.05;
  const excluded = new Set(options.exclude ?? []);

  return pairs
    .filter((pair) => pair.inStock && !excluded.has(pair.coProductId))
    .map((pair) => ({ coProductId: pair.coProductId, metrics: computeCoPurchaseMetrics(pair) }))
    .filter((entry) => entry.metrics.significant && entry.metrics.confidence >= minConfidence)
    .sort((a, b) => b.metrics.lift - a.metrics.lift || b.metrics.confidence - a.metrics.confidence)
    .slice(0, limit);
}

/**
 * Co-view association.
 *
 * Computed identically to co-purchase but over view sessions rather than
 * orders, because §15 is explicit that views are a weaker signal. The same
 * lift correction applies, and callers should weight the result below
 * co-purchase rather than blending the two at equal strength.
 */
export function rankCoViewed(
  pairs: ReadonlyArray<CoPurchaseCounts & { productId: string; coProductId: string }>,
  options: CoPurchaseOptions & { limit?: number; exclude?: readonly string[] } = {},
): Array<{ coProductId: string; metrics: CoPurchaseMetrics }> {
  return rankCoPurchases(pairs[0]?.productId ?? "", pairs, {
    // A stricter lift floor than purchases: co-view is noisier, since a single
    // browsing session compares several products without any intent to buy.
    minLift: options.minLift ?? 1.2,
    minPairOrders: options.minPairOrders ?? 3,
    minSupport: options.minSupport,
    limit: options.limit,
    exclude: options.exclude,
  });
}
