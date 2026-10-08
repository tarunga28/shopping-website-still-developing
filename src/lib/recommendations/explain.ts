/**
 * Recommendation explanations.
 *
 * Short, shopper-facing reasons. Two constraints shape every string here:
 *
 * 1. **No private profile data.** "Because you viewed gaming laptops" is fine;
 *    "because you are a 34-year-old in Bengaluru who bought three times" is
 *    not. The explanation names the *interest*, never the *evidence*.
 * 2. **No internal weights.** A score, a weight vector, or a component
 *    breakdown is meaningless to a shopper and useful to a competitor. The
 *    admin debugger gets the breakdown; the storefront gets a sentence.
 *
 * Explanations are derived from the dominant score component, so they cannot
 * drift from what actually drove the ranking. A hand-written explanation
 * attached to a slot would eventually describe a ranking that no longer
 * matches it.
 */

import type { RecommendationType, ScoreComponents } from "./types";

/** Copy templates per recommendation type. */
const TYPE_COPY: Readonly<Record<RecommendationType, string>> = {
  SIMILAR_PRODUCTS: "Similar to what you're viewing",
  RELATED_PRODUCTS: "You may also like",
  FREQUENTLY_BOUGHT_TOGETHER: "Frequently bought together",
  CUSTOMER_ALSO_BOUGHT: "Customers also bought",
  CUSTOMER_ALSO_VIEWED: "Customers also viewed",
  TRENDING_PRODUCTS: "Trending now",
  POPULAR_IN_CATEGORY: "Popular in {category}",
  RECENTLY_VIEWED: "Recently viewed",
  CONTINUE_SHOPPING: "Continue shopping",
  PERSONALIZED_FOR_YOU: "Recommended for you",
  CART_RECOMMENDATIONS: "Complete your setup",
  CHECKOUT_RECOMMENDATIONS: "Worth adding",
  POST_PURCHASE_RECOMMENDATIONS: "Recommended for your recent purchase",
  CROSS_SELL: "Goes well with this",
  UPSELL: "Worth the upgrade",
  NEW_USER_RECOMMENDATIONS: "Popular right now",
  ANONYMOUS_RECOMMENDATIONS: "You may also like",
};

export function headingForType(
  type: RecommendationType,
  context: { categoryName?: string | null } = {},
): string {
  const template = TYPE_COPY[type];
  if (context.categoryName && template.includes("{category}")) {
    return template.replace("{category}", context.categoryName);
  }
  return template.replace(/\s*in \{category\}/, "");
}

/**
 * Why this item, derived from its dominant score component.
 *
 * Returns null when there is nothing honest to say — for a cold-start rail with
 * no user signal, inventing a personalized reason would be a small lie, and the
 * ones that get noticed are the ones that cost trust.
 */
export function explainItem(
  input: {
    type: RecommendationType;
    components: ScoreComponents;
    dominant: keyof ScoreComponents;
    /** Whether the request had enough signal to personalize at all. */
    personalized: boolean;
    categoryName?: string | null;
    brandName?: string | null;
    /** True when the item came from a co-purchase relationship. */
    fromCoPurchase?: boolean;
    /** True when the item is a genuine step up from the seed. */
    isUpsell?: boolean;
  },
): string | null {
  // Slot-level reasons that override the component-based one, because they are
  // more specific and more truthful.
  if (input.fromCoPurchase && input.type !== "SIMILAR_PRODUCTS") {
    return "Customers bought this together";
  }
  if (input.isUpsell) return "A step up from what you're viewing";

  switch (input.dominant) {
    case "userInterest":
      if (!input.personalized) return null;
      if (input.categoryName) return `Because you've shown interest in ${input.categoryName}`;
      return "Based on your recent activity";
    case "similarity":
      return "Similar to what you're viewing";
    case "purchaseAffinity":
      return "Often bought with items like this";
    case "popularity":
      if (input.categoryName) return `Popular in ${input.categoryName}`;
      return "Popular with other shoppers";
    case "freshness":
      return "New arrival";
    case "quality":
      return "Highly rated by shoppers";
    case "context":
      if (input.brandName) return `More from ${input.brandName}`;
      return "Related to what you're viewing";
    case "relevance":
      return input.categoryName ? `Popular in ${input.categoryName}` : "Popular with other shoppers";
    default:
      return null;
  }
}

/**
 * Which named signals shaped the result, for the response envelope.
 *
 * These go over the wire, so they are deliberately coarse: category names and
 * signal kinds, never weights, never user ids, never the raw profile.
 */
export function describeSourceSignals(input: {
  type: RecommendationType;
  personalized: boolean;
  usedCoPurchase: boolean;
  usedSimilarity: boolean;
  usedPopularity: boolean;
  usedTrending: boolean;
  usedCart: boolean;
  categoryName?: string | null;
}): string[] {
  const signals: string[] = [];
  if (input.personalized) signals.push("your recent activity");
  if (input.usedCart) signals.push("your cart");
  if (input.usedSimilarity) signals.push("product similarity");
  if (input.usedCoPurchase) signals.push("frequently bought together");
  if (input.usedTrending) signals.push("trending");
  if (input.usedPopularity) signals.push("popularity");
  if (input.categoryName) signals.push(input.categoryName);
  if (signals.length === 0) signals.push("catalogue defaults");
  return signals;
}

/**
 * The `sourceSignals` field is a display affordance, not a debugging channel.
 * Cap it so a malformed internal state cannot turn a product card footer into
 * a paragraph.
 */
export const MAX_SOURCE_SIGNALS = 4;

export function trimSourceSignals(signals: readonly string[]): string[] {
  return [...new Set(signals)].slice(0, MAX_SOURCE_SIGNALS);
}
