import { describe, expect, it } from "vitest";

import {
  DEFAULT_RANKING_CONFIG,
  DEFAULT_WEIGHTS,
  applyOutOfStockPolicy,
  assertLayerBalance,
  explainScore,
  parseRankingConfig,
  parseWeights,
  reviewVolumeScore,
  scoreCandidate,
  sortByScore,
  type RankSignals,
} from "@/lib/search/ranking";
import { NO_SIGNALS } from "@/lib/search/ranking";

function signals(overrides: Partial<RankSignals> = {}): RankSignals {
  return { ...NO_SIGNALS, ...overrides };
}

describe("parseWeights", () => {
  it("accepts a complete weight set", () => {
    const { weights, errors } = parseWeights(DEFAULT_WEIGHTS);
    expect(errors).toEqual([]);
    expect(weights.exactSku).toBe(DEFAULT_WEIGHTS.exactSku);
  });

  it("rejects an unknown key rather than ignoring it", () => {
    // A typo in a stored weight would otherwise silently leave the real signal
    // at its default, and the operator would see "my change did nothing".
    const { errors } = parseWeights({ ...DEFAULT_WEIGHTS, exactBrnad: 100 });
    expect(errors.some((error) => error.includes("exactBrnad"))).toBe(true);
  });

  it("reports a missing key", () => {
    const { exactSku: _omitted, ...rest } = DEFAULT_WEIGHTS;
    const { errors } = parseWeights(rest);
    expect(errors.some((error) => error.includes("exactSku"))).toBe(true);
  });

  it("rejects a negative weight", () => {
    const { errors } = parseWeights({ ...DEFAULT_WEIGHTS, popularity: -1 });
    expect(errors.some((error) => error.includes("popularity"))).toBe(true);
  });

  it("falls back to defaults when the input is not an object", () => {
    const { weights, errors } = parseWeights(null);
    expect(errors.length).toBeGreaterThan(0);
    expect(weights).toEqual(DEFAULT_WEIGHTS);
  });
});

describe("parseRankingConfig", () => {
  it("parses a valid stored row", () => {
    const { config, errors } = parseRankingConfig({
      version: "v1",
      label: "Default",
      weights: DEFAULT_WEIGHTS,
      outOfStockMode: "DEMOTE",
      fuzzyThreshold: 0.35,
      maxEditDistance: 1,
    });
    expect(errors).toEqual([]);
    expect(config.version).toBe("v1");
  });

  it("clamps an out-of-range fuzzy threshold", () => {
    const { config } = parseRankingConfig({
      version: "v1",
      weights: DEFAULT_WEIGHTS,
      fuzzyThreshold: 5,
      maxEditDistance: 1,
    });
    // Falls back to the safe default rather than running with a nonsense value.
    expect(config.fuzzyThreshold).toBe(0.35);
  });

  it("rejects an unknown out-of-stock mode", () => {
    const { errors } = parseRankingConfig({
      version: "v1",
      weights: DEFAULT_WEIGHTS,
      outOfStockMode: "SOMETIMES",
    });
    expect(errors.some((error) => error.includes("outOfStockMode"))).toBe(true);
  });
});

describe("assertLayerBalance", () => {
  it("accepts the shipped defaults", () => {
    expect(assertLayerBalance(DEFAULT_WEIGHTS)).toEqual([]);
  });

  it("rejects commercial signals that can outweigh text relevance", () => {
    // This is the failure mode that silently turns search into a bestseller list.
    const problems = assertLayerBalance({ ...DEFAULT_WEIGHTS, popularity: 50, rating: 200 });
    expect(problems.some((problem) => problem.includes("commercial"))).toBe(true);
  });

  it("enforces the text-relevance ordering", () => {
    expect(
      assertLayerBalance({ ...DEFAULT_WEIGHTS, exactName: 10, prefixName: 100 }).some((problem) =>
        problem.includes("exactName"),
      ),
    ).toBe(true);
    expect(
      assertLayerBalance({ ...DEFAULT_WEIGHTS, tokenName: 500, descriptionMatch: 600 }).some(
        (problem) => problem.includes("tokenName"),
      ),
    ).toBe(true);
    expect(
      assertLayerBalance({ ...DEFAULT_WEIGHTS, exactSku: 100, exactName: 400 }).some((problem) =>
        problem.includes("exactSku"),
      ),
    ).toBe(true);
  });

  it("requires a positive out-of-stock penalty so DEMOTE does something", () => {
    expect(
      assertLayerBalance({ ...DEFAULT_WEIGHTS, outOfStockPenalty: 0 }).some((problem) =>
        problem.includes("outOfStockPenalty"),
      ),
    ).toBe(true);
  });
});

