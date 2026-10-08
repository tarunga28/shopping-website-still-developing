import { describe, expect, it } from "vitest";

import {
  AUTO_APPLY_CONFIDENCE,
  correctionConfidence,
  correctQueryTokens,
  editDistance,
  editDistanceFor,
  jaroWinkler,
  suggestCorrection,
  trigramSimilarity,
  type VocabularyTerm,
} from "@/lib/search/spell";

/** A vocabulary shaped like a real store's: brands, categories, product words. */
const VOCAB: VocabularyTerm[] = [
  { term: "iphone", source: "BRAND", documentCount: 4200 },
  { term: "samsung", source: "BRAND", documentCount: 3100 },
  { term: "nike", source: "BRAND", documentCount: 1800 },
  { term: "adidas", source: "BRAND", documentCount: 1400 },
  { term: "headphones", source: "PRODUCT", documentCount: 620 },
  { term: "laptop", source: "CATEGORY", documentCount: 540 },
  { term: "shoes", source: "CATEGORY", documentCount: 2100 },
  { term: "shirt", source: "CATEGORY", documentCount: 1900 },
  { term: "256gb", source: "ATTRIBUTE", documentCount: 300 },
  { term: "black", source: "ATTRIBUTE", documentCount: 900 },
];

describe("editDistance", () => {
  it("is zero for identical strings", () => {
    expect(editDistance("iphone", "iphone")).toBe(0);
  });

  it("counts a transposition as one edit", () => {
    // Transposed adjacent letters are the most common typo there is, and plain
    // Levenshtein would charge two substitutions for it.
    expect(editDistance("iphone", "ipohne")).toBe(1);
  });

  it("counts substitutions and insertions", () => {
    expect(editDistance("samsng", "samsung")).toBe(1);
    expect(editDistance("nikee", "nike")).toBe(1);
    expect(editDistance("lapotp", "laptop")).toBe(1);
  });

  it("respects the early-exit ceiling", () => {
    // Returns maxDistance+1 rather than the true distance, which is what lets a
    // caller ask "within 1?" without paying for the full matrix.
    expect(editDistance("abcdef", "zyxwvu", 1)).toBe(2);
  });

  it("handles empty strings", () => {
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("abc", "")).toBe(3);
    expect(editDistance("", "")).toBe(0);
  });

  it("counts code points, not bytes", () => {
    expect(editDistance("café", "cafe")).toBe(1);
  });
});

describe("jaroWinkler", () => {
  it("is 1 for identical strings", () => {
    expect(jaroWinkler("iphone", "iphone")).toBe(1);
  });

  it("rewards a shared prefix over a shared suffix", () => {
    expect(jaroWinkler("iphone", "iphonr")).toBeGreaterThan(jaroWinkler("iphone", "xphone"));
  });

  it("is low for unrelated strings", () => {
    expect(jaroWinkler("iphone", "refrigerator")).toBeLessThan(0.6);
  });
});

describe("trigramSimilarity", () => {
  it("is 1 for identical strings", () => {
    expect(trigramSimilarity("headphones", "headphones")).toBe(1);
  });

  it("is high for a near miss", () => {
    expect(trigramSimilarity("headphnes", "headphones")).toBeGreaterThan(0.6);
  });

  it("is low for unrelated strings", () => {
    expect(trigramSimilarity("headphones", "zzzzzzzz")).toBeLessThan(0.1);
  });
});

