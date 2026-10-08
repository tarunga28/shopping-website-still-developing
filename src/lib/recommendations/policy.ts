/**
 * Exclusion and business rules.
 *
 * One centralized layer, applied after ranking and before results are returned.
 *
 * Keeping this out of the ranking formula is not a style preference. A rule
 * buried inside a score is a rule that can be outvoted: give an out-of-stock
 * product a large enough relevance score and it wins, and the shopper gets a
 * card they cannot buy. A filter cannot be outvoted. The same applies to
 * restricted categories — "scored too well to hide" is exactly the failure §57
 * warns about.
 *
 * Every rule returns a reason, so the admin debugger can say why an item was
 * dropped rather than leaving a merchandiser to guess.
 */

import type { RecommendationCandidate, RecommendationType } from "./types";

export const EXCLUSION_REASONS = [
  "NOT_PURCHASABLE",
  "OUT_OF_STOCK",
  "ALREADY_IN_CART",
  "ALREADY_PURCHASED",
  "ALREADY_SHOWN",
  "SELF_REFERENCE",
  "DUPLICATE_VARIANT",
  "RESTRICTED_CATEGORY",
  "AGE_RESTRICTED",
  "REGION_RESTRICTED",
  "PRICE_OUT_OF_RANGE",
  "LOW_QUALITY",
  "NOT_INTERESTED",
] as const;

export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

export interface ExclusionOutcome<T> {
  kept: T[];
  /** Product id -> why it was dropped. First failing rule wins. */
  excluded: Map<string, ExclusionReason>;
}

export interface ExclusionPolicy {
  /** Require at least one purchasable, in-stock variant. */
  requireInStock: boolean;
  /** Drop items already in the basket. */
  excludeInCart: boolean;
  /** Drop items the shopper has already bought. */
  excludePurchased: boolean;
  /** Drop items already present in the rendered result set. */
  excludeAlreadyShown: boolean;
  /** Never recommend the seed product back to itself. */
  excludeSelf: boolean;
  /** Collapse near-duplicate listings down to one. */
  collapseDuplicateVariants: boolean;
  /** Category ids that must never be recommended. */
  restrictedCategoryIds: readonly string[];
  /** Category ids requiring an age gate. */
  ageRestrictedCategoryIds: readonly string[];
  /** Whether the current request has satisfied the age gate. */
  ageGateSatisfied: boolean;
  /** Products the shopper explicitly rejected. */
  notInterestedProductIds: readonly string[];
  /** Hard price ceiling for the slot, in minor units. */
  maxPricePaise: number | null;
}

export const DEFAULT_EXCLUSION_POLICY: ExclusionPolicy = {
  requireInStock: true,
  excludeInCart: true,
  excludePurchased: false,
  excludeAlreadyShown: true,
  excludeSelf: true,
  collapseDuplicateVariants: true,
  restrictedCategoryIds: [],
  ageRestrictedCategoryIds: [],
  ageGateSatisfied: false,
  notInterestedProductIds: [],
  maxPricePaise: null,
};

/**
 * Per-type policy.
 *
 * The interesting variations:
 *
 *   CART — must exclude what is already in the basket, or the rail recommends
 *          the item the shopper is looking at buying.
 *   POST_PURCHASE — excludes what was just bought, but *not* the rest of the
 *          order history: someone who buys coffee every month is a good
 *          audience for coffee, and suppressing all past purchases would hide
 *          exactly the replenishment case §33 asks us to prepare for.
 *   RECENTLY_VIEWED — does *not* exclude already-shown, because the whole
 *          point of the slot is to re-surface what was seen.
 *   CHECKOUT — the strictest stock requirement, since a dead-end at checkout
 *          costs more than anywhere else.
 */
export const TYPE_EXCLUSION_OVERRIDES: Partial<Record<RecommendationType, Partial<ExclusionPolicy>>> = {
  CART_RECOMMENDATIONS: { excludeInCart: true, excludePurchased: false, requireInStock: true },
  CHECKOUT_RECOMMENDATIONS: {
    excludeInCart: true,
    requireInStock: true,
    collapseDuplicateVariants: true,
  },
  POST_PURCHASE_RECOMMENDATIONS: { excludePurchased: true, excludeInCart: true },
  RECENTLY_VIEWED: { excludeAlreadyShown: false, excludePurchased: false },
  CONTINUE_SHOPPING: { excludeAlreadyShown: false, excludePurchased: true },
  UPSELL: { excludeInCart: true, requireInStock: true },
  CROSS_SELL: { excludeInCart: true, requireInStock: true },
  // Cold-start slots have no history to exclude against.
  NEW_USER_RECOMMENDATIONS: { excludePurchased: false, excludeAlreadyShown: false },
  ANONYMOUS_RECOMMENDATIONS: { excludePurchased: false },
};

