import { describe, expect, it } from "vitest";

import {
  ENTITY_APPLY_THRESHOLD,
  detectIntent,
  entitiesToFilters,
  entityConfidence,
  extractEntities,
  extractGender,
  indexLexicon,
  type Lexicon,
} from "@/lib/search/entities";

const LEXICON: Lexicon = {
  entries: [
    { term: "nike", kind: "BRAND", value: "Nike", id: "brand-nike", productCount: 1800 },
    { term: "adidas", kind: "BRAND", value: "Adidas", id: "brand-adidas", productCount: 1400 },
    { term: "apple", kind: "BRAND", value: "Apple", id: "brand-apple", productCount: 900 },
    { term: "apple", kind: "CATEGORY", value: "Fruit", id: "cat-fruit", productCount: 12 },
    { term: "shoes", kind: "CATEGORY", value: "Shoes", id: "cat-shoes", productCount: 2100 },
    { term: "running shoes", kind: "CATEGORY", value: "Running Shoes", id: "cat-running", productCount: 340 },
    { term: "laptop", kind: "CATEGORY", value: "Laptop", id: "cat-laptop", productCount: 540 },
    { term: "black", kind: "COLOR", value: "black", axis: "color", productCount: 900 },
    { term: "white", kind: "COLOR", value: "white", axis: "color", productCount: 700 },
    { term: "256gb", kind: "ATTRIBUTE", value: "256GB", axis: "storage", productCount: 300 },
    { term: "16gb", kind: "ATTRIBUTE", value: "16GB", axis: "ram", productCount: 220 },
    { term: "leather", kind: "MATERIAL", value: "leather", axis: "material", productCount: 180 },
  ],
};

const INDEX = indexLexicon(LEXICON);

describe("indexLexicon", () => {
  it("indexes every term and alias", () => {
    expect(INDEX.byTerm.has("nike")).toBe(true);
    expect(INDEX.byTerm.has("running shoes")).toBe(true);
  });

  it("records the longest phrase present", () => {
    expect(INDEX.maxPhraseWords).toBe(2);
  });

  it("keeps both meanings of an ambiguous term", () => {
    expect(INDEX.byTerm.get("apple")).toHaveLength(2);
  });
});

describe("extractEntities", () => {
  it("extracts a brand and a category", () => {
    const { entities } = extractEntities(["nike", "shoes"], INDEX);
    expect(entities.some((entity) => entity.kind === "BRAND" && entity.value === "Nike")).toBe(true);
    expect(entities.some((entity) => entity.kind === "CATEGORY")).toBe(true);
  });

  it("prefers the longest matching phrase", () => {
    // "running shoes" must win over "shoes", or a specific category collapses
    // into its parent and the results broaden unexpectedly.
    const { entities } = extractEntities(["running", "shoes"], INDEX);
    const categories = entities.filter((entity) => entity.kind === "CATEGORY");
    expect(categories.some((entity) => entity.value === "Running Shoes")).toBe(true);
  });

  it("extracts colour and attribute values", () => {
    const { entities } = extractEntities(["black", "256gb", "phone"], INDEX);
    expect(entities.some((entity) => entity.kind === "COLOR" && entity.value === "black")).toBe(true);
    expect(
      entities.some((entity) => entity.axis === "storage" && entity.value === "256GB"),
    ).toBe(true);
  });

  it("removes confidently-matched tokens from the remaining terms", () => {
    // Otherwise "nike" is applied as a filter AND searched as a keyword, which
    // narrows the result set twice for the same word.
    const { remainingTokens } = extractEntities(["nike", "jacket"], INDEX);
    expect(remainingTokens).not.toContain("nike");
    expect(remainingTokens).toContain("jacket");
  });

  it("keeps an ambiguous token as a search term", () => {
    // "apple" is a brand and a fruit here. Dropping it from the search would
    // silently narrow the results on a guess, so it stays as a keyword.
    const { entities, remainingTokens } = extractEntities(["apple"], INDEX);
    expect(entities.length).toBeGreaterThan(0);
    expect(remainingTokens).toContain("apple");
  });

  it("extracts nothing from unrelated words", () => {
    const { entities, remainingTokens } = extractEntities(["widget", "gizmo"], INDEX);
    expect(entities).toEqual([]);
    expect(remainingTokens).toEqual(["widget", "gizmo"]);
  });

  it("handles an empty token list", () => {
    expect(extractEntities([], INDEX)).toEqual({ entities: [], remainingTokens: [] });
  });
});

