/**
 * Pricing engine (pure).
 *
 * A price is never "just a column". `products.basePrice` / the variant price is
 * the LIST price; every discount is a row in `product_price_rules` and is
 * applied here through a fixed pipeline:
 *
 *     original
 *        ↓  AUTOMATIC   (always-on rules: clearance, member pricing)
 *        ↓  CAMPAIGN    (site-wide promotions)
 *        ↓  SELLER      (marketplace seller-specific pricing)
 *        ↓  SCHEDULED   (time-boxed offers)
 *        ↓  COUPON      (hook — the coupon engine lands in a later part)
 *        ↓  final
 *
 * Why a pipeline instead of one `salePrice` column:
 *   • the original price is always recoverable, so "was ₹2,499" is honest;
 *   • a campaign ends by date, with no data migration and no stale sale prices;
 *   • the arithmetic is auditable — every step is returned to the caller.
 *
 * MONEY RULES
 *   All amounts are integer minor units (paise). Percentages are basis points
 *   (10000 = 100.00%) so there is no float anywhere in this file. Rounding is
 *   half-up, applied once per step, and the result is clamped so a price can
 *   never go negative no matter what an operator types into a rule.
 */

export const PRICE_RULE_TYPES = ["AUTOMATIC", "CAMPAIGN", "SELLER", "SCHEDULED"] as const;
export type PriceRuleType = (typeof PRICE_RULE_TYPES)[number];

export const DISCOUNT_TYPES = ["PERCENTAGE", "FIXED_AMOUNT"] as const;
export type DiscountType = (typeof DISCOUNT_TYPES)[number];

/** Pipeline order. Coupon is deliberately last and outside the rule table. */
export const PIPELINE_ORDER: readonly PriceRuleType[] = ["AUTOMATIC", "CAMPAIGN", "SELLER", "SCHEDULED"];

export const BASIS_POINTS_DENOMINATOR = 10_000;

export interface PriceRule {
  id?: string;
  ruleType: PriceRuleType;
  discountType: DiscountType;
  /** PERCENTAGE → basis points (2500 = 25%). FIXED_AMOUNT → paise. */
  discountValue: number;
  /** Caps a percentage discount, in paise. */
  maxDiscountPaise?: number | null;
  priority: number;
  stackable: boolean;
  name?: string;
  sellerId?: string | null;
  startsAt?: Date | string | null;
  endsAt?: Date | string | null;
  isActive: boolean;
}

export interface CouponInput {
  code: string;
  discountType: DiscountType;
  /** PERCENTAGE → basis points. FIXED_AMOUNT → paise. */
  value: number;
  maxDiscountPaise?: number | null;
  minimumOrderPaise?: number | null;
}

export interface PriceStep {
  stage: PriceRuleType | "COUPON";
  label: string;
  /** Amount removed at this step, in paise. Always >= 0. */
  discountPaise: number;
  priceAfterPaise: number;
}

export interface PriceQuote {
  originalPaise: number;
  finalPaise: number;
  discountPaise: number;
  /** Integer percent (0–100), null when nothing is discounted. */
  discountPercent: number | null;
  /** Price before the pipeline, when a compare-at price exists and is higher. */
  compareAtPaise: number | null;
  taxBasisPoints: number;
  taxPaise: number;
  totalWithTaxPaise: number;
  steps: PriceStep[];
  couponApplied: boolean;
  /** True when a rule was ignored because its window is closed. */
  hasExpiredRules: boolean;
}

export interface PriceContext {
  now?: Date;
  /** Marketplace seller viewing/buying; SELLER rules only apply to this id. */
  sellerId?: string | null;
  coupon?: CouponInput | null;
}

/* ── Primitive maths ─────────────────────────────────────────────────── */

/** Half-up rounding on an exact integer division — no float intermediate. */
export function roundHalfUp(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return 0;
  const sign = numerator < 0 ? -1 : 1;
  const absolute = Math.abs(numerator);
  return sign * Math.floor((absolute * 2 + denominator) / (denominator * 2));
}

export function discountFromBasisPoints(amountPaise: number, basisPoints: number): number {
  if (!Number.isInteger(basisPoints) || basisPoints < 0) return 0;
  return roundHalfUp(amountPaise * basisPoints, BASIS_POINTS_DENOMINATOR);
}

