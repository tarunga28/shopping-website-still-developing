import { describe, expect, it } from "vitest";
import { deriveAvailability } from "@/lib/catalog/availability";
import {
  discountPercent,
  isNewProduct,
  toProductSummary,
  toPublicProductDTO,
  type PublicProductSource,
} from "@/lib/catalog/dto";

const base: PublicProductSource = {
  id: "p1",
  slug: "ink-tee",
  name: "Ink Tee",
  shortDescription: "A tee",
  productType: "T_SHIRT",
  basePricePaise: 79_900,
  compareAtPricePaise: null,
  currency: "INR",
  publishedAt: "2026-09-20T00:00:00Z",
  image: { url: "/images/tee.jpg", alt: null },
  hoverImage: null,
  variants: { variantCount: 3, orderableCount: 2, outOfStockCount: 1 },
  category: { name: "T-Shirts", slug: "t-shirts" },
  collection: null,
  rating: null,
};

describe("PublicProductDTO", () => {
  it("has exactly the public keys and never leaks internal fields", () => {
    // A source polluted with everything that must never reach a customer.
    const polluted = {
      ...base,
      supplierCostPaise: 12_000,
      supplierProductId: "sup_1",
      adminNotes: "internal",
      storageKey: "private/bucket/key.png",
      estimatedProductionCostPaise: 9000,
      createdBy: "admin_1",
      status: "ACTIVE",
    } as PublicProductSource;
    const dto = toPublicProductDTO(polluted, new Date("2026-09-29T00:00:00Z"));
    expect(Object.keys(dto).sort()).toEqual(
      [
        "availability",
        "category",
        "collection",
        "hoverImage",
        "id",
        "image",
        "isNew",
        "name",
        "price",
        "productType",
        "productTypeLabel",
        "rating",
        "shortDescription",
        "slug",
      ].sort(),
    );
    expect(Object.keys(dto.price).sort()).toEqual(["amountPaise", "compareAtPaise", "currency", "discountPercent"]);
    const json = JSON.stringify(dto);
    for (const secret of ["supplier", "adminNotes", "storageKey", "estimated", "createdBy", "internal", "private/bucket"]) {
      expect(json).not.toContain(secret);
    }
  });

  it("falls back to the product name for missing alt text", () => {
    expect(toPublicProductDTO(base).image.alt).toBe("Ink Tee");
  });

  it("only reports a discount when compare-at is genuinely higher", () => {
    expect(discountPercent(79_900, null)).toBeNull();
    expect(discountPercent(79_900, 79_900)).toBeNull();
    expect(discountPercent(79_900, 50_000)).toBeNull();
    expect(discountPercent(75_000, 100_000)).toBe(25);
    expect(discountPercent(79_900.5, 100_000)).toBeNull();
  });

  it("never fabricates a rating", () => {
    expect(toPublicProductDTO(base).rating).toBeNull();
    expect(toPublicProductDTO({ ...base, rating: { average: 5, count: 0 } }).rating).toBeNull();
    expect(toPublicProductDTO({ ...base, rating: { average: 4.5, count: 12 } }).rating).toEqual({ average: 4.5, count: 12 });
  });

  it("marks New only from a real, recent publish date", () => {
    const now = new Date("2026-09-29T00:00:00Z");
    expect(isNewProduct("2026-09-20T00:00:00Z", now)).toBe(true);
    expect(isNewProduct("2026-01-01T00:00:00Z", now)).toBe(false);
    expect(isNewProduct(null, now)).toBe(false);
    expect(isNewProduct("2027-01-01T00:00:00Z", now)).toBe(false);
    expect(isNewProduct("not a date", now)).toBe(false);
  });

  it("adapts to the card model without inventing stock claims", () => {
    const summary = toProductSummary(toPublicProductDTO({ ...base, variants: undefined }));
    expect(summary.availability).toBeUndefined();
    expect(summary.pricePaise).toBe(79_900);
    expect(summary.compareAtPaise).toBeUndefined();
  });
});

describe("availability", () => {
  it("never invents stock", () => {
    expect(deriveAvailability(undefined)).toBe("UNKNOWN");
    expect(deriveAvailability({ variantCount: 0, orderableCount: 0, outOfStockCount: 0 })).toBe("UNKNOWN");
    expect(deriveAvailability({ variantCount: 3, orderableCount: 1, outOfStockCount: 2 })).toBe("AVAILABLE");
    expect(deriveAvailability({ variantCount: 3, orderableCount: 0, outOfStockCount: 3 })).toBe("UNAVAILABLE");
    // Only pre-order variants: checkout can't sell them, and we don't guess.
    expect(deriveAvailability({ variantCount: 2, orderableCount: 0, outOfStockCount: 0 })).toBe("UNKNOWN");
  });
});
