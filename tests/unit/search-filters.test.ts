import { describe, expect, it } from "vitest";

import {
  EMPTY_SEARCH_FILTERS,
  activeFilterChips,
  buildFacetGroups,
  buildFacets,
  buildPriceFacet,
  decodeCursor,
  encodeCursor,
  hasActiveSearchFilters,
  parseSearchFilters,
  parseSearchLimit,
  parseSearchSort,
  serializeSearchFilters,
} from "@/lib/search/filters";
import type { SearchFilters } from "@/lib/search/types";

function params(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

describe("parseSearchFilters", () => {
  it("returns empty filters for an empty query string", () => {
    expect(parseSearchFilters(params(""))).toEqual(EMPTY_SEARCH_FILTERS);
  });

  it("parses comma-separated brand and category ids", () => {
    const filters = parseSearchFilters(params("brand=a,b&category=c"));
    expect(filters.brandIds).toEqual(["a", "b"]);
    expect(filters.categoryIds).toEqual(["c"]);
  });

  it("converts rupee parameters to paise", () => {
    const filters = parseSearchFilters(params("minPrice=1000&maxPrice=5000"));
    expect(filters.minPricePaise).toBe(100_000);
    expect(filters.maxPricePaise).toBe(500_000);
  });

  it("swaps an inverted price band rather than returning nothing", () => {
    // A hand-edited URL with the bounds reversed should still search.
    const filters = parseSearchFilters(params("minPrice=5000&maxPrice=1000"));
    expect(filters.minPricePaise).toBe(100_000);
    expect(filters.maxPricePaise).toBe(500_000);
  });

  it("drops an unparseable rating instead of throwing", () => {
    expect(parseSearchFilters(params("rating=abc")).minRating).toBeNull();
    expect(parseSearchFilters(params("rating=9")).minRating).toBeNull();
    expect(parseSearchFilters(params("rating=4")).minRating).toBe(4);
  });

  it("ignores an unknown availability value", () => {
    expect(parseSearchFilters(params("availability=bogus")).availability).toBe("any");
    expect(parseSearchFilters(params("availability=in_stock")).availability).toBe("in_stock");
  });

  it("parses namespaced attribute filters", () => {
    const filters = parseSearchFilters(params("attr.color=black,white&attr.size=m"));
    expect(filters.attributes).toEqual({ color: ["black", "white"], size: ["m"] });
  });

  it("clamps a negative price to null", () => {
    expect(parseSearchFilters(params("minPrice=-500")).minPricePaise).toBeNull();
  });

  it("bounds the number of values per axis", () => {
    const many = Array.from({ length: 100 }, (_unused, index) => `v${index}`).join(",");
    const filters = parseSearchFilters(params(`attr.color=${many}`));
    expect(filters.attributes.color!.length).toBeLessThanOrEqual(20);
  });
});

describe("filter URL round trip", () => {
  it("parse(serialize(f)) equals f", () => {
    // This round trip is the contract that makes search bookmarkable and makes
    // browser back/forward behave. If it breaks, a shared link opens a different
    // result set than the one it came from.
    const original: SearchFilters = {
      categoryIds: ["cat-1"],
      brandIds: ["br-1", "br-2"],
      minPricePaise: 100_000,
      maxPricePaise: 500_000,
      minRating: 4,
      availability: "in_stock",
      onSaleOnly: true,
      attributes: { color: ["black"], size: ["m", "l"] },
    };

    const serialized = serializeSearchFilters(original, { q: "shoes", sort: "rating" });
    const parsed = parseSearchFilters(serialized);

    expect(parsed.categoryIds).toEqual(original.categoryIds);
    expect(parsed.brandIds).toEqual(original.brandIds);
    expect(parsed.minPricePaise).toBe(original.minPricePaise);
    expect(parsed.maxPricePaise).toBe(original.maxPricePaise);
    expect(parsed.minRating).toBe(original.minRating);
    expect(parsed.availability).toBe(original.availability);
    expect(parsed.onSaleOnly).toBe(original.onSaleOnly);
    expect(parsed.attributes).toEqual(original.attributes);
  });

  it("omits default values so URLs stay short", () => {
    const serialized = serializeSearchFilters(EMPTY_SEARCH_FILTERS, { q: "shoes" });
    expect(serialized.toString()).toBe("q=shoes");
  });

  it("omits the default sort", () => {
    const serialized = serializeSearchFilters(EMPTY_SEARCH_FILTERS, { q: "shoes", sort: "relevance" });
    expect(serialized.has("sort")).toBe(false);
  });
});

describe("parseSearchSort", () => {
  it("defaults to relevance", () => {
    expect(parseSearchSort(params(""))).toBe("relevance");
  });

  it("accepts every documented sort", () => {
    for (const sort of [
      "popularity",
      "newest",
      "price-asc",
      "price-desc",
      "rating",
      "discount",
      "best-selling",
    ]) {
      expect(parseSearchSort(params(`sort=${sort}`))).toBe(sort);
    }
  });

  it("rejects an unknown sort", () => {
    // Sorting happens server-side, so an unknown value must fall back rather than
    // be interpolated into an ORDER BY.
    expect(parseSearchSort(params("sort=; DROP TABLE products"))).toBe("relevance");
  });
});

describe("parseSearchLimit", () => {
  it("applies the fallback for missing or invalid input", () => {
    expect(parseSearchLimit(params(""))).toBe(24);
    expect(parseSearchLimit(params("limit=abc"))).toBe(24);
    expect(parseSearchLimit(params("limit=-5"))).toBe(24);
  });

  it("clamps to the maximum", () => {
    expect(parseSearchLimit(params("limit=100000"))).toBe(100);
  });
});

describe("cursor encoding", () => {
  it("round trips", () => {
    const cursor = encodeCursor(123.456789, "product-abc");
    expect(decodeCursor(cursor)).toEqual({ score: 123.456789, productId: "product-abc" });
  });

  it("returns null for garbage", () => {
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor("!!!not-base64!!!")).toBeNull();
    expect(decodeCursor("x".repeat(500))).toBeNull();
  });

  it("handles a product id containing a colon", () => {
    // lastIndexOf, not indexOf, so an id with a colon still decodes.
    const cursor = encodeCursor(10, "ns:product:1");
    expect(decodeCursor(cursor)?.productId).toBe("ns:product:1");
  });
});

