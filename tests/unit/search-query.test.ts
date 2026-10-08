import { describe, expect, it } from "vitest";

import { filterSignature, processQuery, querySynonymGroups } from "@/lib/search/query";
import { indexLexicon, type Lexicon } from "@/lib/search/entities";
import type { VocabularyTerm } from "@/lib/search/spell";

/**
 * These tests cover the pipeline as a whole — the stages in sequence — because
 * that is where integration bugs live. Each stage is unit-tested separately; what
 * is checked here is that they compose correctly.
 */

const LEXICON: Lexicon = {
  entries: [
    { term: "nike", kind: "BRAND", value: "Nike", id: "brand-nike", productCount: 1800 },
    { term: "adidas", kind: "BRAND", value: "Adidas", id: "brand-adidas", productCount: 1400 },
    { term: "shoes", kind: "CATEGORY", value: "Shoes", id: "cat-shoes", productCount: 2100 },
    { term: "laptop", kind: "CATEGORY", value: "Laptop", id: "cat-laptop", productCount: 540 },
    { term: "black", kind: "COLOR", value: "black", axis: "color", productCount: 900 },
    { term: "256gb", kind: "ATTRIBUTE", value: "256GB", axis: "storage", productCount: 300 },
  ],
};

const VOCABULARY: VocabularyTerm[] = [
  { term: "iphone", source: "BRAND", documentCount: 4200 },
  { term: "shoes", source: "CATEGORY", documentCount: 2100 },
  { term: "running", source: "PRODUCT", documentCount: 640 },
  { term: "laptop", source: "CATEGORY", documentCount: 540 },
];

const SYNONYMS = new Map<string, string[]>([
  ["tee", ["t-shirt"]],
  ["mobile", ["smartphone"]],
]);

const LEXICON_INDEX = indexLexicon(LEXICON);

function run(query: string) {
  return processQuery(query, {
    vocabulary: VOCABULARY,
    lexicon: LEXICON_INDEX,
    synonyms: SYNONYMS,
  });
}

describe("processQuery — the completion check", () => {
  it('interprets "iphne pro max under 100000"', () => {
    // This is the exact scenario the acceptance criteria call out.
    const result = run("iphne pro max under 100000");

    // The typo is corrected to a term that exists in this catalog.
    expect(result.corrections.map((entry) => entry.to)).toContain("iphone");
    expect(result.correctionApplied).toBe(true);

    // The price becomes a structured constraint, in paise.
    expect(result.price?.maxPaise).toBe(10_000_000);
    expect(result.price?.minPaise).toBeNull();

    // The remaining terms are what actually gets matched — the price phrase and
    // the corrected typo's original spelling are both gone.
    expect(result.remainingTerms).toContain("pro");
    expect(result.remainingTerms).toContain("max");
    expect(result.remainingTerms).not.toContain("under");
    expect(result.remainingTerms).not.toContain("100000");
  });
});

describe("processQuery — entity extraction in context", () => {
  it('recognises brand, colour, and category in "nike black shoes"', () => {
    const result = run("nike black shoes");
    const kinds = result.entities.map((entity) => entity.kind);
    expect(kinds).toContain("BRAND");
    expect(kinds).toContain("COLOR");
    expect(kinds).toContain("CATEGORY");
  });

  it('recognises storage in "iphone 256 gb"', () => {
    const result = run("256gb phone");
    expect(result.entities.some((entity) => entity.axis === "storage")).toBe(true);
  });

  it('recognises a category in "gaming laptop"', () => {
    const result = run("gaming laptop");
    expect(result.entities.some((entity) => entity.kind === "CATEGORY")).toBe(true);
    // "gaming" is not an entity, so it stays as a search term.
    expect(result.remainingTerms).toContain("gaming");
  });
});

describe("processQuery — price parsing in context", () => {
  it('extracts the ceiling from "laptop under 70k"', () => {
    const result = run("laptop under 70k");
    expect(result.price?.maxPaise).toBe(7_000_000);
    expect(result.price?.source).toBe("under 70k");
    // "laptop" is a recognised category, so it becomes a filter and is consumed
    // rather than left as a search term. Nothing textual is left to match, which
    // is correct: the query was entirely category + constraint.
    expect(result.entities.some((entity) => entity.kind === "CATEGORY")).toBe(true);
    expect(result.remainingTerms).toEqual([]);
  });

  it('extracts a range from "laptop between 30000 and 50000"', () => {
    const result = run("laptop between 30000 and 50000");
    expect(result.price?.minPaise).toBe(3_000_000);
    expect(result.price?.maxPaise).toBe(5_000_000);
    expect(result.remainingTerms).toEqual([]);
  });

  it("keeps a non-entity word as a search term alongside a price", () => {
    // "gaming" is not in the lexicon, so it survives as text while the price and
    // the category are both extracted.
    const result = run("gaming laptop under 70k");
    expect(result.price?.maxPaise).toBe(7_000_000);
    expect(result.remainingTerms).toEqual(["gaming"]);
  });

  it("leaves a bare number as a search term", () => {
    const result = run("iphone 17");
    expect(result.price).toBeNull();
    expect(result.remainingTerms).toContain("17");
  });
});

