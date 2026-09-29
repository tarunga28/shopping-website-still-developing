import { describe, expect, it } from "vitest";
import { ancestorsOf, buildPublicCategories, descendantIds, type CategoryRow } from "@/lib/catalog/category-tree";
import { buildFacetView, hasVisibleFacets, NO_FACETS } from "@/lib/catalog/facets-view";
import { buildPageWindow, buildPaginationMeta } from "@/lib/catalog/pagination";
import { EMPTY_FILTERS } from "@/lib/catalog/params";

const row = (id: string, parentId: string | null, isActive = true): CategoryRow => ({
  id,
  parentId,
  slug: id,
  name: id.toUpperCase(),
  description: null,
  seoTitle: null,
  seoDescription: null,
  displayOrder: 0,
  isActive,
  image: null,
});

describe("category tree", () => {
  it("hides inactive categories and everything below them", () => {
    const tree = buildPublicCategories([row("a", null), row("b", "a", false), row("c", "b"), row("d", "a")]);
    expect(tree.map((category) => category.id).sort()).toEqual(["a", "d"]);
  });

  it("resolves descendants and ancestors without recursion in the DB", () => {
    const tree = buildPublicCategories([row("a", null), row("b", "a"), row("c", "b")]);
    expect(descendantIds(tree, "a").sort()).toEqual(["a", "b", "c"]);
    expect(ancestorsOf(tree, "c").map((category) => category.id)).toEqual(["a", "b"]);
  });

  it("survives cycles", () => {
    const tree = buildPublicCategories([row("a", "b"), row("b", "a")]);
    expect(tree).toEqual([]);
  });

  it("never exposes the isActive flag", () => {
    const [category] = buildPublicCategories([row("a", null)]);
    expect(category).not.toHaveProperty("isActive");
  });
});

describe("pagination meta", () => {
  it("computes the displayed range from real counts", () => {
    expect(buildPaginationMeta({ page: 2, pageSize: 24, total: 50, count: 24 })).toMatchObject({ from: 25, to: 48, totalPages: 3 });
    expect(buildPaginationMeta({ page: 3, pageSize: 24, total: 50, count: 2 })).toMatchObject({ from: 49, to: 50 });
    expect(buildPaginationMeta({ page: 1, pageSize: 24, total: 0, count: 0 })).toMatchObject({ from: 0, to: 0, totalPages: 1 });
  });

  it("builds a [1 … 4 5 6 … 10] window", () => {
    expect(buildPageWindow(1, 1)).toEqual([1]);
    expect(buildPageWindow(1, 3)).toEqual([1, 2, 3]);
    expect(buildPageWindow(5, 10)).toEqual([1, "ellipsis-start", 4, 5, 6, "ellipsis-end", 10]);
    expect(buildPageWindow(1, 10)).toEqual([1, 2, "ellipsis-end", 10]);
    expect(buildPageWindow(10, 10)).toEqual([1, "ellipsis-start", 9, 10]);
  });
});

describe("filter facets view", () => {
  const raw = {
    types: [{ value: "T_SHIRT", count: 3 }],
    sizes: [{ value: "M", label: "M", count: 3 }],
    colors: [{ value: "black", label: "Black", count: 3 }],
    price: { minPaise: 50_000, maxPaise: 50_000 },
    availability: { available: 3, total: 3 },
  };

  it("hides groups with nothing to choose between", () => {
    const view = buildFacetView(raw, EMPTY_FILTERS);
    expect(view).toEqual(NO_FACETS);
    expect(hasVisibleFacets(view)).toBe(false);
  });

  it("is product-type aware: only offers what the listing actually has", () => {
    const view = buildFacetView(
      {
        ...raw,
        types: [
          { value: "T_SHIRT", count: 2 },
          { value: "MUG", count: 1 },
        ],
        sizes: [],
        price: { minPaise: 30_000, maxPaise: 90_000 },
      },
      EMPTY_FILTERS,
    );
    expect(view.types.map((type) => type.value)).toEqual(["t-shirt", "mug"]);
    expect(view.sizes).toEqual([]);
    expect(view.price).toEqual({ minLabel: "300", maxLabel: "900" });
  });

  it("keeps a selected value visible so it can be undone", () => {
    const view = buildFacetView(raw, { ...EMPTY_FILTERS, sizes: ["XL"] });
    expect(view.sizes.map((size) => size.value)).toContain("XL");
  });
});