describe("buildFacetGroups", () => {
  const counts = [
    { axis: "color", value: "black", count: 340 },
    { axis: "color", value: "white", count: 193 },
    { axis: "color", value: "blue", count: 121 },
    { axis: "size", value: "m", count: 200 },
  ];

  it("groups by axis with counts", () => {
    const groups = buildFacetGroups(counts, EMPTY_SEARCH_FILTERS);
    const color = groups.find((group) => group.key === "color");
    expect(color?.values.map((value) => value.value)).toEqual(["black", "white", "blue"]);
    expect(color?.values[0]!.count).toBe(340);
  });

  it("orders groups predictably, colour before size", () => {
    const groups = buildFacetGroups(counts, EMPTY_SEARCH_FILTERS);
    // A facet list that reorders itself between requests feels broken.
    expect(groups.map((group) => group.key)).toEqual(["color", "size"]);
  });

  it("labels axes readably", () => {
    const groups = buildFacetGroups(
      [{ axis: "screen_size", value: "15in", count: 5 }],
      EMPTY_SEARCH_FILTERS,
    );
    expect(groups[0]!.label).toBe("Screen size");
  });

  it("keeps selected values in the list and flags them", () => {
    // A facet that disappears when you tick it looks broken.
    const filters: SearchFilters = { ...EMPTY_SEARCH_FILTERS, attributes: { color: ["blue"] } };
    const groups = buildFacetGroups(counts, filters);
    const color = groups.find((group) => group.key === "color")!;
    expect(color.values[0]!.value).toBe("blue");
    expect(color.values[0]!.selected).toBe(true);
  });

  it("respects the value cap", () => {
    const many = Array.from({ length: 200 }, (_unused, index) => ({
      axis: "color",
      value: `c${index}`,
      count: 200 - index,
    }));
    const groups = buildFacetGroups(many, EMPTY_SEARCH_FILTERS, { maxValues: 10 });
    expect(groups[0]!.values).toHaveLength(10);
  });
});