describe("scoreCandidate", () => {
  it("ranks an exact name match above a prefix match", () => {
    const exact = scoreCandidate(signals({ exactName: true }), DEFAULT_WEIGHTS);
    const prefix = scoreCandidate(signals({ prefixName: true }), DEFAULT_WEIGHTS);
    expect(exact.total).toBeGreaterThan(prefix.total);
  });

  it("ranks a prefix match above a loose token match", () => {
    const prefix = scoreCandidate(signals({ prefixName: true }), DEFAULT_WEIGHTS);
    const token = scoreCandidate(signals({ nameTokenCoverage: 1 }), DEFAULT_WEIGHTS);
    expect(prefix.total).toBeGreaterThan(token.total);
  });

  it("ranks an exact SKU above everything else", () => {
    const sku = scoreCandidate(signals({ exactSku: true }), DEFAULT_WEIGHTS);
    const name = scoreCandidate(signals({ exactName: true }), DEFAULT_WEIGHTS);
    expect(sku.total).toBeGreaterThan(name.total);
  });

  it("never lets a bestseller outrank a direct name match", () => {
    // The invariant the whole layering exists to protect.
    const relevant = scoreCandidate(signals({ exactName: true }), DEFAULT_WEIGHTS);
    const popularIrrelevant = scoreCandidate(
      signals({ popularity: 100, salesVelocity: 1, ratingAverage: 5, ratingCount: 10_000, freshness: 1 }),
      DEFAULT_WEIGHTS,
    );
    expect(relevant.total).toBeGreaterThan(popularIrrelevant.total);
  });

  it("treats an unrated product as neutral rather than zero", () => {
    // A new product with no reviews must not be buried beneath one with a single
    // mediocre review.
    const unrated = scoreCandidate(signals({ exactName: true, ratingAverage: null }), DEFAULT_WEIGHTS);
    const poorlyRated = scoreCandidate(
      signals({ exactName: true, ratingAverage: 1, ratingCount: 1 }),
      DEFAULT_WEIGHTS,
    );
    expect(unrated.total).toBeGreaterThan(poorlyRated.total);
  });

  it("penalises a fuzzy match in proportion to how weak it was", () => {
    const nearMiss = scoreCandidate(
      signals({ exactName: true, fuzzy: true, fuzzySimilarity: 0.95 }),
      DEFAULT_WEIGHTS,
    );
    const wildGuess = scoreCandidate(
      signals({ exactName: true, fuzzy: true, fuzzySimilarity: 0.1 }),
      DEFAULT_WEIGHTS,
    );
    expect(nearMiss.total).toBeGreaterThan(wildGuess.total);
  });

  it("demotes an out-of-stock product in DEMOTE mode", () => {
    const inStock = scoreCandidate(signals({ exactName: true, inStock: true }), DEFAULT_WEIGHTS);
    const outOfStock = scoreCandidate(
      signals({ exactName: true, inStock: false }),
      DEFAULT_WEIGHTS,
      { outOfStockMode: "DEMOTE" },
    );
    expect(inStock.total).toBeGreaterThan(outOfStock.total);
  });

  it("does not penalise stock in HIDE mode, where unavailable items are dropped", () => {
    // The penalty would be double-counting: the item is removed entirely.
    const hidden = scoreCandidate(signals({ exactName: true, inStock: false }), DEFAULT_WEIGHTS, {
      outOfStockMode: "HIDE",
    });
    const inStock = scoreCandidate(signals({ exactName: true, inStock: true }), DEFAULT_WEIGHTS, {
      outOfStockMode: "HIDE",
    });
    expect(hidden.total).toBe(inStock.total);
  });

  it("never returns a negative score", () => {
    const result = scoreCandidate(
      signals({ fuzzy: true, fuzzySimilarity: 0, inStock: false, nameTokenCoverage: 0.1 }),
      DEFAULT_WEIGHTS,
    );
    expect(result.total).toBeGreaterThanOrEqual(0);
  });

  it("reports a breakdown that sums to the total", () => {
    const breakdown = scoreCandidate(
      signals({ exactName: true, exactBrand: true, popularity: 50, ratingAverage: 4, ratingCount: 100 }),
      DEFAULT_WEIGHTS,
    );
    const summed =
      breakdown.text +
      breakdown.entity +
      breakdown.availability +
      breakdown.commercial +
      breakdown.quality +
      breakdown.personalization -
      breakdown.penalties;
    expect(Math.abs(summed - breakdown.total)).toBeLessThan(0.01);
  });

  it("leaves the personalization layer at zero until real signals exist", () => {
    const breakdown = scoreCandidate(signals({ exactName: true }), DEFAULT_WEIGHTS);
    expect(breakdown.personalization).toBe(0);
  });

  it("gives diminishing returns to extra attribute matches", () => {
    const one = scoreCandidate(signals({ attributeMatches: 1 }), DEFAULT_WEIGHTS);
    const three = scoreCandidate(signals({ attributeMatches: 3 }), DEFAULT_WEIGHTS);
    const ten = scoreCandidate(signals({ attributeMatches: 10 }), DEFAULT_WEIGHTS);
    expect(three.total).toBeGreaterThan(one.total);
    // The fourth and later matches add nothing: the first says a lot, the tenth
    // says very little.
    expect(ten.total).toBe(three.total);
  });
});

