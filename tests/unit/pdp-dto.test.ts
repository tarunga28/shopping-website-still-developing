import { describe, expect, it } from "vitest";
import { buildProductBreadcrumbs, similarProductsHref } from "@/lib/catalog/pdp-breadcrumbs";
import {
  safeHex,
  toPdpProductDTO,
  uniqueAltTexts,
  variantState,
  type PdpProductSource,
} from "@/lib/catalog/pdp-dto";
import { EMPTY_PRODUCT_DETAILS, parseProductDetails, productDetailsSchema, textToSpecs } from "@/lib/catalog/product-details";
import { parseSizeChart } from "@/lib/catalog/size-chart";
import { breadcrumbJsonLd, productJsonLd, productMetadata } from "@/lib/seo";

function source(overrides: Partial<PdpProductSource> = {}): PdpProductSource {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "ember-hoodie",
    name: "Ember Hoodie",
    shortDescription: "Warm.",
    description: "Line one.\n\nLine two <script>alert(1)</script> here.",
    productType: "HOODIE",
    basePricePaise: 199_900,
    compareAtPricePaise: 249_900,
    currency: "INR",
    publishedAt: new Date(),
    seoTitle: null,
    seoDescription: null,
    details: null,
    variants: [
      { id: "v1", sku: "EH-BLA-M", name: "Black / M", size: "M", color: "Black", colorCode: "#16130E", pricePaise: 199_900, compareAtPaise: 249_900, availability: "IN_STOCK" },
      { id: "v2", sku: "EH-BLA-S", name: "Black / S", size: "S", color: "black", colorCode: "not-a-colour", pricePaise: 199_900, compareAtPaise: null, availability: "OUT_OF_STOCK" },
      { id: "v3", sku: "EH-ECR-M", name: "Ecru / M", size: "M", color: "Ecru", colorCode: null, pricePaise: 189_900, compareAtPaise: null, availability: "PREORDER" },
      { id: "v4", sku: "EH-ZERO", name: "Bad", size: "L", color: "Black", colorCode: null, pricePaise: 0, compareAtPaise: null, availability: "IN_STOCK" },
    ],
    images: [
      { url: "/a.jpg", altText: "Ember Hoodie", width: 1200, height: 1500, role: "GALLERY", sortOrder: 2, variantId: null, type: "PRODUCT" },
      { url: "/p.jpg", altText: "Ember Hoodie", width: 0, height: null, role: "PRIMARY", sortOrder: 1, variantId: null, type: "PRODUCT" },
      { url: "/ecru.jpg", altText: "Ember Hoodie in ecru", width: 1200, height: 1500, role: "GALLERY", sortOrder: 3, variantId: "v3", type: "PRODUCT" },
      { url: "javascript:alert(1)", altText: "x", width: null, height: null, role: "GALLERY", sortOrder: 4, variantId: null, type: "PRODUCT" },
      { url: "/social.jpg", altText: "", width: null, height: null, role: "SOCIAL", sortOrder: 5, variantId: null, type: "PRODUCT" },
      { url: "/cat.jpg", altText: "", width: null, height: null, role: "PRIMARY", sortOrder: 0, variantId: null, type: "CATEGORY" },
    ],
    colorCatalog: [
      { name: "Black", hex: "#16130e", displayOrder: 1 },
      { name: "Ecru", hex: "#efe9db", displayOrder: 2 },
    ],
    categoryTrail: [{ name: "Apparel", slug: "apparel" }, { name: "Hoodies", slug: "hoodies" }],
    collection: { name: "Best Sellers", slug: "best-sellers" },
    designs: [{ name: "Ember", placements: ["Front"] }],
    sizeChart: null,
    rating: null,
    ...overrides,
  };
}

