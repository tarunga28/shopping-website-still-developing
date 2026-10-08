/**
 * Diversity.
 *
 * A relevance-ranked list has a specific failure mode: the top ten items are
 * the ten most similar things to whatever scored highest, which usually means
 * the same product in four colours, or four near-identical listings from the
 * same seller. Every item is individually "correct" and the rail as a whole is
 * useless, because it offers the shopper one decision ten times.
 *
 * Diversity is applied *after* ranking rather than folded into the score. That
 * ordering is deliberate: a diversity term inside the score would be traded
 * off against relevance continuously, producing items that are neither
 * particularly relevant nor particularly different. As a post-pass it is a
 * constraint — "at most N per brand" — which is both easier to reason about
 * and easier to explain to a merchandiser.
 */

import type { RecommendationCandidate, RecommendationType } from "./types";

export interface DiversityBudget {
  /** Maximum items sharing a brand. */
  maxPerBrand: number;
  /** Maximum items sharing a category. */
  maxPerCategory: number;
  /** Maximum items from one seller — the multi-vendor fairness control. */
  maxPerSeller: number;
  /** Maximum items sharing the same product type. */
  maxPerProductType?: number;
}

/**
 * Per-type diversity budgets.
 *
 * A similarity rail should be *less* diverse than a discovery rail: if a
 * shopper asks for "similar to this", showing them genuinely similar items is
 * the correct answer even if they cluster. A home feed has the opposite
 * requirement.
 */
export const DIVERSITY_BUDGETS: Readonly<Record<RecommendationType, DiversityBudget>> = {
  SIMILAR_PRODUCTS: { maxPerBrand: 4, maxPerCategory: 8, maxPerSeller: 4 },
  RELATED_PRODUCTS: { maxPerBrand: 3, maxPerCategory: 6, maxPerSeller: 3 },
  FREQUENTLY_BOUGHT_TOGETHER: { maxPerBrand: 6, maxPerCategory: 6, maxPerSeller: 6 },
  CUSTOMER_ALSO_BOUGHT: { maxPerBrand: 3, maxPerCategory: 5, maxPerSeller: 3 },
  CUSTOMER_ALSO_VIEWED: { maxPerBrand: 3, maxPerCategory: 6, maxPerSeller: 3 },
  TRENDING_PRODUCTS: { maxPerBrand: 2, maxPerCategory: 3, maxPerSeller: 2 },
  POPULAR_IN_CATEGORY: { maxPerBrand: 2, maxPerCategory: 10, maxPerSeller: 2 },
  RECENTLY_VIEWED: { maxPerBrand: 6, maxPerCategory: 6, maxPerSeller: 6 },
  CONTINUE_SHOPPING: { maxPerBrand: 2, maxPerCategory: 3, maxPerSeller: 2 },
  PERSONALIZED_FOR_YOU: { maxPerBrand: 2, maxPerCategory: 3, maxPerSeller: 2 },
  CART_RECOMMENDATIONS: { maxPerBrand: 3, maxPerCategory: 4, maxPerSeller: 3 },
  CHECKOUT_RECOMMENDATIONS: { maxPerBrand: 2, maxPerCategory: 3, maxPerSeller: 2 },
  POST_PURCHASE_RECOMMENDATIONS: { maxPerBrand: 3, maxPerCategory: 4, maxPerSeller: 3 },
  CROSS_SELL: { maxPerBrand: 3, maxPerCategory: 4, maxPerSeller: 3 },
  UPSELL: { maxPerBrand: 4, maxPerCategory: 8, maxPerSeller: 4 },
  NEW_USER_RECOMMENDATIONS: { maxPerBrand: 2, maxPerCategory: 2, maxPerSeller: 2 },
  ANONYMOUS_RECOMMENDATIONS: { maxPerBrand: 2, maxPerCategory: 3, maxPerSeller: 2 },
};

export const DEFAULT_DIVERSITY_BUDGET: DiversityBudget = {
  maxPerBrand: 3,
  maxPerCategory: 4,
  maxPerSeller: 3,
};

/** A group key, or null when the item has no value for that axis. */
type GroupKey = string | null;

interface GroupedItem<T> {
  item: T;
  brand: GroupKey;
  category: GroupKey;
  seller: GroupKey;
  productType: GroupKey;
}

function groupKeys<T>(
  item: T,
  extract: (item: T) => {
    brand: GroupKey;
    category: GroupKey;
    seller: GroupKey;
    productType: GroupKey;
  },
): GroupedItem<T> {
  return { item, ...extract(item) };
}