describe("suggestCorrection", () => {
  it("corrects a transposed brand", () => {
    const correction = suggestCorrection("iphne", VOCAB);
    expect(correction?.to).toBe("iphone");
  });

  it("corrects a dropped letter", () => {
    expect(suggestCorrection("samsng", VOCAB)?.to).toBe("samsung");
    expect(suggestCorrection("headphnes", VOCAB)?.to).toBe("headphones");
    expect(suggestCorrection("lapotp", VOCAB)?.to).toBe("laptop");
  });

  it("corrects a doubled letter", () => {
    expect(suggestCorrection("nikee", VOCAB)?.to).toBe("nike");
  });

  it("leaves a real vocabulary term alone", () => {
    // Correcting a word that already exists would be pure noise.
    expect(suggestCorrection("iphone", VOCAB)).toBeNull();
    expect(suggestCorrection("shoes", VOCAB)).toBeNull();
  });

  it("returns null for a word with no near neighbour", () => {
    // This is the core of "controlled" correction: an unknown word stays unknown
    // rather than being bent into the nearest thing in the catalog.
    expect(suggestCorrection("zzzzzzzz", VOCAB)).toBeNull();
    expect(suggestCorrection("qwertyuiop", VOCAB)).toBeNull();
  });

  it("never corrects a model number", () => {
    expect(suggestCorrection("256gb", VOCAB)).toBeNull();
    expect(suggestCorrection("17", VOCAB)).toBeNull();
    expect(suggestCorrection("a17", VOCAB)).toBeNull();
  });

  it("never corrects a very short token", () => {
    expect(suggestCorrection("sh", VOCAB)).toBeNull();
    expect(suggestCorrection("tee", VOCAB)).toBeNull();
  });

  it("respects a disabled correction setting", () => {
    expect(suggestCorrection("iphne", VOCAB, { maxEditDistance: 0 })).toBeNull();
  });

  it("honours the minimum document count", () => {
    // A correction to a term used once is a guess; requiring prevalence filters
    // out catalog noise.
    expect(suggestCorrection("iphne", VOCAB, { minDocumentCount: 10_000 })).toBeNull();
  });

  it("prefers the closer candidate when two are equidistant", () => {
    // Both "shoe" and "shoes" are one edit from "shoee", so shape decides:
    // "shoe" is the closer string (0.96 vs 0.92 Jaro-Winkler).
    const vocab: VocabularyTerm[] = [
      { term: "shoe", source: "CATEGORY", documentCount: 100 },
      { term: "shoes", source: "CATEGORY", documentCount: 100 },
    ];
    expect(suggestCorrection("shoee", vocab)?.to).toBe("shoe");
  });

  it("lets shape beat popularity in a tie", () => {
    // A rare but closer match wins over a common looser one: the string itself is
    // stronger evidence of intent than how many products carry the term.
    const vocab: VocabularyTerm[] = [
      { term: "shoe", source: "CATEGORY", documentCount: 10 },
      { term: "shoes", source: "CATEGORY", documentCount: 5000 },
    ];
    expect(suggestCorrection("shoee", vocab)?.to).toBe("shoe");
  });

  it("breaks a true tie on document count", () => {
    // Identical distance AND identical similarity, so prevalence is the only
    // remaining signal.
    const vocab: VocabularyTerm[] = [
      { term: "nike", source: "BRAND", documentCount: 10 },
      { term: "nkie", source: "BRAND", documentCount: 9000 },
    ];
    expect(suggestCorrection("nkei", vocab)?.to).toBe("nkie");
  });
});

describe("correctQueryTokens", () => {
  it("corrects only the mistyped token", () => {
    const { tokens, corrections } = correctQueryTokens(["iphne", "pro", "max"], VOCAB);
    expect(tokens).toEqual(["iphone", "pro", "max"]);
    expect(corrections).toHaveLength(1);
    expect(corrections[0]).toMatchObject({ from: "iphne", to: "iphone" });
  });

  it("corrects multiple tokens independently", () => {
    const { tokens, corrections } = correctQueryTokens(["adiddas", "runing", "shose"], [
      ...VOCAB,
      { term: "running", source: "PRODUCT", documentCount: 500 },
    ]);
    expect(tokens[0]).toBe("adidas");
    expect(corrections.length).toBeGreaterThanOrEqual(1);
  });

  it("leaves a clean query untouched", () => {
    const { tokens, corrections } = correctQueryTokens(["nike", "shoes"], VOCAB);
    expect(tokens).toEqual(["nike", "shoes"]);
    expect(corrections).toHaveLength(0);
  });

  it("returns the input unchanged when correction is disabled", () => {
    const { tokens, corrections } = correctQueryTokens(["iphne"], VOCAB, { maxEditDistance: 0 });
    expect(tokens).toEqual(["iphne"]);
    expect(corrections).toHaveLength(0);
  });
});

describe("correctionConfidence", () => {
  it("is higher for a longer token with fewer edits", () => {
    const long = correctionConfidence({ from: "headphnes", to: "headphones", distance: 1, documentCount: 620 }, 9);
    const short = correctionConfidence({ from: "nikee", to: "nike", distance: 1, documentCount: 1800 }, 5);
    expect(long).toBeGreaterThan(short);
  });

  it("rises with how common the target term is", () => {
    const rare = correctionConfidence({ from: "iphne", to: "iphone", distance: 1, documentCount: 5 }, 5);
    const common = correctionConfidence({ from: "iphne", to: "iphone", distance: 1, documentCount: 4200 }, 5);
    expect(common).toBeGreaterThan(rare);
  });

  it("stays within [0, 1]", () => {
    const value = correctionConfidence({ from: "a", to: "b", distance: 1, documentCount: 1e9 }, 1);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(1);
  });

  it("clears the auto-apply bar for an obvious brand typo", () => {
    // "iphne" -> "iphone" (a brand with thousands of products) should be applied
    // silently rather than offered as a question.
    const confidence = correctionConfidence(
      { from: "iphne", to: "iphone", distance: 1, documentCount: 4200 },
      5,
    );
    expect(confidence).toBeGreaterThanOrEqual(AUTO_APPLY_CONFIDENCE);
  });
});

describe("editDistanceFor", () => {
  it("scales the allowance with token length", () => {
    expect(editDistanceFor("tee", 2)).toBe(0);
    expect(editDistanceFor("iphne", 2)).toBe(1);
    expect(editDistanceFor("headphnes", 2)).toBe(2);
  });

  it("returns zero when correction is disabled", () => {
    expect(editDistanceFor("headphnes", 0)).toBe(0);
  });
});
