import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", () => ({
  getOptionalUser: vi.fn(),
}));

vi.mock("@/services/wishlist.service", () => ({
  listWishlistProductIds: vi.fn(),
}));

vi.mock("@/services/catalog.service", () => ({
  getCollectionBySlug: vi.fn(),
  listActiveCollections: vi.fn(),
  listActiveProductSummaries: vi.fn(),
  listApprovedReviews: vi.fn(),
  listProductsByCollectionSlug: vi.fn(),
  listStorefrontCategories: vi.fn(),
  searchActiveProducts: vi.fn(),
}));

import { loadSection } from "@/services/storefront.service";

describe("homepage loader isolation", () => {
  it("turns a failed query into a section error instead of throwing", async () => {
    const result = await loadSection("products", async () => {
      throw new Error("connection refused");
    }, []);
    expect(result).toEqual({ data: [], status: "error" });
  });

  it("marks an empty successful query as empty", async () => {
    const result = await loadSection("reviews", async () => [], []);
    expect(result.status).toBe("empty");
  });
});
