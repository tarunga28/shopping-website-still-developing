import { describe, expect, it } from "vitest";

import {
  collapseRepeats,
  expandAbbreviations,
  extractPriceConstraint,
  foldToken,
  looksLikeIdentifier,
  normalizeQuery,
  parseAmountPaise,
} from "@/lib/search/normalize";
import { editDistanceFor } from "@/lib/search/spell";

describe("normalizeQuery", () => {
  it("folds case, diacritics, and whitespace", () => {
    const result = normalizeQuery("  iPhone   Café  ");
    expect(result.normalized).toBe("iphone cafe");
    expect(result.terms).toEqual(["iphone", "cafe"]);
  });

  it("produces equivalent results for differently-cased input", () => {
    const variants = ["iPhone", "iphone", "IPHONE", "IpHoNe"];
    const canonicals = new Set(variants.map((value) => normalizeQuery(value).canonical));
    expect(canonicals.size).toBe(1);
  });

  it("keeps identifiers searchable exactly", () => {
    const result = normalizeQuery("A17-256GB");
    // Folded for matching, but still recognised as an identifier so the search
    // path can exact-match it instead of tokenizing it away.
    expect(result.isExactIdentifier).toBe(true);
    expect(result.raw).toBe("A17-256GB");
  });

  it("bounds the query length", () => {
    const result = normalizeQuery("x".repeat(500));
    expect(result.raw.length).toBeLessThanOrEqual(120);
  });

  it("drops stop words from terms but keeps the raw tokens", () => {
    const result = normalizeQuery("the best shirt for gifting");
    expect(result.terms).toEqual(["shirt", "gifting"]);
    expect(result.rawTokens).toContain("best");
  });

  it("returns an empty but valid shape for empty input", () => {
    // normalizeQuery returns only the lexical forms; intent is decided later in
    // the pipeline by detectIntent, which needs entities as well.
    const result = normalizeQuery("   ");
    expect(result.raw).toBe("");
    expect(result.terms).toEqual([]);
    expect(result.rawTokens).toEqual([]);
    expect(result.canonical).toBe("");
    expect(result.isExactIdentifier).toBe(false);
  });
});

describe("foldToken", () => {
  it("strips punctuation at the edges only", () => {
    expect(foldToken("--Shirt--")).toBe("shirt");
    expect(foldToken("a-b")).toBe("a-b");
  });

  it("folds combining marks", () => {
    expect(foldToken("café")).toBe("cafe");
    expect(foldToken("cafe\u0301")).toBe("cafe");
  });
});

describe("collapseRepeats", () => {
  it("caps runs at two rather than one, preserving legitimate doubles", () => {
    // Capping at a single character would turn "dress" into "dres" and break a
    // real word. Capping at two keeps doubles intact while still shortening a
    // held-down key, and leaves the rest to the spell corrector.
    expect(collapseRepeats("iphooone")).toBe("iphoone");
    expect(collapseRepeats("shiiirt")).toBe("shiirt");
    expect(collapseRepeats("dress")).toBe("dress");
    expect(collapseRepeats("coffee")).toBe("coffee");
  });
});

describe("looksLikeIdentifier", () => {
  it("recognises SKUs and barcodes", () => {
    expect(looksLikeIdentifier("A17-256GB")).toBe(true);
    expect(looksLikeIdentifier("8901234567890")).toBe(true);
    expect(looksLikeIdentifier("INK-TEE-001")).toBe(true);
  });

  it("rejects ordinary phrases", () => {
    expect(looksLikeIdentifier("iphone 17")).toBe(false);
    expect(looksLikeIdentifier("black shirt")).toBe(false);
    expect(looksLikeIdentifier("")).toBe(false);
  });

  it("rejects short alphanumeric words that are not identifiers", () => {
    expect(looksLikeIdentifier("tee")).toBe(false);
    expect(looksLikeIdentifier("17")).toBe(false);
  });
});