describe("buildPriceFacet", () => {
  it("returns null for no products", () => {
    expect(buildPriceFacet([], EMPTY_SEARCH_FILTERS)).toBeNull();
  });

  it("buckets observed prices", () => {
    const facet = buildPriceFacet(
      [{ pricePaise: 50_000 }, { pricePaise: 250_000 }, { pricePaise: 1_500_000 }],
      EMPTY_SEARCH_FILTERS,
    );
    expect(facet?.minPaise).toBe(50_000);
    expect(facet?.maxPaise).toBe(1_500_000);
    // Only non-empty buckets are returned: an empty one is a dead control.
    expect(facet!.buckets.every((bucket) => bucket.count > 0)).toBe(true);
  });

  it("assigns each price to exactly one bucket", () => {
    const prices = [99_999, 100_000, 499_999, 500_000];
    const facet = buildPriceFacet(prices.map((pricePaise) => ({ pricePaise })), EMPTY_SEARCH_FILTERS);
    const total = facet!.buckets.reduce((sum, bucket) => sum + bucket.count, 0);
    expect(total).toBe(prices.length);
  });
});

describe("buildFacets", () => {
  it("combines groups, price, and total", () => {
    const facets = buildFacets({
      counts: [{ axis: "color", value: "black", count: 10 }],
      prices: [{ pricePaise: 100_000 }],
      filters: EMPTY_SEARCH_FILTERS,
      total: 42,
    });
    expect(facets.groups).toHaveLength(1);
    expect(facets.price).not.toBeNull();
    expect(facets.total).toBe(42);
  });
});

describe("activeFilterChips", () => {
  it("produces a removable chip per active filter", () => {
    const filters: SearchFilters = {
      ...EMPTY_SEARCH_FILTERS,
      brandIds: ["br-1"],
      minPricePaise: 100_000,
      attributes: { color: ["black"] },
    };
    const chips = activeFilterChips(filters, { brands: { "br-1": "Nike" } });
    expect(chips.map((chip) => chip.axis).sort()).toEqual(["brand", "color", "price"]);
    expect(chips.find((chip) => chip.axis === "brand")?.value).toBe("Nike");
  });

  it("gives each chip a URL that removes only that filter", () => {
    const filters: SearchFilters = {
      ...EMPTY_SEARCH_FILTERS,
      brandIds: ["br-1"],
      attributes: { color: ["black"] },
    };
    const chips = activeFilterChips(filters, {}, { q: "shoes" });
    const brandChip = chips.find((chip) => chip.axis === "brand")!;
    // Removing the brand must leave the colour filter intact.
    expect(brandChip.removeHref).toContain("attr.color=black");
    expect(brandChip.removeHref).not.toContain("brand=");
  });

  it("returns no chips for empty filters", () => {
    expect(activeFilterChips(EMPTY_SEARCH_FILTERS)).toEqual([]);
  });
});

describe("hasActiveSearchFilters", () => {
  it("is false for the empty filter set", () => {
    expect(hasActiveSearchFilters(EMPTY_SEARCH_FILTERS)).toBe(false);
  });

  it("detects each filter kind", () => {
    expect(hasActiveSearchFilters({ ...EMPTY_SEARCH_FILTERS, brandIds: ["a"] })).toBe(true);
    expect(hasActiveSearchFilters({ ...EMPTY_SEARCH_FILTERS, minPricePaise: 1 })).toBe(true);
    expect(hasActiveSearchFilters({ ...EMPTY_SEARCH_FILTERS, minRating: 4 })).toBe(true);
    expect(hasActiveSearchFilters({ ...EMPTY_SEARCH_FILTERS, availability: "in_stock" })).toBe(true);
    expect(hasActiveSearchFilters({ ...EMPTY_SEARCH_FILTERS, onSaleOnly: true })).toBe(true);
    expect(
      hasActiveSearchFilters({ ...EMPTY_SEARCH_FILTERS, attributes: { color: ["black"] } }),
    ).toBe(true);
  });

  it("ignores an attribute axis with no values", () => {
    expect(hasActiveSearchFilters({ ...EMPTY_SEARCH_FILTERS, attributes: { color: [] } })).toBe(false);
  });
});
