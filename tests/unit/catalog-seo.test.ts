import { describe, expect, it } from "vitest";
import { catalogCanonicalPath, catalogMetadata, isIndexableCatalogUrl } from "@/lib/catalog/seo";
import { parseCatalogSearchParams } from "@/lib/catalog/params";

const parsed = (query: string) => parseCatalogSearchParams(new URLSearchParams(query));
const meta = (query: string, page = 1, totalPages = 5) =>
  catalogMetadata({
    basePath: "/category/hoodies",
    title: "Hoodies",
    description: "Warm hoodies.",
    parsed: parsed(query),
    page,
    totalPages,
  });

describe("catalog SEO", () => {
  it("indexes the clean URL with a self canonical", () => {
    const metadata = meta("");
    expect(metadata.robots).toBeUndefined();
    expect(metadata.alternates?.canonical).toBe("http://localhost:3000/category/hoodies");
  });

  it("indexes deep pages only for plain ?page=N and links prev/next", () => {
    expect(isIndexableCatalogUrl(parsed("page=3"))).toBe(true);
    const metadata = meta("page=3", 3, 5);
    expect(metadata.alternates?.canonical).toBe("http://localhost:3000/category/hoodies?page=3");
    expect(metadata.pagination?.previous).toBe("http://localhost:3000/category/hoodies?page=2");
    expect(metadata.pagination?.next).toBe("http://localhost:3000/category/hoodies?page=4");
    expect(meta("page=2", 2, 5).pagination?.previous).toBe("http://localhost:3000/category/hoodies");
  });

  it.each([
    "page=1",
    "page=03",
    "page=abc",
    "sort=price-asc",
    "size=M",
    "color=black&page=2",
    "utm_source=newsletter",
    "sort=hack",
    "minPrice=hello",
  ])("noindexes and canonicalises %s to the clean URL", (query) => {
    const value = parsed(query);
    expect(isIndexableCatalogUrl(value)).toBe(false);
    expect(catalogCanonicalPath("/shop", value)).toBe("/shop");
    const metadata = meta(query);
    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.alternates?.canonical).toBe("http://localhost:3000/category/hoodies");
    expect(metadata.pagination).toBeUndefined();
  });

  it("includes Open Graph and Twitter metadata", () => {
    const metadata = meta("");
    expect(metadata.openGraph?.url).toBe("http://localhost:3000/category/hoodies");
    expect(metadata.twitter).toBeDefined();
  });
});