describe("parseAmountPaise", () => {
  it("parses plain amounts", () => {
    expect(parseAmountPaise("50000")).toBe(5_000_000);
    expect(parseAmountPaise("50,000")).toBe(5_000_000);
    expect(parseAmountPaise("1299.50")).toBe(129_950);
  });

  it("parses Indian shorthand", () => {
    expect(parseAmountPaise("50k")).toBe(5_000_000);
    expect(parseAmountPaise("1.5l")).toBe(15_000_000);
    expect(parseAmountPaise("2lakh")).toBe(20_000_000);
    // 1 crore = 10,000,000 rupees = 1,000,000,000 paise.
    expect(parseAmountPaise("1cr")).toBe(1_000_000_000);
  });

  it("parses currency decorations", () => {
    expect(parseAmountPaise("₹50000")).toBe(5_000_000);
    expect(parseAmountPaise("rs 50000")).toBe(5_000_000);
    expect(parseAmountPaise("50000 rupees")).toBe(5_000_000);
  });

  it("converts exact rupee amounts to paise without float drift", () => {
    expect(parseAmountPaise("12.34")).toBe(1234);
    expect(parseAmountPaise("0.01")).toBe(1);
  });

  it("rejects sub-paise precision instead of inventing a rounding rule", () => {
    // Three decimal places of a rupee is not a price a shopper means. Rejecting
    // it surfaces the bad parse rather than silently guessing.
    expect(parseAmountPaise("1.005")).toBeNull();
  });

  it("rejects non-amounts", () => {
    expect(parseAmountPaise("abc")).toBeNull();
    expect(parseAmountPaise("")).toBeNull();
    expect(parseAmountPaise("12x")).toBeNull();
  });

  it("does not treat 'm' as a multiplier", () => {
    // In a catalog "m" means meters as often as million, so it is not accepted.
    expect(parseAmountPaise("5m")).toBeNull();
  });
});

describe("extractPriceConstraint", () => {
  it("extracts an upper bound", () => {
    const { constraint, remaining } = extractPriceConstraint("laptop under 70000");
    expect(constraint?.maxPaise).toBe(7_000_000);
    expect(constraint?.minPaise).toBeNull();
    expect(remaining).toBe("laptop");
  });

  it("extracts a lower bound", () => {
    const { constraint, remaining } = extractPriceConstraint("shoes above 2000");
    expect(constraint?.minPaise).toBe(200_000);
    expect(remaining).toBe("shoes");
  });

  it("handles 'less than' and 'more than'", () => {
    expect(extractPriceConstraint("shirt less than 500").constraint?.maxPaise).toBe(50_000);
    expect(extractPriceConstraint("shirt more than 500").constraint?.minPaise).toBe(50_000);
  });

  it("extracts a range", () => {
    const { constraint, remaining } = extractPriceConstraint("laptop between 30000 and 50000");
    expect(constraint?.minPaise).toBe(3_000_000);
    expect(constraint?.maxPaise).toBe(5_000_000);
    expect(remaining).toBe("laptop");
  });

  it("handles the 'X to Y' range form", () => {
    const { constraint } = extractPriceConstraint("shirt 1000 to 2000");
    expect(constraint?.minPaise).toBe(100_000);
    expect(constraint?.maxPaise).toBe(200_000);
  });

  it("accepts shorthand in a constraint", () => {
    const { constraint, remaining } = extractPriceConstraint("laptop under 70k");
    expect(constraint?.maxPaise).toBe(7_000_000);
    expect(remaining).toBe("laptop");
  });

  it("does NOT treat a bare number as a price filter", () => {
    // "laptop 50000" is ambiguous. Guessing a ceiling would silently hide
    // products, so the number stays a search term.
    const { constraint, remaining } = extractPriceConstraint("laptop 50000");
    expect(constraint).toBeNull();
    expect(remaining).toBe("laptop 50000");
  });

  it("does not turn a model number into a price", () => {
    const { constraint } = extractPriceConstraint("iphone 17");
    expect(constraint).toBeNull();
  });

  it("leaves the query untouched when there is no price", () => {
    const { constraint, remaining } = extractPriceConstraint("black running shoes");
    expect(constraint).toBeNull();
    expect(remaining).toBe("black running shoes");
  });
});

describe("expandAbbreviations", () => {
  it("keeps the original and adds the expansion", () => {
    const expanded = expandAbbreviations(["laptops"]);
    expect(expanded).toContain("laptops");
    expect(expanded).toContain("laptop");
  });

  it("leaves unknown terms alone", () => {
    expect(expandAbbreviations(["widget"])).toEqual(["widget"]);
  });
});

describe("editDistanceFor", () => {
  it("refuses to correct very short tokens", () => {
    // One edit on a three-letter word is a third of the word — usually a
    // different word entirely.
    expect(editDistanceFor("tee", 1)).toBe(0);
    expect(editDistanceFor("sh", 2)).toBe(0);
  });

  it("allows one edit for medium tokens", () => {
    expect(editDistanceFor("iphne", 2)).toBe(1);
  });

  it("allows two edits for long tokens", () => {
    expect(editDistanceFor("headphnes", 2)).toBe(2);
  });

  it("respects a disabled correction setting", () => {
    expect(editDistanceFor("iphne", 0)).toBe(0);
  });
});
