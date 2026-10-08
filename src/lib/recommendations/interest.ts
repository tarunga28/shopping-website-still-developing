/**
 * User interest scoring.
 *
 * Turns a stream of behavioural signals into a normalized interest profile.
 *
 * Two decisions matter here:
 *
 * 1. **Sub-linear accumulation.** Ten views are not ten times the interest of
 *    one view — they are maybe twice. Without a logarithm, a shopper who
 *    reloaded a product page in a loop would dominate their own profile, and
 *    the recommender would collapse into "show them that one thing again".
 *
 * 2. **Normalization within a dimension.** Weights are scaled to 0–1 against
 *    the strongest signal in that dimension. Otherwise a shopper with 200
 *    signals would systematically outscore one with 5, and every downstream
 *    weight would need to compensate for how *active* the user is rather than
 *    how *interested* they are.
 */

import type { InterestDimension, InterestProfile, InterestSignal } from "./types";
import { decaySignal, type DecayConfig, type DecayMethod, DEFAULT_DECAY } from "./decay";

/**
 * Base weight per event type.
 *
 * Purchase is worth far more than a view, but not infinitely more: a shopper
 * who views forty running shoes and buys one has told you something about
 * running shoes that the single purchase alone does not capture.
 */
export const EVENT_WEIGHTS: Readonly<Record<string, number>> = {
  PURCHASE: 10,
  RETURN: -4,
  ADD_TO_CART: 4,
  WISHLIST_ADD: 3.5,
  WISHLIST_REMOVE: -1.5,
  REMOVE_FROM_CART: -1.5,
  SEARCH_RESULT_CLICK: 1.6,
  PRODUCT_CLICK: 1.4,
  PRODUCT_VIEW: 1,
  CATEGORY_VIEW: 0.8,
  BRAND_VIEW: 0.8,
  FILTER_USED: 0.6,
  COMPARE: 1.2,
  SHARE: 1.1,
  SEARCH: 0.5,
  // Explicit rejection. Strong, but see `applyNegativeSignals` — one abandoned
  // view must not suppress a product forever.
  NOT_INTERESTED: -6,
};

/** Sub-linear accumulation exponent. 1 would be linear, 0 would ignore repeats. */
export const ACCUMULATION_EXPONENT = 0.6;

export interface InterestOptions {
  decay?: DecayConfig;
  method?: DecayMethod;
  now?: Date;
  /** Cap on a single dimension's contribution, so no axis can dominate. */
  maxSignalsPerDimension?: number;
}

/**
 * Accumulate signals into raw per-key weights, applying decay as it goes.
 *
 * Negative totals are clamped to zero at the end: a shopper who bought
 * something and returned it ends up neutral, not actively hostile, because
 * the return may have been about fit or delivery rather than the product.
 */
export function accumulateSignals(
  signals: readonly InterestSignal[],
  options: InterestOptions = {},
): Record<string, number> {
  const now = options.now ?? new Date();
  const decay = options.decay ?? DEFAULT_DECAY;
  const method = options.method ?? "EXPONENTIAL";
  const totals = new Map<string, number>();

  for (const signal of signals) {
    if (!signal.key) continue;
    const decayed = decaySignal(signal.weight, signal.occurredAt, now, decay, method);
    // A negative weight still needs to decay, so magnitude decays and the sign
    // is restored — an old grievance fades just like an old preference.
    const signed = signal.weight < 0 ? -Math.abs(decayed) : decayed;
    totals.set(signal.key, (totals.get(signal.key) ?? 0) + signed);
  }

  for (const [key, value] of totals) {
    totals.set(key, value < 0 ? 0 : value);
  }
  return Object.fromEntries(totals);
}

/**
 * Apply sub-linear accumulation to a repeat count.
 *
 * `Math.pow(count, 0.6)` means the 2nd view adds ~0.5, the 10th ~0.25, the
 * 100th ~0.06 — diminishing, but never quite zero, so sustained interest still
 * accumulates.
 */
export function accumulateRepeats(count: number, exponent = ACCUMULATION_EXPONENT): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.pow(count, exponent);
}

/**
 * Normalize raw weights to 0–1 against the largest.
 *
 * Returns an empty object for an empty or all-zero input rather than dividing
 * by zero, which is also the correct semantic: no signal, no preference.
 */
export function normalizeWeights(raw: Record<string, number>): Record<string, number> {
  const entries = Object.entries(raw).filter(([, value]) => Number.isFinite(value) && value > 0);
  if (entries.length === 0) return {};
  const max = entries.reduce((best, [, value]) => Math.max(best, value), 0);
  if (max <= 0) return {};
  const normalized: Record<string, number> = {};
  for (const [key, value] of entries) {
    normalized[key] = Number((value / max).toFixed(4));
  }
  return normalized;
}

/**
 * Build a full interest profile from grouped signals.
 *
 * Signals arrive grouped by dimension because the same key can legitimately
 * appear in more than one — a brand name is both a BRAND key and, if it is
 * also a product word, an ATTRIBUTE key.
 */
export function buildInterestProfile(
  byDimension: Partial<Record<InterestDimension, readonly InterestSignal[]>>,
  options: InterestOptions = {},
): InterestProfile {
  const profile: InterestProfile = {};
  for (const [dimension, signals] of Object.entries(byDimension)) {
    if (!signals || signals.length === 0) continue;
    const raw = accumulateSignals(signals, options);
    const normalized = normalizeWeights(raw);
    if (Object.keys(normalized).length > 0) {
      profile[dimension as InterestDimension] = normalized;
    }
  }
  return profile;
}