describe("applyOutOfStockPolicy", () => {
  const items = [
    { id: "a", inStock: false },
    { id: "b", inStock: true },
    { id: "c", inStock: true },
  ];

  it("HIDE removes unavailable items", () => {
    expect(applyOutOfStockPolicy(items, "HIDE").map((item) => item.id)).toEqual(["b", "c"]);
  });

  it("DEMOTE keeps everything in the caller's order", () => {
    expect(applyOutOfStockPolicy(items, "DEMOTE").map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("ONLY_IF_EMPTY shows unavailable items only when nothing else exists", () => {
    expect(applyOutOfStockPolicy(items, "ONLY_IF_EMPTY").map((item) => item.id)).toEqual(["b", "c"]);
    const allUnavailable = [
      { id: "x", inStock: false },
      { id: "y", inStock: false },
    ];
    expect(applyOutOfStockPolicy(allUnavailable, "ONLY_IF_EMPTY").map((item) => item.id)).toEqual([
      "x",
      "y",
    ]);
  });
});

describe("sortByScore", () => {
  it("orders by score descending with a deterministic tiebreak", () => {
    const sorted = sortByScore([
      { productId: "b", score: 10 },
      { productId: "a", score: 10 },
      { productId: "c", score: 20 },
    ]);
    // Without the id tiebreak, equal scores would swap between requests and
    // pagination would repeat and skip items.
    expect(sorted.map((item) => item.productId)).toEqual(["c", "a", "b"]);
  });

  it("does not mutate the input", () => {
    const input = [
      { productId: "a", score: 1 },
      { productId: "b", score: 2 },
    ];
    sortByScore(input);
    expect(input[0]!.productId).toBe("a");
  });
});

describe("reviewVolumeScore", () => {
  it("is log-scaled, not linear", () => {
    // Linear scaling would let 10,000 mediocre reviews dominate 400 excellent
    // ones. Volume measures confidence in the rating, not quality.
    const few = reviewVolumeScore(10);
    const many = reviewVolumeScore(10_000);
    expect(many).toBeGreaterThan(few);
    expect(many / few).toBeLessThan(10);
  });

  it("is capped", () => {
    expect(reviewVolumeScore(1_000_000)).toBeLessThanOrEqual(10);
  });

  it("is zero for no reviews", () => {
    expect(reviewVolumeScore(0)).toBe(0);
  });
});

describe("explainScore", () => {
  it("names the signals that fired", () => {
    const breakdown = scoreCandidate(signals({ exactName: true, exactBrand: true }), DEFAULT_WEIGHTS);
    const lines = explainScore(breakdown, signals({ exactName: true, exactBrand: true }));
    expect(lines.some((line) => line.includes("name matched exactly"))).toBe(true);
    expect(lines.some((line) => line.includes("Brand matched"))).toBe(true);
    expect(lines.some((line) => line.includes("Score"))).toBe(true);
  });

  it("mentions the demotion for an unavailable product", () => {
    const breakdown = scoreCandidate(signals({ inStock: false }), DEFAULT_WEIGHTS);
    const lines = explainScore(breakdown, signals({ inStock: false }));
    expect(lines.some((line) => line.includes("Out of stock"))).toBe(true);
  });
});

describe("default configuration", () => {
  it("is internally consistent and balanced", () => {
    expect(DEFAULT_RANKING_CONFIG.version).toBe("v1");
    expect(assertLayerBalance(DEFAULT_RANKING_CONFIG.weights)).toEqual([]);
  });
});
