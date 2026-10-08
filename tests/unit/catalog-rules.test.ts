import { describe, expect, it } from "vitest";
import {
  assertCompareAt,
  assertVariantForType,
  assertBulkInventoryConfirmation,
  bulkInventoryPhrase,
  bulkPhrase,
  canAcceptPurchase,
  canArchiveCategory,
  canEditCatalog,
  duplicateSku,
  duplicateVariantCombos,
  estimateGrossMargin,
  isPubliclyListed,
  isPubliclyViewable,
  parseInrToPaise,
  planSlugChange,
  publishBlockers,
  quoteAuthoritativePrice,
  slugFromName,
  tagSlug,
  toPublicProduct,
  wouldCreateCategoryCycle,
} from "@/lib/catalog-rules";
import { inspectProductImage } from "@/lib/image-file";
import { normalizeImportProduct, normalizeImportVariant } from "@/lib/catalog-import";

function png(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  buffer.write("\x89PNG\r\n\x1a\n", 0, "binary");
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

const ready = {
  name: "Grid Tee",
  description: "A printed tee.",
  shortDescription: null,
  slug: "grid-tee",
  pricePaise: 89900,
  compareAtPaise: 99900,
  imageCount: 1,
  categoryCount: 1,
  variantCount: 1,
  productType: "T_SHIRT" as const,
  supplierMappingRequired: false,
  supplierMapped: false,
};

describe("catalog permissions", () => {
  it("allows product managers, admins and super admins only", () => {
    expect(canEditCatalog("PRODUCT_MANAGER")).toBe(true);
    expect(canEditCatalog("ADMIN")).toBe(true);
    expect(canEditCatalog("SUPER_ADMIN")).toBe(true);
    expect(canEditCatalog("CUSTOMER")).toBe(false);
    expect(canEditCatalog("SUPPORT")).toBe(false);
    expect(canEditCatalog("ORDER_MANAGER")).toBe(false);
    expect(canEditCatalog(null)).toBe(false);
  });
});

describe("product visibility", () => {
  it("lists only active products and hides drafts and archives", () => {
    expect(isPubliclyListed("ACTIVE")).toBe(true);
    expect(isPubliclyListed("DRAFT")).toBe(false);
    expect(isPubliclyListed("ARCHIVED")).toBe(false);
    expect(isPubliclyViewable("DISCONTINUED")).toBe(true);
    expect(isPubliclyViewable("DRAFT")).toBe(false);
    expect(canAcceptPurchase("ACTIVE", "IN_STOCK")).toBe(true);
    expect(canAcceptPurchase("DISCONTINUED", "IN_STOCK")).toBe(false);
    expect(canAcceptPurchase("ARCHIVED", "IN_STOCK")).toBe(false);
  });

  it("strips private fields from a public product", () => {
    const view = toPublicProduct({
      slug: "grid-tee",
      name: "Grid Tee",
      description: "Printed after order.",
      pricePaise: 89900,
      compareAtPaise: null,
      currency: "INR",
      status: "ACTIVE",
      availability: "AVAILABLE",
      sku: "INK-TEE-BLK-M",
      adminNotes: "secret",
      supplierCostPaise: 20000,
      supplierVariantId: "sup-1",
    });
    expect(view).not.toHaveProperty("adminNotes");
    expect(view).not.toHaveProperty("supplierCostPaise");
    expect(JSON.stringify(view)).not.toContain("secret");
    expect(toPublicProduct({ ...view!, status: "DRAFT", availability: "UNAVAILABLE", sku: null })).toBeNull();
  });
});

describe("prices", () => {
  it("parses rupees into paise without floating-point math", () => {
    expect(parseInrToPaise("999")).toBe(99900);
    expect(parseInrToPaise("999.50")).toBe(99950);
    expect(parseInrToPaise("₹1,299.00")).toBe(129900);
    expect(() => parseInrToPaise("-1")).toThrow(/price/i);
    expect(() => parseInrToPaise("10.999")).toThrow(/price/i);
  });

  it("rejects a compare-at price below the selling price", () => {
    expect(() => assertCompareAt(1000, 900)).toThrow(/compare-at/i);
    expect(() => assertCompareAt(1000, 1000)).not.toThrow();
    expect(() => assertCompareAt(-1, null)).toThrow(/negative/i);
  });

  it("ignores a client price and does not call the estimate profit", () => {
    const quote = quoteAuthoritativePrice({ serverPricePaise: 89900, clientPricePaise: 100 });
    expect(quote.pricePaise).toBe(89900);
    expect(quote.clientPriceIgnored).toBe(true);
    expect(quote.mismatch).toBe(true);
    const margin = estimateGrossMargin({
      sellingPaise: 100000,
      supplierCostPaise: 40000,
      shippingPaise: 5000,
      paymentFeePaise: 2000,
      discountPaise: 0,
    });
    expect(margin.label).toBe("estimated_gross_margin");
    expect(margin.estimatedGrossMarginPaise).toBe(53000);
    expect(estimateGrossMargin({ sellingPaise: 100000, supplierCostPaise: null, shippingPaise: 0, paymentFeePaise: 0, discountPaise: 0 }).complete).toBe(false);
  });
});

describe("variants", () => {
  it("blocks duplicate combinations and clothing sizes on a mug", () => {
    expect(duplicateVariantCombos([{ size: "M", color: "Black" }, { size: "m", color: "black" }])).toHaveLength(1);
    expect(() => assertVariantForType("MUG", "M")).toThrow(/size/i);
    expect(() => assertVariantForType("T_SHIRT", null)).toThrow(/size/i);
    expect(() => assertVariantForType("T_SHIRT", "M")).not.toThrow();
    expect(() => assertVariantForType("POSTER", null)).not.toThrow();
  });

  it("gives a duplicate product a new sku", () => {
    expect(duplicateSku("INK-TEE-BLK-M", "abc123")).toBe("INK-TEE-BLK-M-COPY-ABC123");
    expect(planSlugChange("old-slug", "new-slug").recordPrevious).toBe(true);
    expect(planSlugChange("same", "same").changed).toBe(false);
  });
});

describe("publishing and categories", () => {
  it("blocks an incomplete product from publishing", () => {
    expect(publishBlockers(ready)).toEqual([]);
    expect(publishBlockers({ ...ready, imageCount: 0 })[0]).toMatch(/image/i);
    expect(publishBlockers({ ...ready, supplierMappingRequired: true, supplierMapped: false })[0]).toMatch(/supplier/i);
  });

  it("refuses to archive a category that still has active products", () => {
    expect(canArchiveCategory(2, null, "cat").ok).toBe(false);
    expect(canArchiveCategory(2, "other", "cat").ok).toBe(true);
    expect(canArchiveCategory(0, null, "cat").ok).toBe(true);
    expect(wouldCreateCategoryCycle("a", "a", new Map())).toBe(true);
    expect(wouldCreateCategoryCycle("a", "b", new Map([["b", "a"]]))).toBe(true);
  });

  it("requires an exact bulk confirmation", () => {
    expect(bulkPhrase("ARCHIVE", 3)).toBe("ARCHIVE 3");
  });

  // A bulk stock change is the one bulk action that can silently corrupt the
  // catalog, so it gets the same typed gate and the phrase names the operation.
  it("names the operation in the bulk inventory confirmation phrase", () => {
    expect(bulkInventoryPhrase("STOCK_IN", 12)).toBe("STOCK_IN 12");
    expect(bulkInventoryPhrase("DAMAGE", 1)).toBe("DAMAGE 1");
    expect(bulkInventoryPhrase("STOCK_IN", 12)).not.toBe(bulkInventoryPhrase("DAMAGE", 12));
  });

  it("accepts a matching bulk inventory confirmation and rejects a mismatch", () => {
    expect(() => assertBulkInventoryConfirmation("STOCK_IN", 12, "STOCK_IN 12")).not.toThrow();
    // Confirming a different operation must not authorise this one.
    expect(() => assertBulkInventoryConfirmation("DAMAGE", 12, "STOCK_IN 12")).toThrow(/did not match/);
    expect(() => assertBulkInventoryConfirmation("STOCK_IN", 12, "STOCK_IN 13")).toThrow(/did not match/);
    expect(() => assertBulkInventoryConfirmation("STOCK_IN", 12, "")).toThrow(/did not match/);
  });

  it("caps bulk inventory batches and rejects an empty or fractional count", () => {
    expect(() => assertBulkInventoryConfirmation("STOCK_IN", 100, "STOCK_IN 100")).not.toThrow();
    expect(() => assertBulkInventoryConfirmation("STOCK_IN", 101, "STOCK_IN 101")).toThrow(/limited to 100/);
    expect(() => assertBulkInventoryConfirmation("STOCK_IN", 0, "STOCK_IN 0")).toThrow(/limited to 100/);
    expect(() => assertBulkInventoryConfirmation("STOCK_IN", -5, "STOCK_IN -5")).toThrow(/limited to 100/);
    expect(() => assertBulkInventoryConfirmation("STOCK_IN", 2.5, "STOCK_IN 2.5")).toThrow(/limited to 100/);
  });
});

describe("slugs and tags", () => {
  it("builds a stable lowercase slug and a case-insensitive tag key", () => {
    expect(slugFromName("Offbeat Grid Tee")).toBe("offbeat-grid-tee");
    expect(tagSlug("Minimal")).toBe(tagSlug("minimal"));
  });
});

describe("images", () => {
  it("accepts a real png and rejects a mismatched or dangerous file", () => {
    const image = inspectProductImage(png(800, 800), "image/png");
    expect(image.mime).toBe("image/png");
    expect(image.width).toBe(800);
    expect(() => inspectProductImage(Buffer.from("<svg></svg>"), "image/svg+xml")).toThrow(/jpg, png, or webp/i);
    expect(() => inspectProductImage(Buffer.from("not-an-image"), "image/png")).toThrow(/contents/i);
    expect(() => inspectProductImage(png(10, 10), "image/png")).toThrow(/200/);
    expect(() => inspectProductImage(Buffer.alloc(5_000_000, 1), "image/jpeg")).toThrow(/4 MB/);
  });
});

describe("import gate", () => {
  it("uses the same validation as manual creation", () => {
    const bad = normalizeImportProduct({ name: "x" });
    expect(bad.ok).toBe(false);
    const variant = normalizeImportVariant({
      sku: "INK-MUG-1",
      name: "Standard",
      price: "499",
      availability: "IN_STOCK",
    });
    expect(variant.ok).toBe(true);
    expect(normalizeImportVariant({ sku: "bad sku", name: "x", price: "1", availability: "IN_STOCK" }).ok).toBe(false);
  });
});