describe("public product-detail DTO", () => {
  it("contains only whitelisted fields — no supplier cost, notes, keys or design ids", () => {
    const hostile = {
      ...source(),
      adminNotes: "SECRET-NOTE",
      supplierCost: 12345,
      estimatedShippingPaise: 7777,
      printFileKey: "private/key.png",
      storageKey: "private/img",
      designId: "d-1",
    } as PdpProductSource;
    const dto = toPdpProductDTO(hostile);
    const json = JSON.stringify(dto);
    for (const leak of ["SECRET-NOTE", "supplierCost", "12345", "7777", "printFileKey", "private/", "storageKey", "designId", "d-1"]) {
      expect(json).not.toContain(leak);
    }
    expect(Object.keys(dto).sort()).toEqual(
      [
        "categoryTrail", "collection", "colors", "currency", "description", "designs", "details", "id", "images", "isNew",
        "name", "price", "productType", "productTypeLabel", "purchasable", "rating", "seo", "shortDescription", "sizeChart",
        "sizes", "slug", "variants",
      ].sort(),
    );
    expect(Object.keys(dto.variants[0]!).sort()).toEqual(["color", "id", "name", "price", "size", "sku", "state"]);
    expect(Object.keys(dto.images[0]!).sort()).toEqual(["alt", "colorKey", "height", "url", "width"]);
    expect(Object.keys(dto.designs[0]!).sort()).toEqual(["name", "placements"]);
  });

  it("maps availability honestly and drops zero-priced variants", () => {
    const dto = toPdpProductDTO(source());
    expect(dto.variants.map((variant) => variant.sku).sort()).toEqual(["EH-BLA-M", "EH-BLA-S", "EH-ECR-M"]);
    const byId = Object.fromEntries(dto.variants.map((variant) => [variant.sku, variant.state]));
    expect(byId).toEqual({ "EH-BLA-M": "AVAILABLE", "EH-BLA-S": "OUT_OF_STOCK", "EH-ECR-M": "UNAVAILABLE" });
    expect(dto.purchasable).toBe(true);
    expect(variantState("LOW_STOCK")).toBe("AVAILABLE");
    expect(variantState("PREORDER")).toBe("UNAVAILABLE");
  });

  it("is not purchasable with zero valid variants or none orderable", () => {
    expect(toPdpProductDTO(source({ variants: [] })).purchasable).toBe(false);
    expect(toPdpProductDTO(source({ variants: source().variants.map((variant) => ({ ...variant, availability: "OUT_OF_STOCK" as const })) })).purchasable).toBe(false);
  });

  it("builds colour options from the colour system, validating any stored hex", () => {
    const dto = toPdpProductDTO(source());
    expect(dto.colors).toEqual([
      { key: "black", label: "Black", hex: "#16130e" },
      { key: "ecru", label: "Ecru", hex: "#efe9db" },
    ]);
    expect(safeHex("#16130E")).toBe("#16130e");
    for (const bad of ["red", "#12", "url(javascript:1)", "#12345g", "", null, undefined, "#16130e; background:url(x)"]) {
      expect(safeHex(bad as string | null)).toBeNull();
    }
    // Unknown colour: falls back to the variant's stored code only when it is a valid hex.
    const dto2 = toPdpProductDTO(
      source({
        colorCatalog: [],
        variants: [
          { id: "a", sku: "A", name: "Teal", size: null, color: "Teal", colorCode: "#008080", pricePaise: 100, compareAtPaise: null, availability: "IN_STOCK" },
          { id: "b", sku: "B", name: "Mauve", size: null, color: "Mauve", colorCode: "bogus", pricePaise: 100, compareAtPaise: null, availability: "IN_STOCK" },
        ],
      }),
    );
    expect(dto2.colors.map((color) => [color.key, color.hex])).toEqual([["mauve", null], ["teal", "#008080"]]);
  });

  it("orders sizes by size scale and only lists sizes the product has", () => {
    const dto = toPdpProductDTO(
      source({
        variants: ["XL", "S", "XXL", "M"].map((size, index) => ({
          id: `s${index}`, sku: `S-${size}`, name: size, size, color: "Black", colorCode: null, pricePaise: 100, compareAtPaise: null, availability: "IN_STOCK" as const,
        })),
      }),
    );
    expect(dto.sizes.map((size) => size.label)).toEqual(["S", "M", "XL", "XXL"]);
  });

  it("shows discount only from stored prices", () => {
    const dto = toPdpProductDTO(source());
    expect(dto.price).toEqual({ amountPaise: 199_900, compareAtPaise: 249_900, discountPercent: 20 });
    expect(dto.variants.find((variant) => variant.sku === "EH-BLA-S")?.price.discountPercent).toBeNull();
    const none = toPdpProductDTO(source({ compareAtPricePaise: null }));
    expect(none.price.compareAtPaise).toBeNull();
    expect(none.price.discountPercent).toBeNull();
    // Compare-at not above price is ignored, not shown as a fake sale.
    expect(toPdpProductDTO(source({ compareAtPricePaise: 199_900 })).price.discountPercent).toBeNull();
  });

  it("orders images, drops unsafe URLs / social / other types, maps variant photos to a colour", () => {
    const dto = toPdpProductDTO(source());
    expect(dto.images.map((image) => image.url)).toEqual(["/p.jpg", "/a.jpg", "/ecru.jpg"]);
    expect(dto.images[2]?.colorKey).toBe("ecru");
    expect(dto.images[0]?.colorKey).toBeNull();
    expect(dto.images[0]?.width).toBeNull(); // 0 is not a real dimension
    expect(dto.seo.image).toBe("/social.jpg");
  });

  it("makes alt texts meaningful and unique", () => {
    expect(uniqueAltTexts("Tee", ["Tee", "Tee", "Tee on model"])).toEqual([
      "Tee – view 1 of 3",
      "Tee – view 2 of 3",
      "Tee on model",
    ]);
    expect(uniqueAltTexts("Tee", [null, "<b>Back</b>"])).toEqual(["Tee", "Back"]);
    const dto = toPdpProductDTO(source());
    expect(new Set(dto.images.map((image) => image.alt)).size).toBe(dto.images.length);
  });

  it("renders description as plain text (no HTML survives)", () => {
    const dto = toPdpProductDTO(source());
    expect(dto.description).not.toContain("<");
    expect(dto.description?.split("\n\n")).toHaveLength(2);
    expect(toPdpProductDTO(source({ description: "   " })).description).toBeNull();
  });

  it("hides designs with no name or placement and never carries coordinates", () => {
    const dto = toPdpProductDTO(source({ designs: [{ name: " ", placements: ["Front"] }, { name: "Ok", placements: [] }, { name: "Good", placements: ["Front", "Back"] }] }));
    expect(dto.designs).toEqual([{ name: "Good", placements: ["Front", "Back"] }]);
  });

  it("only reports a rating when real reviews exist", () => {
    expect(toPdpProductDTO(source({ rating: null })).rating).toBeNull();
    expect(toPdpProductDTO(source({ rating: { average: 4.5, count: 0 } })).rating).toBeNull();
    expect(toPdpProductDTO(source({ rating: { average: 4.5, count: 2 } })).rating).toEqual({ average: 4.5, count: 2 });
  });

  it("handles very long names, colours and SKUs without breaking", () => {
    const long = "W".repeat(300);
    const dto = toPdpProductDTO(
      source({
        name: long,
        variants: [{ id: "a", sku: "SKU-" + "9".repeat(60), name: "x", size: "M", color: long.slice(0, 40), colorCode: null, pricePaise: 100, compareAtPaise: null, availability: "IN_STOCK" }],
      }),
    );
    expect(dto.name).toHaveLength(300);
    expect(dto.colors[0]?.label).toHaveLength(40);
  });
});

