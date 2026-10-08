import { describe, expect, it } from "vitest";

import { DEFAULT_DECAY, decaySignal, describeAge, exponentialDecay, linearDecay } from "@/lib/recommendations/decay";
import {
  accumulateSignals,
  buildInterestProfile,
  estimatePricePreference,
  normalizeWeights,
  priceAffinity,
  profileConfidence,
  scoreInterest,
} from "@/lib/recommendations/interest";
import {
  attributeSimilarity,
  categorySimilarity,
  computeSimilarity,
  priceSimilarity,
  rankSimilar,
  similarityProfileFor,
  weightedAttributeSimilarity,
} from "@/lib/recommendations/similarity";
import {
  computeCoPurchaseMetrics,
  rankAlsoBought,
  rankCoPurchases,
} from "@/lib/recommendations/cooccurrence";
import {
  coldStartScore,
  conversionRate,
  diversifyByScope,
  popularityScore,
  trendingScore,
} from "@/lib/recommendations/popularity";
import {
  applyExploration,
  assertWeightBalance,
  DEFAULT_RANKING_WEIGHTS,
  discountDepth,
  dominantComponent,
  freshnessScore,
  qualityScore,
  scoreCandidate,
  sortByScore,
  weightsForType,
} from "@/lib/recommendations/ranking";
import { applyDiversity, catalogCoverage, diversifyCandidates, diversityRatio } from "@/lib/recommendations/diversity";
import {
  applyExclusions,
  capSellerShare,
  duplicateSignature,
  exclusionPolicyFor,
  isViableUpsell,
} from "@/lib/recommendations/policy";
import {
  averagePrecisionAtK,
  coverage,
  intraListDiversity,
  mapAtK,
  ndcgAtK,
  novelty,
  precisionAtK,
  recallAtK,
  recommendationBusinessMetrics,
} from "@/lib/recommendations/evaluate";
import { explainItem, headingForType, trimSourceSignals } from "@/lib/recommendations/explain";
import { resolveRecommendationType } from "@/lib/recommendations/types";
import type { RecommendationCandidate } from "@/lib/recommendations/types";

/* ── Fixtures ─────────────────────────────────────────────────────────── */

