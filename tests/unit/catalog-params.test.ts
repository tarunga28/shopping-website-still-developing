import { describe, expect, it } from "vitest";
import {
  activeFilterCount,
  buildCatalogHref,
  parseApiCatalogParams,
  parseCatalogSearchParams,
  serializeFilters,
} from "@/lib/catalog/params";
import { MAX_FILTER_VALUES, MAX_PAGE, MAX_PAGE_SIZE } from "@/lib/catalog/constants";

const parse = (query: string) => parseCatalogSearchParams(new URLSearchParams(query)).filters;

describe("catalog query parameters", () => {
  it("uses safe defaults for an empty query", () => {
    const filters = parse("");
    expect(filters).toMatchObject({ sort: "featured", page: 1, type: null, sizes: [], colors: [], availableOnly: false });
    expect(filters.minPricePaise).toBeNull();
    expect(filters.maxPricePaise).toBeNull();
  });

  it.each([
    ["sort=hack", "featured"],
    ["sort=PRICE-ASC", "price-asc"],
    ["sort=price-desc", "price-desc"],
    ["sort=;drop table products", "featured"],
  ])("normalises %s", (query, sort) => {
    expect(parse(query).sort).toBe(sort);
  });

  it("ignores invalid sizes, keeps valid ones uppercase and ordered", () => {
    expect(parse("size=INVALID").sizes).toEqual([]);
    expect(parse("size=xl&size=s&size=m").sizes).toEqual(["S", "M", "XL"]);
    expect(parse("size=M,L,nope").sizes).toEqual(["M", "L"]);
  });

  it("drops duplicate values and caps multi-value lists", () => {
    expect(parse("size=M&size=m&size=M").sizes).toEqual(["M"]);
    const many = Array.from({ length: 30 }, (_, index) => `color=c${index}`).join("&");
    expect(parse(many).colors.length).toBeLessThanOrEqual(MAX_FILTER_VALUES);
  });

  it("lowercases and validates colours", () => {
    expect(parse("color=Black").colors).toEqual(["black"]);
    expect(parse("color=<script>").colors).toEqual([]);
    expect(parse("color=../../x").colors).toEqual([]);
  });

  it("parses prices as integer paise and ignores garbage", () => {
    const filters = parse("minPrice=500&maxPrice=1999.50");
    expect(filters.minPricePaise).toBe(50_000);
    expect(filters.maxPricePaise).toBe(199_950);
    expect(parse("minPrice=hello").minPricePaise).toBeNull();
    expect(parse("minPrice=-5").minPricePaise).toBeNull();
    expect(parse("maxPrice=1e9").maxPricePaise).toBeNull();
    expect(parse("minPrice=12.345").minPricePaise).toBeNull();
  });

  it("swaps a reversed price range instead of returning nothing", () => {
    const filters = parse("minPrice=900&maxPrice=100");
    expect(filters.minPricePaise).toBe(10_000);
    expect(filters.maxPricePaise).toBe(90_000);
  });

  it("clamps pages and rejects non-numeric pages", () => {
    expect(parse("page=abc").page).toBe(1);
    expect(parse("page=-3").page).toBe(1);
    expect(parse("page=0").page).toBe(1);
    expect(parse("page=2.5").page).toBe(1);
    expect(parse("page=4").page).toBe(4);
    expect(parse(`page=${MAX_PAGE + 1}`).page).toBe(1);
  });

  it("only honours a well-formed category slug", () => {
    expect(parse("category=Hoodies").category).toBe("hoodies");
    expect(parse("category=../../x").category).toBeNull();
    expect(parse("category=a%20b").category).toBeNull();
  });

  it("accepts productType as an alias of type and rejects unknown types", () => {
    expect(parse("type=hoodie").type).toBe("HOODIE");
    expect(parse("productType=mug").type).toBe("MUG");
    expect(parse("type=nonsense").type).toBeNull();
  });

  it("flags unknown keys so SEO can noindex them", () => {
    const parsed = parseCatalogSearchParams(new URLSearchParams("utm_source=x&sort=newest"));
    expect(parsed.unknownKeys).toEqual(["utm_source"]);
    expect(parsed.hasNonPageParams).toBe(true);
  });

  it("accepts Next-style object search params (arrays)", () => {
    const parsed = parseCatalogSearchParams({ size: ["S", "L"], sort: "newest", page: undefined });
    expect(parsed.filters.sizes).toEqual(["S", "L"]);
    expect(parsed.filters.sort).toBe("newest");
  });
});

describe("catalog URL building", () => {
  it("serialises equal states identically regardless of input order", () => {
    const a = parse("size=L&size=S&color=red&color=black&sort=newest");
    const b = parse("sort=newest&color=black,red&size=S,L");
    expect(serializeFilters(a)).toBe(serializeFilters(b));
    expect(serializeFilters(a)).toBe("size=S,L&color=black,red&sort=newest");
  });

  it("omits defaults and resets to page 1 when the listing changes", () => {
    const filters = parse("page=3&sort=newest");
    expect(buildCatalogHref("/shop", filters, { type: "MUG" })).toBe("/shop?type=mug&sort=newest");
    expect(buildCatalogHref("/shop", filters, { page: 4 })).toBe("/shop?sort=newest&page=4");
    expect(buildCatalogHref("/shop", parse(""), {})).toBe("/shop");
  });

  it("counts a price range as one active filter", () => {
    expect(activeFilterCount(parse("minPrice=1&maxPrice=9&size=S,M&availability=available"))).toBe(4);
  });
});

describe("public API parameters", () => {
  it("caps the page size", () => {
    expect(parseApiCatalogParams(new URLSearchParams("pageSize=100000")).pageSize).toBe(MAX_PAGE_SIZE);
    expect(parseApiCatalogParams(new URLSearchParams("pageSize=0")).pageSize).toBeGreaterThan(0);
    expect(parseApiCatalogParams(new URLSearchParams("pageSize=abc")).pageSize).toBeGreaterThan(0);
  });

  it("validates category and collection slugs", () => {
    const params = parseApiCatalogParams(new URLSearchParams("category=Hoodies&collection=../../x"));
    expect(params.category).toBe("hoodies");
    expect(params.collection).toBeNull();
  });
});