describe("product details", () => {
  it("cleans and validates on write", () => {
    const parsed = productDetailsSchema.parse({
      features: ["  Soft <b>fleece</b> ", "Pre-shrunk"],
      materials: "80% cotton",
      fit: "",
      care: ["Wash cold"],
      specs: [{ label: "Weight", value: "320 gsm" }],
    });
    expect(parsed.features[0]).toBe("Soft fleece");
    expect(parsed.fit).toBeNull();
    expect(parsed.printDetails).toBeNull();
    expect(productDetailsSchema.safeParse({ features: Array.from({ length: 50 }, () => "x") }).success).toBe(false);
    expect(productDetailsSchema.safeParse({ specs: [{ label: "", value: "x" }] }).success).toBe(false);
  });

  it("reads untrusted JSON leniently: bad fields are dropped, good ones kept", () => {
    expect(parseProductDetails(null)).toEqual(EMPTY_PRODUCT_DETAILS);
    expect(parseProductDetails("string")).toEqual(EMPTY_PRODUCT_DETAILS);
    expect(parseProductDetails([1, 2])).toEqual(EMPTY_PRODUCT_DETAILS);
    const details = parseProductDetails({
      features: "not-an-array",
      materials: "<img src=x onerror=alert(1)>Cotton",
      care: ["Wash cold", 7],
      specs: [{ label: "A", value: "B" }],
      extra: "ignored",
    });
    expect(details.features).toEqual([]);
    expect(details.materials).toBe("Cotton");
    expect(details.care).toEqual([]);
    expect(details.specs).toEqual([{ label: "A", value: "B" }]);
    expect(details).not.toHaveProperty("extra");
  });

  it("parses spec lines", () => {
    expect(textToSpecs("Weight: 320 gsm\nBad line\nLabel: a: b")).toEqual([
      { label: "Weight", value: "320 gsm" },
      { label: "Label", value: "a: b" },
    ]);
  });
});