const NOW = new Date("2026-06-01T12:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

function candidate(overrides: Partial<RecommendationCandidate> = {}): RecommendationCandidate {
  return {
    productId: "p1",
    slug: "product-one",
    name: "Product One",
    brandId: "b1",
    brandName: "Brand One",
    categoryId: "c1",
    categoryPath: "/root/c1",
    sellerId: "s1",
    pricePaise: 100_000,
    compareAtPaise: null,
    ratingAverage: 4.5,
    ratingCount: 120,
    inStock: true,
    stockQuantity: 10,
    publishedAt: daysAgo(10).toISOString(),
    isNew: false,
    sources: {},
    ...overrides,
  };
}

/* ── Time decay ───────────────────────────────────────────────────────── */

describe("time decay", () => {
  it("gives full weight to a signal happening now", () => {
    expect(exponentialDecay(0)).toBe(1);
  });

  it("halves at exactly one half-life", () => {
    const halfLifeMs = DEFAULT_DECAY.halfLifeDays * 86_400_000;
    expect(exponentialDecay(halfLifeMs)).toBeCloseTo(0.5, 5);
  });

  it("quarters at two half-lives", () => {
    const twoHalfLives = DEFAULT_DECAY.halfLifeDays * 86_400_000 * 2;
    expect(exponentialDecay(twoHalfLives)).toBeCloseTo(0.25, 5);
  });

  it("decays a recent view far less than a six-month-old one", () => {
    const recent = decaySignal(1, daysAgo(1), NOW);
    const old = decaySignal(1, daysAgo(180), NOW);
    expect(recent).toBeGreaterThan(old * 10);
  });

  it("clamps a future timestamp to full weight rather than exceeding it", () => {
    // Clock skew between app server and database must not produce weight > 1.
    expect(exponentialDecay(-5000)).toBe(1);
  });

  it("drops signals below the floor to exactly zero", () => {
    expect(exponentialDecay(400 * 86_400_000)).toBe(0);
  });

  it("reaches zero at the end of a linear window", () => {
    expect(linearDecay(10 * 86_400_000, 10)).toBe(0);
    expect(linearDecay(5 * 86_400_000, 10)).toBeCloseTo(0.5, 5);
  });

  it("ignores a zero weight but preserves a negative one", () => {
    expect(decaySignal(0, daysAgo(1), NOW)).toBe(0);
    // A negative weight must survive: dropping it is what made RETURN and
    // NOT_INTERESTED no-ops, which defeated negative signalling entirely.
    expect(decaySignal(-5, daysAgo(1), NOW)).toBeLessThan(0);
  });

  it("fades a negative signal on the same curve as a positive one", () => {
    // An old grievance should not outlast an old preference.
    const freshNegative = decaySignal(-5, daysAgo(1), NOW);
    const oldNegative = decaySignal(-5, daysAgo(180), NOW);
    expect(Math.abs(freshNegative)).toBeGreaterThan(Math.abs(oldNegative));
  });

  it("describes age in the largest sensible unit", () => {
    expect(describeAge(30_000)).toBe("just now");
    expect(describeAge(5 * 60_000)).toBe("5 minutes");
    expect(describeAge(3 * 3_600_000)).toBe("3 hours");
    expect(describeAge(2 * 86_400_000)).toBe("2 days");
  });
});

/* ── Interest scoring ─────────────────────────────────────────────────── */

describe("interest scoring", () => {
  it("accumulates weighted signals by key", () => {
    const totals = accumulateSignals(
      [
        { dimension: "BRAND", key: "nike", weight: 1, occurredAt: NOW },
        { dimension: "BRAND", key: "nike", weight: 1, occurredAt: NOW },
        { dimension: "BRAND", key: "adidas", weight: 1, occurredAt: NOW },
      ],
      { now: NOW },
    );
    expect(totals.nike).toBeGreaterThan(totals.adidas!);
  });

  it("clamps a negative total to zero rather than going hostile", () => {
    // Bought then returned should end neutral, not actively negative.
    const totals = accumulateSignals(
      [
        { dimension: "PRODUCT", key: "p1", weight: 1, occurredAt: NOW },
        { dimension: "PRODUCT", key: "p1", weight: -4, occurredAt: NOW },
      ],
      { now: NOW },
    );
    expect(totals.p1).toBe(0);
  });

  it("normalizes to 0–1 against the strongest signal", () => {
    const normalized = normalizeWeights({ a: 10, b: 5, c: 0 });
    expect(normalized.a).toBe(1);
    expect(normalized.b).toBe(0.5);
    expect(normalized.c).toBeUndefined();
  });

  it("returns an empty profile for all-zero input rather than dividing by zero", () => {
    expect(normalizeWeights({ a: 0, b: 0 })).toEqual({});
  });

  it("builds a profile grouped by dimension", () => {
    const profile = buildInterestProfile(
      {
        BRAND: [
          { dimension: "BRAND", key: "nike", weight: 3, occurredAt: NOW },
          { dimension: "BRAND", key: "adidas", weight: 1, occurredAt: NOW },
        ],
      },
      { now: NOW },
    );
    expect(profile.BRAND?.nike).toBe(1);
    expect(profile.BRAND?.adidas).toBeLessThan(1);
  });

  it("gives low confidence to a profile built from one signal", () => {
    const profile = buildInterestProfile(
      { CATEGORY: [{ dimension: "CATEGORY", key: "c1", weight: 1, occurredAt: NOW }] },
      { now: NOW },
    );
    expect(profileConfidence(profile)).toBeLessThan(0.2);
  });

  it("saturates confidence below 1 no matter how much history exists", () => {
    const many = Object.fromEntries(
      Array.from({ length: 500 }, (_, index) => [`k${index}`, 1]),
    );
    expect(profileConfidence({ BRAND: many })).toBeLessThan(1);
  });

  it("scores a category match above an attribute match", () => {
    const profile = {
      CATEGORY: { c1: 1 },
      ATTRIBUTE: { color: 1 },
    };
    const categoryOnly = scoreInterest(profile, { CATEGORY: "c1" });
    const attributeOnly = scoreInterest(profile, { ATTRIBUTE: "color" });
    expect(categoryOnly).toBeGreaterThan(attributeOnly);
  });

  it("estimates a price band per category rather than globally", () => {
    const bands = estimatePricePreference([
      { categoryId: "socks", pricePaise: 40_000, weight: 3 },
      { categoryId: "laptops", pricePaise: 9_000_000, weight: 3 },
    ]);
    expect(bands.socks!.maxPaise).toBeLessThan(bands.laptops!.minPaise);
  });

  it("treats a price inside the band as full affinity", () => {
    expect(priceAffinity(50_000, { minPaise: 40_000, maxPaise: 80_000 })).toBe(1);
  });

  it("penalizes over-spending harder than under-spending", () => {
    const band = { minPaise: 100_000, maxPaise: 200_000 };
    const cheaper = priceAffinity(50_000, band);
    const dearer = priceAffinity(400_000, band);
    expect(cheaper).toBeGreaterThan(dearer);
  });

  it("returns neutral affinity when no band is known", () => {
    expect(priceAffinity(9_999_999, undefined)).toBe(1);
  });
});

/* ── Similarity ───────────────────────────────────────────────────────── */

describe("product similarity", () => {
  it("scores an exact category match as 1", () => {
    expect(categorySimilarity({ categoryId: "c1" }, { categoryId: "c1" })).toBe(1);
  });

  it("scores siblings under a shared parent below an exact match", () => {
    const siblings = categorySimilarity(
      { categoryPath: "/root/electronics/phones" },
      { categoryPath: "/root/electronics/laptops" },
    );
    expect(siblings).toBeGreaterThan(0);
    expect(siblings).toBeLessThan(1);
  });

  it("scores an unrelated category as 0", () => {
    expect(categorySimilarity({ categoryPath: "/a/b" }, { categoryPath: "/x/y" })).toBe(0);
  });

  it("uses Jaccard so a heavily-specified product does not win by volume", () => {
    const sparse = attributeSimilarity(["black"], ["black"]);
    const verbose = attributeSimilarity(
      ["black", "a", "b", "c", "d", "e", "f", "g"],
      ["black", "h", "i", "j", "k", "l", "m", "n"],
    );
    expect(sparse).toBe(1);
    expect(verbose).toBeLessThan(sparse);
  });

  it("skips axes only one product specifies rather than counting them as disagreement", () => {
    const withMissing = weightedAttributeSimilarity({ ram: "16gb" }, { ram: "16gb", cpu: "m3" });
    expect(withMissing).toBe(1);
  });

  it("respects per-axis importance", () => {
    const agreeing = weightedAttributeSimilarity({ ram: "16gb", color: "black" }, { ram: "16gb", color: "white" }, { ram: 10, color: 1 });
    const disagreeing = weightedAttributeSimilarity({ ram: "8gb", color: "black" }, { ram: "16gb", color: "black" }, { ram: 10, color: 1 });
    expect(agreeing).toBeGreaterThan(disagreeing);
  });

  it("treats a relative price gap as closer than the same absolute gap at the top", () => {
    const cheap = priceSimilarity(100_000, 120_000);
    const dear = priceSimilarity(9_000_000, 9_020_000);
    expect(dear).toBeGreaterThan(cheap);
  });

  it("selects the electronics profile for laptops", () => {
    const profile = similarityProfileFor({ categoryPath: "/electronics/laptops", attributeAxes: ["ram", "cpu"] });
    expect(profile.name).toBe("electronics");
    expect(profile.attributes).toBeGreaterThan(profile.brand);
  });

  it("selects the apparel profile for clothing", () => {
    const profile = similarityProfileFor({ categoryPath: "/fashion/t-shirt", attributeAxes: ["size", "color"] });
    expect(profile.name).toBe("apparel");
  });

  it("falls back to the default profile otherwise", () => {
    expect(similarityProfileFor({}).name).toBe("default");
  });

  it("returns a score in [0,1] and a per-signal breakdown", () => {
    const breakdown = computeSimilarity(
      { categoryId: "c1", brandId: "b1", pricePaise: 100_000, attributes: ["black"] },
      { categoryId: "c1", brandId: "b1", pricePaise: 110_000, attributes: ["black"] },
    );
    expect(breakdown.score).toBeGreaterThan(0);
    expect(breakdown.score).toBeLessThanOrEqual(1);
    expect(breakdown.parts.category).toBeGreaterThan(0);
    expect(breakdown.parts.brand).toBeGreaterThan(0);
  });

  it("ranks the most similar first and excludes the seed", () => {
    const seed = { productId: "seed", categoryId: "c1", brandId: "b1", pricePaise: 100_000 };
    const pool = [
      { productId: "seed", categoryId: "c1", brandId: "b1", pricePaise: 100_000 },
      { productId: "close", categoryId: "c1", brandId: "b1", pricePaise: 105_000 },
      { productId: "far", categoryId: "other", brandId: "other", pricePaise: 900_000 },
    ];
    const ranked = rankSimilar(seed, pool, undefined, { exclude: ["seed"] });
    expect(ranked[0]!.item.productId).toBe("close");
    expect(ranked.every((entry) => entry.item.productId !== "seed")).toBe(true);
  });
});

/* ── Co-purchase ──────────────────────────────────────────────────────── */

describe("co-purchase association", () => {
  it("computes support, confidence and lift", () => {
    const metrics = computeCoPurchaseMetrics({
      productId: "a",
      coProductId: "b",
      pairOrders: 20,
      productOrders: 100,
      coProductOrders: 50,
      totalOrders: 1000,
    });
    expect(metrics.support).toBeCloseTo(0.02, 5);
    expect(metrics.confidence).toBeCloseTo(0.2, 5);
    // lift = confidence / P(B) = 0.2 / 0.05 = 4
    expect(metrics.lift).toBeCloseTo(4, 5);
    expect(metrics.significant).toBe(true);
  });

  it("gives a universally-bought companion a lift near 1, not a high rank", () => {
    // Everyone buys toilet paper: high confidence everywhere, but no association.
    const metrics = computeCoPurchaseMetrics({
      productId: "laptop",
      coProductId: "staple",
      pairOrders: 500,
      productOrders: 600,
      coProductOrders: 900,
      totalOrders: 1000,
    });
    expect(metrics.confidence).toBeGreaterThan(0.8);
    expect(metrics.lift).toBeLessThan(1.05);
    expect(metrics.significant).toBe(false);
  });

  it("returns zeros rather than throwing on a degenerate denominator", () => {
    const metrics = computeCoPurchaseMetrics({
      productId: "a",
      coProductId: "b",
      pairOrders: 0,
      productOrders: 0,
      coProductOrders: 0,
      totalOrders: 0,
    });
    expect(metrics).toMatchObject({ support: 0, confidence: 0, lift: 0, significant: false });
  });

  it("rejects a pair seen together only once as coincidence", () => {
    const metrics = computeCoPurchaseMetrics({
      productId: "a",
      coProductId: "b",
      pairOrders: 1,
      productOrders: 2,
      coProductOrders: 2,
      totalOrders: 100_000,
    });
    expect(metrics.significant).toBe(false);
  });

  it("ranks by lift so a popular companion does not crowd out an associated one", () => {
    const pairs = [
      { productId: "a", coProductId: "popular", pairOrders: 300, productOrders: 1000, coProductOrders: 8000, totalOrders: 10_000 },
      { productId: "a", coProductId: "associated", pairOrders: 120, productOrders: 1000, coProductOrders: 200, totalOrders: 10_000 },
    ];
    const ranked = rankCoPurchases("a", pairs, { limit: 2, minSupport: 0, minPairOrders: 1, minLift: 1 });
    expect(ranked[0]!.coProductId).toBe("associated");
  });

  it("excludes the seed and anything explicitly excluded", () => {
    const pairs = [
      { productId: "a", coProductId: "a", pairOrders: 50, productOrders: 100, coProductOrders: 100, totalOrders: 1000 },
      { productId: "a", coProductId: "incart", pairOrders: 50, productOrders: 100, coProductOrders: 100, totalOrders: 1000 },
    ];
    const ranked = rankCoPurchases("a", pairs, { limit: 5, minSupport: 0, minPairOrders: 1, minLift: 1, exclude: ["incart"] });
    expect(ranked).toHaveLength(0);
  });

  it("requires stock for also-bought but not for the raw association", () => {
    const pairs = [
      { productId: "a", coProductId: "oos", pairOrders: 120, productOrders: 1000, coProductOrders: 200, totalOrders: 10_000, inStock: false },
      { productId: "a", coProductId: "instock", pairOrders: 100, productOrders: 1000, coProductOrders: 200, totalOrders: 10_000, inStock: true },
    ];
    const ranked = rankAlsoBought(pairs, { limit: 5 });
    expect(ranked.map((entry) => entry.coProductId)).toEqual(["instock"]);
  });
});

/* ── Popularity and trending ──────────────────────────────────────────── */

describe("popularity and trending", () => {
  it("weights a purchase above the same number of views", () => {
    // Equal counts, so this isolates the weighting rather than the volume.
    // (25 views would tie exactly with 1 purchase at these weights — 25 x 1 ==
    // 1 x 25 — which is a property of the weights, not a bug.)
    const viewed = popularityScore({ viewCount: 10, addToCartCount: 0, wishlistCount: 0, purchaseCount: 0, revenuePaise: 0 });
    const bought = popularityScore({ viewCount: 0, addToCartCount: 0, wishlistCount: 0, purchaseCount: 10, revenuePaise: 0 });
    expect(bought).toBeGreaterThan(viewed);
  });

  it("orders the behaviours purchase > add-to-cart > wishlist > view", () => {
    const score = (overrides: Partial<Parameters<typeof popularityScore>[0]>) =>
      popularityScore({
        viewCount: 0, addToCartCount: 0, wishlistCount: 0, purchaseCount: 0, revenuePaise: 0,
        ...overrides,
      });
    const one = { viewCount: 1, addToCartCount: 1, wishlistCount: 1, purchaseCount: 1 };
    expect(score({ purchaseCount: one.purchaseCount })).toBeGreaterThan(score({ addToCartCount: one.addToCartCount }));
    expect(score({ addToCartCount: one.addToCartCount })).toBeGreaterThan(score({ wishlistCount: one.wishlistCount }));
    expect(score({ wishlistCount: one.wishlistCount })).toBeGreaterThan(score({ viewCount: one.viewCount }));
  });

  it("is log-scaled so a huge count does not swamp everything else", () => {
    const small = popularityScore({ viewCount: 100, addToCartCount: 0, wishlistCount: 0, purchaseCount: 0, revenuePaise: 0 });
    const huge = popularityScore({ viewCount: 1_000_000, addToCartCount: 0, wishlistCount: 0, purchaseCount: 0, revenuePaise: 0 });
    expect(huge / small).toBeLessThan(10);
  });

  it("guards a zero-view denominator", () => {
    expect(conversionRate({ viewCount: 0, addToCartCount: 0, wishlistCount: 0, purchaseCount: 5, revenuePaise: 0 })).toBe(0);
  });

  it("detects a spike against the product's own baseline", () => {
    const trending = trendingScore({
      recent: { viewCount: 800, addToCartCount: 0, wishlistCount: 0, purchaseCount: 0, revenuePaise: 0 },
      baseline: { viewCount: 600, addToCartCount: 0, wishlistCount: 0, purchaseCount: 0, revenuePaise: 0 },
      baselineDays: 30,
      recentDays: 1,
    });
    expect(trending).toBeGreaterThan(0);
  });

  it("does not call a flat product trending", () => {
    const flat = trendingScore({
      recent: { viewCount: 20, addToCartCount: 0, wishlistCount: 0, purchaseCount: 0, revenuePaise: 0 },
      baseline: { viewCount: 600, addToCartCount: 0, wishlistCount: 0, purchaseCount: 0, revenuePaise: 0 },
      baselineDays: 30,
      recentDays: 1,
    });
    expect(flat).toBe(0);
  });

  it("does not call a doubling of two views a trend", () => {
    // Smoothing exists exactly for this: 1 historical view, 2 today.
    const noise = trendingScore({
      recent: { viewCount: 2, addToCartCount: 0, wishlistCount: 0, purchaseCount: 0, revenuePaise: 0 },
      baseline: { viewCount: 1, addToCartCount: 0, wishlistCount: 0, purchaseCount: 0, revenuePaise: 0 },
      baselineDays: 30,
      recentDays: 1,
    });
    expect(noise).toBe(0);
  });

  it("gives an out-of-stock new product no cold-start exposure", () => {
    expect(coldStartScore({ ageDays: 0, ratingAverage: 5, ratingCount: 100, inStock: false })).toBe(0);
  });

  it("caps the newness boost so new products cannot dominate", () => {
    const fresh = coldStartScore({ ageDays: 0, ratingAverage: 4.5, ratingCount: 50, inStock: true });
    expect(fresh).toBeLessThan(1);
  });

  it("caps how much of a rail one category can occupy when alternatives exist", () => {
    // Four categories with plenty of each, so the cap can actually bind.
    const items = Array.from({ length: 20 }, (_, index) => ({ id: index, cat: `cat-${index % 4}` }));
    const balanced = diversifyByScope(items, (item) => item.cat, { limit: 8, maxPerKey: 2 });
    expect(balanced).toHaveLength(8);
    expect(balanced.filter((item) => item.cat === "cat-0")).toHaveLength(2);
  });

  it("fills from deferred items rather than returning a short rail", () => {
    // Only two categories exist, so six slots cannot honour a cap of two. A
    // slightly repetitive rail beats a half-empty one — the cap is a
    // preference, not a hard requirement.
    const items = Array.from({ length: 10 }, (_, index) => ({ id: index, cat: index < 8 ? "one" : "two" }));
    const balanced = diversifyByScope(items, (item) => item.cat, { limit: 6, maxPerKey: 2 });
    expect(balanced).toHaveLength(6);
  });

  it("measures catalog coverage", () => {
    expect(catalogCoverage(["a", "a", "b"], 10)).toBeCloseTo(0.2, 5);
    expect(catalogCoverage([], 0)).toBe(0);
  });
});

/* ── Ranking ──────────────────────────────────────────────────────────── */

describe("ranking", () => {
  it("keeps soft signals below contextual ones in the default weights", () => {
    expect(() => assertWeightBalance(DEFAULT_RANKING_WEIGHTS)).not.toThrow();
  });

  it("rejects a weight set that would make every rail a bestseller list", () => {
    expect(() =>
      assertWeightBalance({ ...DEFAULT_RANKING_WEIGHTS, popularity: 500, quality: 500, freshness: 500 }),
    ).toThrow(/bestseller/);
  });

  it("rejects a negative or non-finite weight", () => {
    expect(() => assertWeightBalance({ ...DEFAULT_RANKING_WEIGHTS, relevance: -1 })).toThrow();
    expect(() => assertWeightBalance({ ...DEFAULT_RANKING_WEIGHTS, relevance: Number.NaN })).toThrow();
  });

  it("keeps every per-type override balanced", () => {
    const types = [
      "SIMILAR_PRODUCTS", "CROSS_SELL", "UPSELL", "TRENDING_PRODUCTS",
      "PERSONALIZED_FOR_YOU", "NEW_USER_RECOMMENDATIONS", "CHECKOUT_RECOMMENDATIONS",
    ] as const;
    for (const type of types) {
      expect(() => assertWeightBalance(weightsForType(type)), `${type} is unbalanced`).not.toThrow();
    }
  });

  it("weights cross-sell toward purchase affinity, not similarity", () => {
    const crossSell = weightsForType("CROSS_SELL");
    expect(crossSell.purchaseAffinity).toBeGreaterThan(crossSell.similarity);
  });

  it("weights similarity toward similarity", () => {
    const similar = weightsForType("SIMILAR_PRODUCTS");
    expect(similar.similarity).toBeGreaterThan(similar.purchaseAffinity);
  });

  it("discounts a rating backed by few reviews", () => {
    const oneReview = qualityScore(5, 1);
    const manyReviews = qualityScore(4.6, 400);
    expect(manyReviews).toBeGreaterThan(oneReview);
  });

  it("gives a neutral quality score to an unrated product rather than zero", () => {
    expect(qualityScore(null, 0)).toBeGreaterThan(0);
  });

  it("decays freshness to zero past the window", () => {
    expect(freshnessScore(daysAgo(200).toISOString(), NOW, 90)).toBe(0);
    expect(freshnessScore(daysAgo(0).toISOString(), NOW, 90)).toBe(1);
  });

  it("computes discount depth and bounds it", () => {
    expect(discountDepth(75_000, 100_000)).toBeCloseTo(0.25, 5);
    expect(discountDepth(100_000, 100_000)).toBe(0);
    expect(discountDepth(1, 100_000)).toBeLessThanOrEqual(0.9);
  });

  it("names the dominant component so explanations are principled", () => {
    const scored = scoreCandidate({
      type: "SIMILAR_PRODUCTS",
      candidate: candidate(),
      similarity: 0.9,
    });
    expect(scored.dominant).toBe("similarity");
    expect(scored.components.similarity).toBeGreaterThan(0);
  });

  it("penalizes an out-of-stock candidate below an in-stock one", () => {
    const inStock = scoreCandidate({ type: "POPULAR_IN_CATEGORY", candidate: candidate({ productId: "a" }) });
    const outOfStock = scoreCandidate({
      type: "POPULAR_IN_CATEGORY",
      candidate: candidate({ productId: "b", inStock: false }),
    });
    expect(inStock.score).toBeGreaterThan(outOfStock.score);
  });

  it("never lets the seed product score against itself", () => {
    const scored = scoreCandidate({
      type: "SIMILAR_PRODUCTS",
      candidate: candidate({ productId: "seed" }),
      context: { productId: "seed", categoryId: "c1" },
    });
    expect(scored.components.context).toBe(0);
  });

  it("clamps out-of-range component inputs instead of producing NaN", () => {
    const scored = scoreCandidate({
      type: "PERSONALIZED_FOR_YOU",
      candidate: candidate(),
      userInterest: Number.POSITIVE_INFINITY,
      similarity: -5,
    });
    expect(Number.isFinite(scored.score)).toBe(true);
  });

  it("sorts deterministically so A/B results are interpretable", () => {
    const a = scoreCandidate({ type: "POPULAR_IN_CATEGORY", candidate: candidate({ productId: "a", ratingAverage: 4.0 }) });
    const b = scoreCandidate({ type: "POPULAR_IN_CATEGORY", candidate: candidate({ productId: "b", ratingAverage: 4.8 }) });
    const first = sortByScore([a, b]);
    const second = sortByScore([b, a]);
    expect(first.map((entry) => entry.candidate.productId)).toEqual(second.map((entry) => entry.candidate.productId));
  });

  it("explores only in the back half of the list", () => {
    const items = Array.from({ length: 10 }, (_, index) =>
      scoreCandidate({ type: "PERSONALIZED_FOR_YOU", candidate: candidate({ productId: `p${index}` }) }),
    );
    const explored = applyExploration(items, { probability: 1, limit: 10, random: () => 0.99 });
    // Position 1 must never move: a shuffling headline looks like a bug.
    expect(explored[0]!.candidate.productId).toBe("p0");
  });

  it("returns the list unchanged when exploration probability is zero", () => {
    const items = Array.from({ length: 5 }, (_, index) =>
      scoreCandidate({ type: "POPULAR_IN_CATEGORY", candidate: candidate({ productId: `p${index}` }) }),
    );
    const explored = applyExploration(items, { probability: 0, limit: 5 });
    expect(explored.map((entry) => entry.candidate.productId)).toEqual(items.map((entry) => entry.candidate.productId));
  });

  it("identifies the dominant component as the largest positive contributor", () => {
    const components = {
      relevance: 10, userInterest: 40, similarity: 5, popularity: 20, quality: 10,
      freshness: 0, purchaseAffinity: 0, context: 0,
      duplicationPenalty: 0, outOfStockPenalty: 0, stalePenalty: 0,
    };
    expect(dominantComponent(components)).toBe("userInterest");
  });
});

/* ── Diversity ────────────────────────────────────────────────────────── */

describe("diversity", () => {
  const pool = Array.from({ length: 12 }, (_, index) =>
    candidate({
      productId: `p${index}`,
      brandId: index < 9 ? "same-brand" : `brand-${index}`,
      categoryId: "c1",
      sellerId: index < 9 ? "same-seller" : `seller-${index}`,
    }),
  );

  it("caps how many items share a brand", () => {
    const result = applyDiversity(
      pool,
      (item) => ({ brand: item.brandId, category: null, seller: null, productType: null }),
      { maxPerBrand: 2, maxPerCategory: 100, maxPerSeller: 100 },
      6,
    );
    expect(result.filter((item) => item.brandId === "same-brand").length).toBeLessThanOrEqual(4);
  });

  it("exempts items with no value for an axis rather than bucketing them together", () => {
    const unbranded = Array.from({ length: 5 }, (_, index) =>
      candidate({ productId: `u${index}`, brandId: null, brandName: null }),
    );
    const result = applyDiversity(
      unbranded,
      (item) => ({ brand: item.brandId, category: null, seller: null, productType: null }),
      { maxPerBrand: 1, maxPerCategory: 100, maxPerSeller: 100 },
      5,
    );
    // Every unbranded product must survive; treating null as one bucket would
    // collapse five distinct products into one.
    expect(result).toHaveLength(5);
  });

  it("fills remaining slots from deferred items rather than returning a short rail", () => {
    const result = applyDiversity(
      pool,
      (item) => ({ brand: item.brandId, category: item.categoryId, seller: item.sellerId, productType: null }),
      { maxPerBrand: 1, maxPerCategory: 1, maxPerSeller: 1 },
      6,
    );
    expect(result).toHaveLength(6);
  });

  it("returns nothing for a non-positive limit", () => {
    expect(applyDiversity(pool, () => ({ brand: null, category: null, seller: null, productType: null }), { maxPerBrand: 1, maxPerCategory: 1, maxPerSeller: 1 }, 0)).toHaveLength(0);
  });

  it("measures intra-list diversity", () => {
    expect(intraListDiversity(["a", "a", "a"])).toBe(0);
    expect(intraListDiversity(["a", "b", "c"])).toBe(1);
  });
});

/* ── Exclusions ───────────────────────────────────────────────────────── */

describe("exclusions", () => {
  it("drops an out-of-stock product when the slot requires stock", () => {
    const { kept, excluded } = applyExclusions(
      [candidate({ productId: "oos", inStock: false })],
      { type: "CART_RECOMMENDATIONS", seedProductId: "seed" },
    );
    expect(kept).toHaveLength(0);
    expect(excluded.get("oos")).toBe("OUT_OF_STOCK");
  });

  it("never recommends the seed product back to itself", () => {
    const { excluded } = applyExclusions([candidate({ productId: "seed" })], {
      type: "SIMILAR_PRODUCTS",
      seedProductId: "seed",
    });
    expect(excluded.get("seed")).toBe("SELF_REFERENCE");
  });

  it("excludes what is already in the basket", () => {
    const { excluded } = applyExclusions([candidate({ productId: "p1" })], {
      type: "CART_RECOMMENDATIONS",
      cartProductIds: ["p1"],
      seedProductId: "seed",
    });
    expect(excluded.get("p1")).toBe("ALREADY_IN_CART");
  });

  it("does not exclude already-shown items in the recently-viewed slot", () => {
    const policy = exclusionPolicyFor("RECENTLY_VIEWED");
    expect(policy.excludeAlreadyShown).toBe(false);
    const { kept } = applyExclusions([candidate({ productId: "p1" })], {
      type: "RECENTLY_VIEWED",
      alreadyShownProductIds: ["p1"],
    });
    expect(kept).toHaveLength(1);
  });

  it("drops a restricted category no matter how well it scores", () => {
    const { excluded } = applyExclusions([candidate({ productId: "p1", categoryId: "restricted" })], {
      type: "PERSONALIZED_FOR_YOU",
      policy: { restrictedCategoryIds: ["restricted"] },
    });
    expect(excluded.get("p1")).toBe("RESTRICTED_CATEGORY");
  });

  it("gates an age-restricted category until the gate is satisfied", () => {
    const gated = applyExclusions([candidate({ productId: "p1", categoryId: "adult" })], {
      type: "POPULAR_IN_CATEGORY",
      policy: { ageRestrictedCategoryIds: ["adult"] },
      ageGateSatisfied: false,
    });
    expect(gated.excluded.get("p1")).toBe("AGE_RESTRICTED");

    const cleared = applyExclusions([candidate({ productId: "p1", categoryId: "adult" })], {
      type: "POPULAR_IN_CATEGORY",
      policy: { ageRestrictedCategoryIds: ["adult"] },
      ageGateSatisfied: true,
    });
    expect(cleared.kept).toHaveLength(1);
  });

  it("honours an explicit not-interested action", () => {
    const { excluded } = applyExclusions([candidate({ productId: "p1" })], {
      type: "PERSONALIZED_FOR_YOU",
      notInterestedProductIds: ["p1"],
    });
    expect(excluded.get("p1")).toBe("NOT_INTERESTED");
  });

  it("collapses two listings of the same product but not genuinely different ones", () => {
    const listings = [
      candidate({ productId: "a", name: "Cotton T-Shirt Black M", categoryId: "c1", brandId: "b1" }),
      candidate({ productId: "b", name: "Cotton T-Shirt Black L", categoryId: "c1", brandId: "b1" }),
      candidate({ productId: "c", name: "Denim Jeans", categoryId: "c1", brandId: "b1" }),
    ];
    const { kept, excluded } = applyExclusions(listings, { type: "POPULAR_IN_CATEGORY" });
    expect(kept.map((item) => item.productId)).toEqual(["a", "c"]);
    expect(excluded.get("b")).toBe("DUPLICATE_VARIANT");
  });

  it("produces a signature that ignores size words", () => {
    const small = duplicateSignature(candidate({ name: "Cotton T-Shirt Small" }));
    const large = duplicateSignature(candidate({ name: "Cotton T-Shirt Large" }));
    expect(small).toBe(large);
  });

  it("caps one seller's share when enough other sellers exist", () => {
    // A dominant seller listed first, plus four distinct others — so a 40% cap
    // on six slots (max 2 each) can actually bind and still fill the rail.
    const items = [
      ...Array.from({ length: 8 }, (_, index) => ({ id: index, seller: "dominant" })),
      ...Array.from({ length: 4 }, (_, index) => ({ id: 100 + index, seller: `other-${index}` })),
    ];
    const capped = capSellerShare(items, (item) => item.seller, { limit: 6, maxShare: 0.4 });
    expect(capped).toHaveLength(6);
    expect(capped.filter((item) => item.seller === "dominant")).toHaveLength(2);
    // The dominant seller's excess is deferred, not discarded: the other slots
    // are filled by the sellers that were under the cap.
    expect(capped.filter((item) => item.seller.startsWith("other-"))).toHaveLength(4);
  });

  it("fills from the deferred seller rather than returning a short rail", () => {
    // One dominant seller and only two others: six slots cannot be filled
    // without exceeding the cap, and a short rail is the worse outcome.
    const items = Array.from({ length: 8 }, (_, index) => ({
      id: index,
      seller: index < 6 ? "dominant" : `other-${index}`,
    }));
    const capped = capSellerShare(items, (item) => item.seller, { limit: 6, maxShare: 0.4 });
    expect(capped).toHaveLength(6);
  });

  it("never promotes a less relevant item above a more relevant one for balance", () => {
    const items = [
      { id: "top", seller: "dominant" },
      { id: "second", seller: "dominant" },
      { id: "other", seller: "other" },
    ];
    const capped = capSellerShare(items, (item) => item.seller, { limit: 3, maxShare: 0.4 });
    expect(capped[0]!.id).toBe("top");
  });
});

/* ── Upsell gating ────────────────────────────────────────────────────── */

describe("upsell gating", () => {
  const seed = { pricePaise: 2_500_000, categoryId: "laptops" };

  it("accepts a genuine step up in the same category", () => {
    expect(
      isViableUpsell(seed, { pricePaise: 3_200_000, categoryId: "laptops", ratingAverage: 4.6 }, { similarity: 0.7 }),
    ).toBe(true);
  });

  it("rejects a cheaper product", () => {
    expect(
      isViableUpsell(seed, { pricePaise: 2_000_000, categoryId: "laptops", ratingAverage: 4.6 }, { similarity: 0.7 }),
    ).toBe(false);
  });

  it("rejects a mere price increase with no relevance", () => {
    expect(
      isViableUpsell(seed, { pricePaise: 3_200_000, categoryId: "laptops", ratingAverage: 4.6 }, { similarity: 0.1 }),
    ).toBe(false);
  });

  it("rejects an order-of-magnitude jump", () => {
    expect(
      isViableUpsell(seed, { pricePaise: 30_000_000, categoryId: "laptops", ratingAverage: 4.9 }, { similarity: 0.9 }),
    ).toBe(false);
  });

  it("rejects a different category — that is a cross-sell wearing an upsell label", () => {
    expect(
      isViableUpsell(seed, { pricePaise: 3_200_000, categoryId: "phones", ratingAverage: 4.6 }, { similarity: 0.7 }),
    ).toBe(false);
  });

  it("rejects upselling into a worse-reviewed product", () => {
    expect(
      isViableUpsell(seed, { pricePaise: 3_200_000, categoryId: "laptops", ratingAverage: 2.8 }, { similarity: 0.7 }),
    ).toBe(false);
  });
});

/* ── Evaluation metrics ───────────────────────────────────────────────── */

describe("evaluation metrics", () => {
  const recommended = ["a", "b", "c", "d"];
  const relevant = ["a", "c", "z"];

  it("computes precision@K", () => {
    expect(precisionAtK(recommended, relevant, 2)).toBe(0.5);
    expect(precisionAtK(recommended, relevant, 4)).toBeCloseTo(0.5, 5);
  });

  it("computes recall@K", () => {
    expect(recallAtK(recommended, relevant, 4)).toBeCloseTo(2 / 3, 5);
    expect(recallAtK(recommended, [], 4)).toBe(0);
  });

  it("rewards hits that land higher via MAP", () => {
    const early = [{ recommended: ["a", "c", "x"], relevant: ["a", "c"] }];
    const late = [{ recommended: ["x", "y", "a", "c"], relevant: ["a", "c"] }];
    expect(mapAtK(early, 4)).toBeGreaterThan(mapAtK(late, 4));
  });

  it("computes average precision at a single perfect position", () => {
    expect(averagePrecisionAtK(["a"], ["a"], 1)).toBe(1);
  });

  it("normalizes NDCG against the ideal ordering", () => {
    const ideal = ndcgAtK(["a", "b"], { a: 3, b: 2 }, 2);
    const reversed = ndcgAtK(["b", "a"], { a: 3, b: 2 }, 2);
    expect(ideal).toBeCloseTo(1, 5);
    expect(reversed).toBeLessThan(ideal);
  });

  it("measures coverage across cases", () => {
    expect(coverage([["a", "b"], ["b", "c"]], 10)).toBeCloseTo(0.3, 5);
  });

  it("measures novelty against a popularity rank", () => {
    expect(novelty(["a", "b"], { a: 0.01, b: 0.5 })).toBe(0.5);
    expect(novelty(["unknown"], {})).toBe(1);
  });

  it("reports all four business rates and guards a zero denominator", () => {
    const metrics = recommendationBusinessMetrics({
      impressions: 1000, clicks: 100, addToCarts: 40, purchases: 10, revenuePaise: 500_000,
    });
    expect(metrics.ctr).toBeCloseTo(0.1, 5);
    expect(metrics.conversionRate).toBeCloseTo(0.01, 5);
    expect(metrics.revenuePerImpressionPaise).toBe(500);

    const empty = recommendationBusinessMetrics({
      impressions: 0, clicks: 5, addToCarts: 0, purchases: 0, revenuePaise: 0,
    });
    expect(empty.ctr).toBe(0);
  });

  it("measures catalog coverage", () => {
    expect(catalogCoverage(["a", "b"], 8)).toBeCloseTo(0.25, 5);
  });
});

/* ── Explanations ─────────────────────────────────────────────────────── */

describe("explanations", () => {
  it("names the interest, never the evidence", () => {
    const explanation = explainItem({
      type: "PERSONALIZED_FOR_YOU",
      components: { relevance: 0, userInterest: 40, similarity: 0, popularity: 0, quality: 0, freshness: 0, purchaseAffinity: 0, context: 0, duplicationPenalty: 0, outOfStockPenalty: 0, stalePenalty: 0 },
      dominant: "userInterest",
      personalized: true,
      categoryName: "Gaming Laptops",
    });
    expect(explanation).toContain("Gaming Laptops");
    expect(explanation).not.toMatch(/\d+\.\d+/);
  });

  it("refuses to invent a personalized reason without a signal", () => {
    const explanation = explainItem({
      type: "PERSONALIZED_FOR_YOU",
      components: { relevance: 0, userInterest: 40, similarity: 0, popularity: 0, quality: 0, freshness: 0, purchaseAffinity: 0, context: 0, duplicationPenalty: 0, outOfStockPenalty: 0, stalePenalty: 0 },
      dominant: "userInterest",
      personalized: false,
    });
    expect(explanation).toBeNull();
  });

  it("prefers the co-purchase explanation when the item came from one", () => {
    const explanation = explainItem({
      type: "CROSS_SELL",
      components: { relevance: 0, userInterest: 0, similarity: 40, popularity: 0, quality: 0, freshness: 0, purchaseAffinity: 0, context: 0, duplicationPenalty: 0, outOfStockPenalty: 0, stalePenalty: 0 },
      dominant: "similarity",
      personalized: false,
      fromCoPurchase: true,
    });
    expect(explanation).toMatch(/bought/i);
  });

  it("substitutes the category name into the heading template", () => {
    expect(headingForType("POPULAR_IN_CATEGORY", { categoryName: "Laptops" })).toBe("Popular in Laptops");
    expect(headingForType("POPULAR_IN_CATEGORY")).toBe("Popular");
  });

  it("caps source signals so a card footer stays a phrase", () => {
    expect(trimSourceSignals(["a", "b", "c", "d", "e", "f"])).toHaveLength(4);
    expect(trimSourceSignals(["a", "a", "b"])).toEqual(["a", "b"]);
  });
});

/* ── Type resolution ──────────────────────────────────────────────────── */

describe("recommendation type resolution", () => {
  it("accepts the canonical enum name", () => {
    expect(resolveRecommendationType("SIMILAR_PRODUCTS")).toBe("SIMILAR_PRODUCTS");
  });

  it("accepts the URL alias", () => {
    expect(resolveRecommendationType("frequently-bought")).toBe("FREQUENTLY_BOUGHT_TOGETHER");
    expect(resolveRecommendationType("for-you")).toBe("PERSONALIZED_FOR_YOU");
    expect(resolveRecommendationType("cross-sell")).toBe("CROSS_SELL");
  });

  it("accepts a kebab-case form of the enum name", () => {
    expect(resolveRecommendationType("similar-products")).toBe("SIMILAR_PRODUCTS");
  });

  it("rejects an unknown type rather than defaulting", () => {
    expect(resolveRecommendationType("nonsense")).toBeNull();
    expect(resolveRecommendationType("")).toBeNull();
    expect(resolveRecommendationType(null)).toBeNull();
  });
});
