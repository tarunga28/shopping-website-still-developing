import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/catalog.service", () => ({
  listSitemapProducts: vi.fn(),
  listStorefrontCategories: vi.fn(),
  listActiveCollections: vi.fn(),
}));

describe("sitemap", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("still returns static routes when the catalogue API fails", async () => {
    const catalog = await import("@/services/catalog.service");
    vi.mocked(catalog.listSitemapProducts).mockRejectedValue(new Error("database down"));
    vi.mocked(catalog.listStorefrontCategories).mockRejectedValue(new Error("database down"));
    vi.mocked(catalog.listActiveCollections).mockRejectedValue(new Error("database down"));

    const { default: sitemap } = await import("@/app/sitemap");
    const routes = await sitemap();
    const paths = routes.map((route) => new URL(route.url).pathname);
    expect(paths).toEqual(expect.arrayContaining(["/", "/shop", "/search", "/faqs", "/legal/privacy"]));
    expect(paths.some((path) => path.startsWith("/product/"))).toBe(false);
  });
});