export function exclusionPolicyFor(type: RecommendationType): ExclusionPolicy {
  return { ...DEFAULT_EXCLUSION_POLICY, ...(TYPE_EXCLUSION_OVERRIDES[type] ?? {}) };
}

export interface ExclusionInput {
  type: RecommendationType;
  policy?: Partial<ExclusionPolicy>;
  seedProductId?: string | null;
  cartProductIds?: readonly string[];
  purchasedProductIds?: readonly string[];
  alreadyShownProductIds?: readonly string[];
  notInterestedProductIds?: readonly string[];
  /** Age gate satisfied for this request, e.g. a verified date of birth. */
  ageGateSatisfied?: boolean;
  maxPricePaise?: number | null;
}

/**
 * Apply every rule, recording why each dropped item was dropped.
 *
 * Rules run most-specific first so the reported reason is the informative one:
 * "restricted category" tells a merchandiser more than "out of stock" about a
 * product that is both.
 */
export function applyExclusions(
  candidates: readonly RecommendationCandidate[],
  input: ExclusionInput,
): ExclusionOutcome<RecommendationCandidate> {
  const policy: ExclusionPolicy = {
    ...exclusionPolicyFor(input.type),
    ...input.policy,
    restrictedCategoryIds: input.policy?.restrictedCategoryIds ?? [],
    ageRestrictedCategoryIds: input.policy?.ageRestrictedCategoryIds ?? [],
    notInterestedProductIds: input.notInterestedProductIds ?? [],
    ageGateSatisfied: input.ageGateSatisfied ?? false,
    maxPricePaise: input.maxPricePaise ?? null,
  };

  const cart = new Set(input.cartProductIds ?? []);
  const purchased = new Set(input.purchasedProductIds ?? []);
  const shown = new Set(input.alreadyShownProductIds ?? []);
  const rejected = new Set(policy.notInterestedProductIds);
  const restricted = new Set(policy.restrictedCategoryIds);
  const ageRestricted = new Set(policy.ageRestrictedCategoryIds);

  const kept: RecommendationCandidate[] = [];
  const excluded = new Map<string, ExclusionReason>();
  /** First-seen listing per (category, brand, normalized name) signature. */
  const seenSignatures = new Set<string>();

  for (const candidate of candidates) {
    const reason = firstExclusion(candidate, {
      policy,
      seedProductId: input.seedProductId ?? null,
      cart,
      purchased,
      shown,
      rejected,
      restricted,
      ageRestricted,
      seenSignatures,
    });
    if (reason) {
      excluded.set(candidate.productId, reason);
      continue;
    }
    if (policy.collapseDuplicateVariants) {
      seenSignatures.add(duplicateSignature(candidate));
    }
    kept.push(candidate);
  }

  return { kept, excluded };
}

interface RuleContext {
  policy: ExclusionPolicy;
  seedProductId: string | null;
  cart: ReadonlySet<string>;
  purchased: ReadonlySet<string>;
  shown: ReadonlySet<string>;
  rejected: ReadonlySet<string>;
  restricted: ReadonlySet<string>;
  ageRestricted: ReadonlySet<string>;
  seenSignatures: ReadonlySet<string>;
}

function firstExclusion(
  candidate: RecommendationCandidate,
  ctx: RuleContext,
): ExclusionReason | null {
  // Hard policy rules first: these are never a matter of ranking.
  if (candidate.categoryId && ctx.restricted.has(candidate.categoryId)) {
    return "RESTRICTED_CATEGORY";
  }
  if (
    candidate.categoryId &&
    ctx.ageRestricted.has(candidate.categoryId) &&
    !ctx.policy.ageGateSatisfied
  ) {
    return "AGE_RESTRICTED";
  }
  if (ctx.rejected.has(candidate.productId)) return "NOT_INTERESTED";

  // Self-reference: recommending a product on its own page.
  if (ctx.policy.excludeSelf && ctx.seedProductId && candidate.productId === ctx.seedProductId) {
    return "SELF_REFERENCE";
  }

  if (!candidate.slug || !candidate.name) return "NOT_PURCHASABLE";

  if (ctx.policy.requireInStock && !candidate.inStock) return "OUT_OF_STOCK";

  if (ctx.policy.excludeInCart && ctx.cart.has(candidate.productId)) return "ALREADY_IN_CART";
  if (ctx.policy.excludePurchased && ctx.purchased.has(candidate.productId)) {
    return "ALREADY_PURCHASED";
  }
  if (ctx.policy.excludeAlreadyShown && ctx.shown.has(candidate.productId)) return "ALREADY_SHOWN";

  if (
    ctx.policy.maxPricePaise !== null &&
    candidate.pricePaise > ctx.policy.maxPricePaise
  ) {
    return "PRICE_OUT_OF_RANGE";
  }

  // Two listings of the same thing from different sellers are one decision,
  // not two slots.
  if (ctx.policy.collapseDuplicateVariants) {
    const signature = duplicateSignature(candidate);
    if (ctx.seenSignatures.has(signature)) return "DUPLICATE_VARIANT";
  }

  return null;
}