/**
 * Greedy selection under diversity constraints.
 *
 * Iterates the ranked list in order and takes an item if it fits every budget,
 * otherwise defers it. Deferred items are used to fill any remaining slots
 * once the list is exhausted, because a short rail is worse than a slightly
 * repetitive one — the constraint is a preference, not a hard requirement.
 *
 * Items with no value for an axis (no brand, no seller) are exempt from that
 * axis's cap. Treating "unknown" as a shared bucket would lump every
 * unbranded product together and starve the rail.
 */
export function applyDiversity<T>(
  ranked: readonly T[],
  extract: (item: T) => { brand: GroupKey; category: GroupKey; seller: GroupKey; productType: GroupKey },
  budget: DiversityBudget,
  limit: number,
): T[] {
  if (limit <= 0) return [];
  const grouped = ranked.map((item) => groupKeys(item, extract));

  const counts = {
    brand: new Map<string, number>(),
    category: new Map<string, number>(),
    seller: new Map<string, number>(),
    productType: new Map<string, number>(),
  };

  const bump = (axis: keyof typeof counts, key: GroupKey): void => {
    if (!key) return;
    const map = counts[axis];
    map.set(key, (map.get(key) ?? 0) + 1);
  };

  const fits = (entry: GroupedItem<T>): boolean => {
    const checks: Array<[keyof typeof counts, GroupKey, number | undefined]> = [
      ["brand", entry.brand, budget.maxPerBrand],
      ["category", entry.category, budget.maxPerCategory],
      ["seller", entry.seller, budget.maxPerSeller],
      ["productType", entry.productType, budget.maxPerProductType],
    ];
    for (const [axis, key, max] of checks) {
      if (!key || max === undefined) continue;
      if ((counts[axis].get(key) ?? 0) >= max) return false;
    }
    return true;
  };

  const selected: GroupedItem<T>[] = [];
  const deferred: GroupedItem<T>[] = [];

  for (const entry of grouped) {
    if (selected.length >= limit) break;
    if (fits(entry)) {
      bump("brand", entry.brand);
      bump("category", entry.category);
      bump("seller", entry.seller);
      bump("productType", entry.productType);
      selected.push(entry);
    } else {
      deferred.push(entry);
    }
  }

  for (const entry of deferred) {
    if (selected.length >= limit) break;
    selected.push(entry);
  }

  return selected.slice(0, limit).map((entry) => entry.item);
}

/** Convenience wrapper for `RecommendationCandidate`. */
export function diversifyCandidates(
  ranked: readonly RecommendationCandidate[],
  type: RecommendationType,
  limit: number,
  budgetOverride?: Partial<DiversityBudget>,
): RecommendationCandidate[] {
  const budget = { ...(DIVERSITY_BUDGETS[type] ?? DEFAULT_DIVERSITY_BUDGET), ...budgetOverride };
  return applyDiversity(
    ranked,
    (candidate) => ({
      brand: candidate.brandId ?? candidate.brandName,
      category: candidate.categoryId ?? candidate.categoryPath,
      seller: candidate.sellerId,
      productType: null,
    }),
    budget,
    limit,
  );
}

/* ── Diagnostics ──────────────────────────────────────────────────────── */

/**
 * How varied a result set actually is.
 *
 * Reported as 0–1 (1 = every item in its own category). Exposed because
 * "is this rail too repetitive?" should be a measurement on the admin
 * dashboard rather than a judgement call made by looking at a screenshot.
 */
export function diversityRatio<T>(
  items: readonly T[],
  keyOf: (item: T) => GroupKey,
): number {
  if (items.length <= 1) return 1;
  const keys = items.map(keyOf).filter((key): key is string => Boolean(key));
  if (keys.length === 0) return 1;
  const distinct = new Set(keys).size;
  return Number((distinct / keys.length).toFixed(4));
}

/**
 * Coverage: what fraction of the catalog a rail can reach.
 *
 * The counterpart to relevance that is easy to forget. A recommender can be
 * perfectly relevant and still show 3% of the catalog forever, which is bad
 * for shoppers (no discovery) and worse for a marketplace (sellers outside the
 * popular set never get traffic).
 */
export function catalogCoverage(
  recommendedProductIds: Iterable<string>,
  totalCatalogSize: number,
): number {
  if (totalCatalogSize <= 0) return 0;
  const distinct = new Set(recommendedProductIds).size;
  return Number(Math.min(1, distinct / totalCatalogSize).toFixed(6));
}