export function taxFromBasisPoints(amountPaise: number, taxBasisPoints: number): number {
  if (!Number.isInteger(taxBasisPoints) || taxBasisPoints < 0 || taxBasisPoints > BASIS_POINTS_DENOMINATOR) {
    return 0;
  }
  return discountFromBasisPoints(amountPaise, taxBasisPoints);
}

/** Integer percent, half-up, clamped to 0–100. */
export function percentOff(originalPaise: number, finalPaise: number): number | null {
  if (!Number.isInteger(originalPaise) || !Number.isInteger(finalPaise)) return null;
  if (originalPaise <= 0 || finalPaise >= originalPaise) return null;
  const percent = roundHalfUp((originalPaise - finalPaise) * 100, originalPaise);
  return Math.max(0, Math.min(100, percent));
}

/* ── Rule eligibility ────────────────────────────────────────────────── */

function toTime(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

export interface RuleEligibility {
  eligible: boolean;
  /** Why not — surfaced in the admin UI so a dead campaign is diagnosable. */
  reason?: string;
}

/**
 * Is this rule live for this request?
 *
 * A rule is skipped when: it is inactive, its window has not opened, its window
 * has closed, or it is a SELLER rule for a different seller.
 */
export function ruleEligibility(rule: PriceRule, context: PriceContext): RuleEligibility {
  if (!rule.isActive) return { eligible: false, reason: "Rule is switched off." };

  const now = (context.now ?? new Date()).getTime();
  const startsAt = toTime(rule.startsAt);
  const endsAt = toTime(rule.endsAt);
  if (startsAt !== null && now < startsAt) return { eligible: false, reason: "Rule has not started yet." };
  if (endsAt !== null && now >= endsAt) return { eligible: false, reason: "Rule has ended." };

  if (rule.ruleType === "SELLER") {
    const ruleSeller = rule.sellerId ?? null;
    const viewer = context.sellerId ?? null;
    if (ruleSeller && ruleSeller !== viewer) {
      return { eligible: false, reason: "Seller-specific rule for another seller." };
    }
  }
  return { eligible: true };
}

/** Is the rule structurally valid? Kept separate so validation errors are loud. */
export function assertValidRule(rule: PriceRule): void {
  if (!PRICE_RULE_TYPES.includes(rule.ruleType)) throw new Error("Unknown discount rule type.");
  if (!DISCOUNT_TYPES.includes(rule.discountType)) throw new Error("Unknown discount type.");
  if (!Number.isInteger(rule.discountValue) || rule.discountValue < 0) {
    throw new Error("Discount value must be a non-negative integer.");
  }
  if (rule.discountType === "PERCENTAGE" && rule.discountValue > BASIS_POINTS_DENOMINATOR) {
    throw new Error("A percentage discount cannot exceed 100%.");
  }
  if (rule.discountType === "FIXED_AMOUNT" && !Number.isSafeInteger(rule.discountValue)) {
    throw new Error("Fixed discount is too large.");
  }
  if (rule.maxDiscountPaise != null && (!Number.isInteger(rule.maxDiscountPaise) || rule.maxDiscountPaise < 0)) {
    throw new Error("Maximum discount must be a non-negative integer number of paise.");
  }
  const startsAt = toTime(rule.startsAt);
  const endsAt = toTime(rule.endsAt);
  if (startsAt !== null && endsAt !== null && endsAt <= startsAt) {
    throw new Error("The discount must end after it starts.");
  }
}

/* ── The pipeline ────────────────────────────────────────────────────── */

function applyRule(pricePaise: number, rule: PriceRule): number {
  let discount =
    rule.discountType === "PERCENTAGE"
      ? discountFromBasisPoints(pricePaise, rule.discountValue)
      : Math.min(rule.discountValue, pricePaise);
  if (rule.maxDiscountPaise != null) discount = Math.min(discount, rule.maxDiscountPaise);
  // Clamp: a malformed rule can never produce a negative price.
  discount = Math.max(0, Math.min(discount, pricePaise));
  return pricePaise - discount;
}

/**
 * Run the full pricing pipeline.
 *
 * Rules are applied in stage order, then by ascending `priority` within a
 * stage. A non-stackable rule ends its stage — later rules of the same stage
 * are ignored — so "25% off, not combinable" behaves the way the label says.
 *
 * Returns the quote including every step, so the UI can show a breakdown and a
 * test can assert on the arithmetic rather than only the final number.
 */
export function quotePrice(
  originalPaise: number,
  rules: readonly PriceRule[],
  options: {
    compareAtPaise?: number | null;
    taxBasisPoints?: number;
    context?: PriceContext;
  } = {},
): PriceQuote {
  if (!Number.isInteger(originalPaise) || originalPaise < 0) {
    throw new Error("Original price must be a non-negative integer number of paise.");
  }
  const context = options.context ?? {};
  const taxBasisPoints = options.taxBasisPoints ?? 0;

  const steps: PriceStep[] = [];
  let price = originalPaise;
  let hasExpiredRules = false;

  for (const stage of PIPELINE_ORDER) {
    const stageRules = rules
      .filter((rule) => rule.ruleType === stage)
      .sort((a, b) => a.priority - b.priority || (a.id ?? "").localeCompare(b.id ?? ""));

    let stageEnded = false;
    for (const rule of stageRules) {
      const eligibility = ruleEligibility(rule, context);
      if (!eligibility.eligible) {
        if (eligibility.reason === "Rule has ended." || eligibility.reason === "Rule has not started yet.") {
          hasExpiredRules = true;
        }
        continue;
      }
      if (stageEnded) continue;

      const before = price;
      const after = applyRule(before, rule);
      if (after < before) {
        steps.push({
          stage,
          label: rule.name?.trim() || stage,
          discountPaise: before - after,
          priceAfterPaise: after,
        });
        price = after;
      }
      if (!rule.stackable) stageEnded = true;
    }
  }

  let couponApplied = false;
  const coupon = context.coupon;
  if (coupon && price > 0) {
    const minimum = coupon.minimumOrderPaise ?? null;
    if (minimum === null || originalPaise >= minimum) {
      const pseudoRule: PriceRule = {
        ruleType: "AUTOMATIC",
        discountType: coupon.discountType,
        discountValue: coupon.value,
        maxDiscountPaise: coupon.maxDiscountPaise ?? null,
        priority: 0,
        stackable: true,
        name: coupon.code,
        isActive: true,
      };
      const before = price;
      const after = applyRule(before, pseudoRule);
      if (after < before) {
        steps.push({
          stage: "COUPON",
          label: coupon.code,
          discountPaise: before - after,
          priceAfterPaise: after,
        });
        price = after;
        couponApplied = true;
      }
    }
  }

  const compareAtPaise =
    options.compareAtPaise != null && options.compareAtPaise > originalPaise ? options.compareAtPaise : null;
  const taxPaise = taxFromBasisPoints(price, taxBasisPoints);

  return {
    originalPaise,
    finalPaise: price,
    discountPaise: originalPaise - price,
    discountPercent: percentOff(originalPaise, price),
    compareAtPaise,
    taxBasisPoints,
    taxPaise,
    totalWithTaxPaise: price + taxPaise,
    steps,
    couponApplied,
    hasExpiredRules,
  };
}

/**
 * The price a checkout must charge.
 *
 * The client-supplied price is recorded only so tampering is detectable — it is
 * never used as the amount. Callers pass the server-computed quote.
 */
export function authoritativePrice(input: {
  serverPaise: number;
  clientPaise?: number | null;
}): { pricePaise: number; mismatch: boolean } {
  if (!Number.isInteger(input.serverPaise) || input.serverPaise < 0) {
    throw new Error("Server price is invalid.");
  }
  return {
    pricePaise: input.serverPaise,
    mismatch: input.clientPaise != null && input.clientPaise !== input.serverPaise,
  };
}

/** Gross margin in paise, or null when the inputs are incomplete. */
export function grossMarginPaise(input: {
  sellingPaise: number;
  costPaise: number | null;
  shippingPaise?: number | null;
  paymentFeePaise?: number | null;
}): number | null {
  if (input.costPaise === null) return null;
  if (!Number.isInteger(input.sellingPaise) || input.sellingPaise < 0) return null;
  if (!Number.isInteger(input.costPaise) || input.costPaise < 0) return null;
  const shipping = input.shippingPaise ?? 0;
  const fee = input.paymentFeePaise ?? 0;
  return input.sellingPaise - input.costPaise - shipping - fee;
}

/** Margin as basis points of the selling price (2500 = 25%). Null when unknown. */
export function marginBasisPoints(input: {
  sellingPaise: number;
  costPaise: number | null;
  shippingPaise?: number | null;
  paymentFeePaise?: number | null;
}): number | null {
  const margin = grossMarginPaise(input);
  if (margin === null || input.sellingPaise <= 0) return null;
  return roundHalfUp(margin * BASIS_POINTS_DENOMINATOR, input.sellingPaise);
}