describe("entityConfidence", () => {
  it("penalises an ambiguous term", () => {
    const unambiguous = entityConfidence(
      { term: "nike", kind: "BRAND", value: "Nike", productCount: 1800 },
      2,
    );
    const ambiguous = entityConfidence(
      { term: "apple", kind: "BRAND", value: "Apple", productCount: 900, ambiguity: 2 },
      2,
    );
    expect(ambiguous).toBeLessThan(unambiguous);
  });

  it("rises with how many products carry the entity", () => {
    const rare = entityConfidence({ term: "x", kind: "BRAND", value: "X", productCount: 2 }, 2);
    const common = entityConfidence({ term: "x", kind: "BRAND", value: "X", productCount: 5000 }, 2);
    expect(common).toBeGreaterThan(rare);
  });

  it("is lower inside a long query, where an entity mention is more likely incidental", () => {
    const short = entityConfidence({ term: "nike", kind: "BRAND", value: "Nike", productCount: 1800 }, 1);
    const long = entityConfidence({ term: "nike", kind: "BRAND", value: "Nike", productCount: 1800 }, 8);
    expect(long).toBeLessThan(short);
  });

  it("stays within [0, 1]", () => {
    const value = entityConfidence({ term: "x", kind: "BRAND", value: "X", productCount: 1e9 }, 1);
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThanOrEqual(1);
  });
});

describe("extractGender", () => {
  it("recognises gender terms", () => {
    expect(extractGender("men")?.value).toBe("men");
    expect(extractGender("womens")?.value).toBe("women");
    expect(extractGender("unisex")?.value).toBe("unisex");
  });

  it("returns null for other words", () => {
    expect(extractGender("shirt")).toBeNull();
  });
});

describe("entitiesToFilters", () => {
  it("maps brands and categories to ids", () => {
    const { entities } = extractEntities(["nike", "shoes"], INDEX);
    const filters = entitiesToFilters(entities);
    expect(filters.brandIds).toContain("brand-nike");
    expect(filters.categoryIds.length).toBeGreaterThan(0);
  });

  it("groups attributes by axis", () => {
    const { entities } = extractEntities(["black", "256gb"], INDEX);
    const filters = entitiesToFilters(entities);
    expect(filters.attributes.color).toEqual(["black"]);
    expect(filters.attributes.storage).toEqual(["256GB"]);
  });

  it("does not apply a low-confidence entity", () => {
    const filters = entitiesToFilters([
      { kind: "BRAND", matched: "apple", value: "Apple", id: "brand-apple", confidence: 0.1 },
    ]);
    expect(filters.brandIds).toEqual([]);
  });

  it("applies an entity at exactly the threshold", () => {
    const filters = entitiesToFilters([
      {
        kind: "BRAND",
        matched: "nike",
        value: "Nike",
        id: "brand-nike",
        confidence: ENTITY_APPLY_THRESHOLD,
      },
    ]);
    expect(filters.brandIds).toEqual(["brand-nike"]);
  });

  it("de-duplicates repeated values on the same axis", () => {
    const filters = entitiesToFilters([
      { kind: "COLOR", matched: "black", value: "black", axis: "color", confidence: 0.9 },
      { kind: "COLOR", matched: "black", value: "black", axis: "color", confidence: 0.9 },
    ]);
    expect(filters.attributes.color).toEqual(["black"]);
  });
});

describe("detectIntent", () => {
  it("is NAVIGATIONAL for an identifier", () => {
    expect(detectIntent({ tokens: ["a17-256gb"], entities: [], isExactIdentifier: true })).toBe(
      "NAVIGATIONAL",
    );
  });

  it("is BRAND for a lone brand name", () => {
    const { entities } = extractEntities(["nike"], INDEX);
    expect(detectIntent({ tokens: ["nike"], entities, isExactIdentifier: false })).toBe("BRAND");
  });

  it("is CATEGORY when a category is recognised", () => {
    const { entities } = extractEntities(["laptop"], INDEX);
    expect(detectIntent({ tokens: ["laptop"], entities, isExactIdentifier: false })).toBe(
      "CATEGORY",
    );
  });

  it("is PRODUCT for a long specific token run with no entities", () => {
    expect(
      detectIntent({ tokens: ["wireless", "noise", "cancelling"], entities: [], isExactIdentifier: false }),
    ).toBe("PRODUCT");
  });

  it("is BROAD for a short unrecognised query", () => {
    // Conservative on purpose: a wrong intent silently rewrites the query.
    expect(detectIntent({ tokens: ["thing"], entities: [], isExactIdentifier: false })).toBe("BROAD");
  });

  it("is BROAD for no tokens at all", () => {
    expect(detectIntent({ tokens: [], entities: [], isExactIdentifier: false })).toBe("BROAD");
  });
});