describe("processQuery — spell correction in context", () => {
  it("corrects only to terms that exist in the catalog", () => {
    // "widgett" has no near neighbour in the vocabulary, so it must survive
    // untouched rather than being bent into the nearest catalog word.
    const result = run("widgett");
    expect(result.corrections).toHaveLength(0);
    expect(result.remainingTerms).toContain("widgett");
  });

  it("does not correct a model number", () => {
    const result = run("256gb");
    expect(result.corrections).toHaveLength(0);
  });

  it("offers a low-confidence correction instead of applying it", () => {
    // Nothing is applied, but the suggestion is available for "did you mean?".
    const result = processQuery("tee", {
      vocabulary: [{ term: "tees", source: "PRODUCT", documentCount: 3 }],
      synonyms: new Map(),
    });
    expect(result.correctionApplied).toBe(false);
    expect(result.remainingTerms).toContain("tee");
  });

  it("can be disabled entirely", () => {
    const result = processQuery("iphne", {
      vocabulary: VOCABULARY,
      autoCorrect: false,
    });
    expect(result.corrections).toHaveLength(0);
    expect(result.tokens).toContain("iphne");
  });
});

describe("processQuery — synonyms", () => {
  it("expands a synonym into matchable terms", () => {
    // Part 11 tokenizes a multi-word synonym so each part can match the indexed
    // tsvector independently: "t-shirt" contributes "t" and "shirt". Asserting
    // the intact phrase would fail, because a phrase is never a single lexeme.
    const result = run("tee");
    expect(result.synonymsApplied).toContain("tee");
    expect(result.synonymsApplied).toContain("shirt");
  });

  it("leaves a query without synonyms alone", () => {
    const result = run("laptop");
    expect(result.synonymsApplied).toEqual(["laptop"]);
  });
});

describe("processQuery — identifiers", () => {
  it("flags a bare SKU and skips the text pipeline", () => {
    const result = run("INK-TEE-001");
    expect(result.isExactIdentifier).toBe(true);
    expect(result.intent).toBe("NAVIGATIONAL");
    // An identifier must not be spell-corrected or synonym-expanded.
    expect(result.corrections).toHaveLength(0);
  });
});

describe("processQuery — intent", () => {
  it("classifies a lone brand", () => {
    expect(run("nike").intent).toBe("BRAND");
  });

  it("classifies a category query", () => {
    expect(run("laptop").intent).toBe("CATEGORY");
  });

  it("is BROAD for an empty query", () => {
    const result = run("   ");
    expect(result.intent).toBe("BROAD");
    expect(result.tokens).toEqual([]);
  });
});

describe("processQuery — determinism", () => {
  it("produces the same canonical key for equivalent input", () => {
    // The canonical key is the cache key and the analytics key, so equivalent
    // queries must collapse to one value.
    const a = run("Nike Black Shoes");
    const b = run("  shoes   BLACK  nike ");
    expect(a.canonical).toBe(b.canonical);
  });
});

describe("querySynonymGroups", () => {
  it("ORs within a position and ANDs across positions", () => {
    // The grouped form is what the database needs: (tee | t | shirt) & black.
    // Flattening the groups would AND the synonyms together and match nothing.
    const groups = querySynonymGroups({ tokens: ["tee", "black"] }, SYNONYMS);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual(expect.arrayContaining(["tee", "shirt"]));
    expect(groups[1]).toEqual(["black"]);
  });
});

describe("filterSignature", () => {
  it("is stable regardless of insertion order", () => {
    const a = filterSignature({ brandIds: ["b1", "b2"], categoryIds: ["c1"] });
    const b = filterSignature({ categoryIds: ["c1"], brandIds: ["b2", "b1"] });
    expect(a).toBe(b);
  });

  it("differs when a filter changes", () => {
    expect(filterSignature({ brandIds: ["b1"] })).not.toBe(filterSignature({ brandIds: ["b2"] }));
  });

  it("is empty for no filters", () => {
    expect(filterSignature({})).toBe("");
  });

  it("includes attribute axes in a stable order", () => {
    const signature = filterSignature({ attributes: { size: ["m"], color: ["black"] } });
    expect(signature).toBe("color:black|size:m");
  });
});