describe("size chart", () => {
  const chart = { title: "Hoodie sizes", unit: "cm", columns: ["Size", "Chest"], rows: [["S", "100"], ["M", "106"]], notes: null };
  it("accepts a complete chart", () => {
    expect(parseSizeChart(chart)?.rows).toHaveLength(2);
  });
  it("hides the guide for anything invalid or empty", () => {
    expect(parseSizeChart(null)).toBeNull();
    expect(parseSizeChart({ ...chart, rows: [] })).toBeNull();
    expect(parseSizeChart({ ...chart, rows: [["S"]] })).toBeNull();
    expect(parseSizeChart({ ...chart, unit: "yards" })).toBeNull();
    expect(parseSizeChart({ ...chart, columns: ["Size"] })).toBeNull();
  });
});

describe("breadcrumbs", () => {
  const base = { name: "Ember Hoodie", slug: "ember-hoodie" };
  it("uses the primary category chain", () => {
    const crumbs = buildProductBreadcrumbs({ ...base, categoryTrail: [{ name: "Apparel", slug: "apparel" }, { name: "Hoodies", slug: "hoodies" }], collection: null });
    expect(crumbs.map((crumb) => crumb.label)).toEqual(["Home", "Shop", "Apparel", "Hoodies", "Ember Hoodie"]);
    expect(crumbs.map((crumb) => crumb.path)).toEqual(["/", "/shop", "/category/apparel", "/category/hoodies", "/product/ember-hoodie"]);
  });
  it("falls back to the collection trail, then Shop", () => {
    const viaCollection = buildProductBreadcrumbs({ ...base, categoryTrail: [], collection: { name: "Best Sellers", slug: "best-sellers" } });
    expect(viaCollection.map((crumb) => crumb.path)).toEqual(["/", "/collections", "/collection/best-sellers", "/product/ember-hoodie"]);
    expect(buildProductBreadcrumbs({ ...base, categoryTrail: [], collection: null }).map((crumb) => crumb.label)).toEqual(["Home", "Shop", "Ember Hoodie"]);
  });
  it("prefers the category when both exist (one deterministic trail)", () => {
    const crumbs = buildProductBreadcrumbs({ ...base, categoryTrail: [{ name: "Hoodies", slug: "hoodies" }], collection: { name: "Best Sellers", slug: "best-sellers" } });
    expect(crumbs.some((crumb) => crumb.path.startsWith("/collection"))).toBe(false);
  });
  it("chooses a similar-products target", () => {
    expect(similarProductsHref({ categoryTrail: [{ name: "H", slug: "hoodies" }], collection: null })).toBe("/category/hoodies");
    expect(similarProductsHref({ categoryTrail: [], collection: { name: "C", slug: "c" } })).toBe("/collection/c");
    expect(similarProductsHref({ categoryTrail: [], collection: null })).toBe("/shop");
  });
  it("produces breadcrumb JSON-LD with absolute URLs", () => {
    const ld = breadcrumbJsonLd(buildProductBreadcrumbs({ ...base, categoryTrail: [], collection: null }).map((crumb) => ({ name: crumb.label, path: crumb.path })));
    expect(ld.itemListElement).toHaveLength(3);
    expect(ld.itemListElement[2]?.item).toMatch(/^https?:\/\/.+\/product\/ember-hoodie$/);
  });
});