/**
 * Signature identifying "the same product listed twice".
 *
 * Category + brand + a normalized name, so a black t-shirt in S and the same
 * shirt in M collapse, while two genuinely different shirts do not.
 */
export function duplicateSignature(candidate: RecommendationCandidate): string {
  const name = candidate.name
    .toLowerCase()
    // Strip size/colour words — they are the usual difference between two
    // listings of one product.
    .replace(/\b(xs|s|m|l|xl|xxl|small|medium|large)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return `${candidate.categoryId ?? ""}|${candidate.brandId ?? candidate.brandName ?? ""}|${name}`;
}

/* ── Seller fairness (§56) ────────────────────────────────────────────── */

/**
 * Cap how much of a rail one seller can occupy.
 *
 * In a multi-vendor marketplace an unbounded relevance ranking concentrates
 * traffic on whichever sellers already have the most data, which is a
 * self-reinforcing loop: more traffic → more signals → higher rank. Capping is
 * the counterweight.
 *
 * The cap is a ceiling, not a quota. It never promotes a less relevant item
 * above a more relevant one from a different seller — it only defers the
 * excess, and deferred items still fill the rail if nothing better exists.
 * Relevance is not sacrificed for balance; it is only prevented from
 * monopolising.
 */
export function capSellerShare<T>(
  ranked: readonly T[],
  sellerOf: (item: T) => string | null,
  options: { limit: number; maxShare?: number },
): T[] {
  if (options.limit <= 0) return [];
  const maxShare = Math.min(0.6, Math.max(0.1, options.maxShare ?? 0.4));
  const maxPerSeller = Math.max(1, Math.floor(options.limit * maxShare));

  const counts = new Map<string, number>();
  const selected: T[] = [];
  const deferred: T[] = [];

  for (const item of ranked) {
    if (selected.length >= options.limit) break;
    const seller = sellerOf(item);
    if (!seller) {
      selected.push(item);
      continue;
    }
    const seen = counts.get(seller) ?? 0;
    if (seen < maxPerSeller) {
      counts.set(seller, seen + 1);
      selected.push(item);
    } else {
      deferred.push(item);
    }
  }

  for (const item of deferred) {
    if (selected.length >= options.limit) break;
    selected.push(item);
  }
  return selected.slice(0, options.limit);
}

/* ── Upsell gating (§29) ──────────────────────────────────────────────── */

/**
 * Is this a legitimate upsell of the seed?
 *
 * A premium product is not an upsell merely for being more expensive — that is
 * just showing something dearer. Two things must both hold:
 *
 *   1. It is actually comparable (a real substitute, not a different category).
 *   2. The extra money buys a meaningful step up, within a sane multiplier.
 *
 * The ceiling on the multiplier matters as much as the floor. Recommending a
 * ₹3,00,000 machine to someone looking at a ₹25,000 one is not upselling, it
 * is ignoring what they told you.
 */
export function isViableUpsell(
  seed: { pricePaise: number; categoryId: string | null },
  candidate: { pricePaise: number; categoryId: string | null; ratingAverage: number | null },
  options: { minUpliftRatio?: number; maxUpliftRatio?: number; minSimilarity?: number; similarity?: number } = {},
): boolean {
  const minUplift = options.minUpliftRatio ?? 1.1;
  const maxUplift = options.maxUpliftRatio ?? 1.8;
  const minSimilarity = options.minSimilarity ?? 0.45;

  if (seed.pricePaise <= 0 || candidate.pricePaise <= 0) return false;

  // Must be a substitute, or this is a cross-sell wearing an upsell label.
  if (seed.categoryId && candidate.categoryId && seed.categoryId !== candidate.categoryId) {
    return false;
  }
  if ((options.similarity ?? 1) < minSimilarity) return false;

  const ratio = candidate.pricePaise / seed.pricePaise;
  if (ratio < minUplift || ratio > maxUplift) return false;

  // Do not upsell into a worse-reviewed product; a dearer item that customers
  // rate lower is a worse purchase, not an upgrade.
  if (seed.pricePaise > 0 && candidate.ratingAverage !== null && candidate.ratingAverage < 3.5) {
    return false;
  }
  return true;
}