/**
 * How much evidence backs a profile, 0–1.
 *
 * This is the gate on personalization. A profile built from one product view
 * should not drive a "recommended for you" rail — the honest answer for that
 * shopper is the trending list, and pretending otherwise produces the
 * confidently-wrong recommendations that make people distrust a storefront.
 *
 * Confidence saturates well below 1: no amount of history makes a profile
 * certain, and leaving headroom keeps the value comparable across users.
 */
export function profileConfidence(
  profile: InterestProfile,
  options: { saturationSignals?: number } = {},
): number {
  const saturation = options.saturationSignals ?? 25;
  const distinctKeys = Object.values(profile).reduce(
    (total, dimension) => total + Object.keys(dimension ?? {}).length,
    0,
  );
  if (distinctKeys === 0) return 0;
  // Diminishing returns: 5 signals ≈ 0.45, 25 ≈ 0.79, 100 ≈ 0.93.
  const raw = distinctKeys / (distinctKeys + saturation);
  return Number(Math.min(raw, 0.98).toFixed(4));
}

/**
 * Weighted look-up of a candidate against a profile.
 *
 * Category and brand are weighted explicitly rather than averaged with the
 * rest, because a category match is a much stronger statement of intent than a
 * shared attribute.
 */
export const DIMENSION_WEIGHTS: Readonly<Record<InterestDimension, number>> = {
  CATEGORY: 1.0,
  BRAND: 0.7,
  PRODUCT_TYPE: 0.5,
  ATTRIBUTE: 0.45,
  PRICE_BAND: 0.35,
  PRODUCT: 0.3,
};

export function scoreInterest(
  profile: InterestProfile,
  match: Partial<Record<InterestDimension, string | null | undefined>>,
): number {
  let total = 0;
  let maxTotal = 0;
  for (const [dimension, dimensionWeight] of Object.entries(DIMENSION_WEIGHTS) as Array<
    [InterestDimension, number]
  >) {
    maxTotal += dimensionWeight;
    const key = match[dimension];
    if (!key) continue;
    const weight = profile[dimension]?.[key];
    if (typeof weight === "number" && weight > 0) {
      total += dimensionWeight * weight;
    }
  }
  return maxTotal > 0 ? total / maxTotal : 0;
}

/* ── Price preference ─────────────────────────────────────────────────── */

export interface PriceObservation {
  categoryId: string | null;
  pricePaise: number;
  /** Purchases count for more than views when estimating a budget. */
  weight?: number;
}

/**
 * Estimate a preferred price band per category.
 *
 * Category-aware on purpose. A shopper who buys ₹400 socks and ₹90,000 laptops
 * has no single "preferred price"; recommending ₹90,000 socks or ₹400 laptops
 * are both failures, and only a per-category band avoids them.
 *
 * The band is a weighted percentile range rather than mean ± sd, because
 * prices are right-skewed — one expensive purchase would drag a mean-based band
 * far above what the shopper actually buys.
 */
export function estimatePricePreference(
  observations: readonly PriceObservation[],
  options: { lowPercentile?: number; highPercentile?: number } = {},
): Record<string, { minPaise: number; maxPaise: number }> {
  const low = options.lowPercentile ?? 0.2;
  const high = options.highPercentile ?? 0.9;
  const byCategory = new Map<string, Array<{ price: number; weight: number }>>();

  for (const observation of observations) {
    if (!Number.isFinite(observation.pricePaise) || observation.pricePaise <= 0) continue;
    const key = observation.categoryId ?? "__global__";
    const list = byCategory.get(key) ?? [];
    list.push({ price: observation.pricePaise, weight: observation.weight ?? 1 });
    byCategory.set(key, list);
  }

  const result: Record<string, { minPaise: number; maxPaise: number }> = {};
  for (const [key, list] of byCategory) {
    if (list.length === 0) continue;
    const sorted = [...list].sort((a, b) => a.price - b.price);
    // Weighted percentile: expand by weight so three purchases outweigh one view.
    const expanded: number[] = [];
    for (const entry of sorted) {
      const repeats = Math.max(1, Math.round(entry.weight));
      for (let i = 0; i < repeats; i += 1) expanded.push(entry.price);
    }
    const pick = (percentile: number): number => {
      const index = Math.min(expanded.length - 1, Math.max(0, Math.floor(percentile * (expanded.length - 1))));
      return expanded[index]!;
    };
    result[key] = { minPaise: pick(low), maxPaise: pick(high) };
  }
  return result;
}

/**
 * Is a price inside the shopper's band for this category?
 *
 * Returns 1 inside the band, and decays smoothly outside it rather than
 * dropping to zero. A hard cutoff would exclude a genuinely good product just
 * over the line, and §27 only asks that we stop *repeatedly* recommending
 * things far outside the band.
 *
 * A missing band means no opinion — returns a neutral 1, letting other signals
 * decide.
 */
export function priceAffinity(
  pricePaise: number,
  band: { minPaise: number; maxPaise: number } | undefined,
): number {
  if (!band) return 1;
  if (!Number.isFinite(pricePaise) || pricePaise <= 0) return 0;
  const { minPaise, maxPaise } = band;
  if (maxPaise <= minPaise) return pricePaise === minPaise ? 1 : 0.5;
  if (pricePaise >= minPaise && pricePaise <= maxPaise) return 1;

  const span = Math.max(maxPaise - minPaise, 1);
  if (pricePaise < minPaise) {
    // Under-spending is penalised more gently: a cheaper option is a plausible
    // suggestion, an order of magnitude dearer one usually is not.
    const ratio = (minPaise - pricePaise) / span;
    return Math.max(0, 1 - ratio * 0.6);
  }
  const ratio = (pricePaise - maxPaise) / span;
  return Math.max(0, 1 - ratio);
}