describe("product SEO", () => {
  it("always canonicalises to the clean product URL", () => {
    const meta = productMetadata({ title: "Ember Hoodie", slug: "ember-hoodie", description: "Warm.", image: "/p.jpg" });
    expect(meta.alternates?.canonical).toMatch(/\/product\/ember-hoodie$/);
    expect(String(meta.alternates?.canonical)).not.toContain("?");
    expect(meta.openGraph?.url).toMatch(/\/product\/ember-hoodie$/);
    expect(meta.robots).toBeUndefined();
  });
  it("noindexes products nobody can order", () => {
    expect(productMetadata({ title: "X", slug: "x", noIndex: true }).robots).toEqual({ index: false, follow: false });
  });
  it("emits per-variant offers and omits aggregateRating without reviews", () => {
    const ld = productJsonLd({
      name: "Ember Hoodie",
      slug: "ember-hoodie",
      pricePaise: 199_900,
      offers: [
        { sku: "A", pricePaise: 199_900, orderable: true },
        { sku: "B", pricePaise: 219_900, orderable: false },
      ],
    });
    expect(ld).not.toHaveProperty("aggregateRating");
    const offers = ld.offers as { "@type": string; lowPrice: string; highPrice: string; offerCount: number; offers: { availability: string; price: string }[] };
    expect(offers["@type"]).toBe("AggregateOffer");
    expect(offers.lowPrice).toBe("1999.00");
    expect(offers.highPrice).toBe("2199.00");
    expect(offers.offers.map((offer) => offer.availability)).toEqual(["https://schema.org/InStock", "https://schema.org/OutOfStock"]);
  });
  it("includes aggregateRating only with real data", () => {
    expect(productJsonLd({ name: "T", slug: "t", pricePaise: 100, rating: { value: 4.5, count: 3 } })).toHaveProperty("aggregateRating");
    expect(productJsonLd({ name: "T", slug: "t", pricePaise: 100, rating: { value: 4.5, count: 0 } })).not.toHaveProperty("aggregateRating");
  });
  it("uses a single offer for a single variant, with the product URL (no variant params)", () => {
    const ld = productJsonLd({ name: "T", slug: "t", pricePaise: 100, sku: "ONLY", offers: [{ sku: "ONLY", pricePaise: 100, orderable: true }] });
    expect((ld.offers as { "@type": string; url: string }).url).toMatch(/\/product\/t$/);
    expect((ld.offers as { "@type": string })["@type"]).toBe("Offer");
    expect(ld.sku).toBe("ONLY");
  });
});
