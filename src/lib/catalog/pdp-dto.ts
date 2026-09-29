import type { CatalogProductType } from "@/lib/catalog-rules";
import { isSafeImageSrc } from "@/lib/safe-url";
import { plainParagraphs, plainText } from "@/lib/plain-text";
import { discountPercent, isNewProduct } from "./dto";
import { PRODUCT_TYPE_SINGULAR } from "./constants";
import { parseProductDetails, type ProductDetails } from "./product-details";
import { parseSizeChart, type SizeChart } from "./size-chart";
import { optionKey, type VariantState } from "./variant-selection";

/**
 * Public shape of a product DETAIL page. Built field-by-field from selected
 * columns; a database row is never serialized directly, so supplier cost,
 * admin notes, print files, design ids or placement coordinates cannot leak
 * from a future column by accident.
 */

export interface PdpPrice {
  amountPaise: number;
  compareAtPaise: number | null;
  /** Integer percent, only when the stored compare-at is genuinely higher. */
  discountPercent: number | null;
}

export interface PdpVariantDTO {
  /** Needed to add to cart. Carries no authority: the server re-validates it. */
  id: string;
  sku: string;
  name: string;
  size: string | null;
  color: string | null;
  price: PdpPrice;
  state: VariantState;
}

export interface PdpColorOption {
  key: string;
  label: string;
  /** From the colour system (or the variant's stored code). Validated, never client-supplied. */
  hex: string | null;
}

export interface PdpSizeOption {
  key: string;
  label: string;
}

export interface PdpImageDTO {
  url: string;
  alt: string;
  width: number | null;
  height: number | null;
  /** Colour key of the variant this image belongs to; null = shared by all variants. */
  colorKey: string | null;
}

export interface PdpDesignDTO {
  name: string;
  /** Customer-facing placement labels only ("Front", "Back"…). */
  placements: string[];
}

export interface PdpProductDTO {
  id: string;
  slug: string;
  name: string;
  shortDescription: string | null;
  description: string | null;
  productType: CatalogProductType;
  productTypeLabel: string;
  currency: string;
  price: PdpPrice;
  variants: PdpVariantDTO[];
  colors: PdpColorOption[];
  sizes: PdpSizeOption[];
  /** True when at least one variant can be ordered right now. */
  purchasable: boolean;
  images: PdpImageDTO[];
  /** Root → primary category. Empty when the product has no public category. */
  categoryTrail: { name: string; slug: string }[];
  collection: { name: string; slug: string } | null;
  details: ProductDetails;
  designs: PdpDesignDTO[];
  sizeChart: SizeChart | null;
  rating: { average: number; count: number } | null;
  isNew: boolean;
  seo: { title: string | null; description: string | null; image: string | null };
}

/* ── Sources (what the service may hand to the builder) ───────────────── */

export interface PdpVariantSource {
  id: string;
  sku: string;
  name: string;
  size: string | null;
  color: string | null;
  colorCode: string | null;
  pricePaise: number;
  compareAtPaise: number | null;
  availability: "IN_STOCK" | "LOW_STOCK" | "OUT_OF_STOCK" | "PREORDER";
}

export interface PdpImageSource {
  url: string;
  altText: string | null;
  width: number | null;
  height: number | null;
  role: string;
  sortOrder: number;
  variantId: string | null;
  type: string;
}

export interface PdpProductSource {
  id: string;
  slug: string;
  name: string;
  shortDescription: string | null;
  description: string | null;
  productType: CatalogProductType;
  basePricePaise: number;
  compareAtPricePaise: number | null;
  currency: string;
  publishedAt: Date | string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  details: unknown;
  variants: PdpVariantSource[];
  images: PdpImageSource[];
  /** Active colour-system entries, used for names/hex/order. */
  colorCatalog: { name: string; hex: string; displayOrder: number }[];
  categoryTrail: { name: string; slug: string }[];
  collection: { name: string; slug: string } | null;
  designs: { name: string; placements: string[] }[];
  sizeChart: unknown;
  rating: { average: number; count: number } | null;
}

/* ── Builders ─────────────────────────────────────────────────────────── */

const HEX = /^#[0-9a-f]{6}$/i;

export function safeHex(value: string | null | undefined): string | null {
  const hex = value?.trim();
  return hex && HEX.test(hex) ? hex.toLowerCase() : null;
}

/** Checkout-facing meaning of the stored availability. PREORDER is not orderable yet. */
export function variantState(availability: PdpVariantSource["availability"]): VariantState {
  if (availability === "IN_STOCK" || availability === "LOW_STOCK") return "AVAILABLE";
  if (availability === "OUT_OF_STOCK") return "OUT_OF_STOCK";
  return "UNAVAILABLE";
}

const ROLE_RANK: Record<string, number> = { PRIMARY: 0, GALLERY: 1, MOBILE: 2, HOVER: 3, THUMBNAIL: 4, SOCIAL: 5 };

function sizeRank(size: string | null, order: readonly string[]): number {
  const index = order.indexOf((size ?? "").toUpperCase());
  return index === -1 ? order.length : index;
}

export const SIZE_DISPLAY_ORDER = ["XS", "S", "M", "L", "XL", "XXL", "XXXL", "ONE"] as const;

/**
 * Alt text must be meaningful and not repeated: when several images share one
 * alt (very common — the product name), each gets a "view N of M" suffix.
 */
export function uniqueAltTexts(name: string, alts: (string | null)[]): string[] {
  const base = alts.map((alt) => plainText(alt, 140) || name);
  const counts = new Map<string, number>();
  for (const alt of base) counts.set(alt, (counts.get(alt) ?? 0) + 1);
  return base.map((alt, index) => ((counts.get(alt) ?? 0) > 1 ? `${alt} – view ${index + 1} of ${base.length}` : alt));
}

export function toPdpProductDTO(source: PdpProductSource, now: Date = new Date()): PdpProductDTO {
  const colorCatalog = new Map(source.colorCatalog.map((color) => [color.name.trim().toLowerCase(), color]));

  const variants = source.variants
    .filter((variant) => Number.isInteger(variant.pricePaise) && variant.pricePaise > 0)
    .map((variant) => ({
      source: variant,
      colorKey: optionKey(variant.color),
      sizeKey: optionKey(variant.size),
    }))
    .sort((a, b) => {
      const ca = a.colorKey ? (colorCatalog.get(a.colorKey)?.displayOrder ?? 9999) : -1;
      const cb = b.colorKey ? (colorCatalog.get(b.colorKey)?.displayOrder ?? 9999) : -1;
      return (
        ca - cb ||
        (a.colorKey ?? "").localeCompare(b.colorKey ?? "") ||
        sizeRank(a.source.size, SIZE_DISPLAY_ORDER) - sizeRank(b.source.size, SIZE_DISPLAY_ORDER) ||
        (a.sizeKey ?? "").localeCompare(b.sizeKey ?? "")
      );
    });

  const variantDtos: PdpVariantDTO[] = variants.map(({ source: v }) => ({
    id: v.id,
    sku: v.sku,
    name: plainText(v.name, 120),
    size: v.size?.trim() || null,
    color: v.color?.trim() || null,
    price: {
      amountPaise: v.pricePaise,
      compareAtPaise: v.compareAtPaise !== null && v.compareAtPaise > v.pricePaise ? v.compareAtPaise : null,
      discountPercent: discountPercent(v.pricePaise, v.compareAtPaise),
    },
    state: variantState(v.availability),
  }));

  const colors: PdpColorOption[] = [];
  const sizes: PdpSizeOption[] = [];
  for (const { source: v, colorKey, sizeKey } of variants) {
    if (colorKey && !colors.some((color) => color.key === colorKey)) {
      const known = colorCatalog.get(colorKey);
      colors.push({
        key: colorKey,
        label: known?.name ?? (v.color?.trim() as string),
        hex: safeHex(known?.hex) ?? safeHex(v.colorCode),
      });
    }
    if (sizeKey && !sizes.some((size) => size.key === sizeKey)) {
      sizes.push({ key: sizeKey, label: v.size?.trim() as string });
    }
  }
  sizes.sort(
    (a, b) =>
      sizeRank(a.label, SIZE_DISPLAY_ORDER) - sizeRank(b.label, SIZE_DISPLAY_ORDER) || a.key.localeCompare(b.key),
  );

  const colorByVariantId = new Map(variants.map((entry) => [entry.source.id, entry.colorKey]));
  const orderedImages = source.images
    .filter((image) => image.type === "PRODUCT" && isSafeImageSrc(image.url))
    .sort((a, b) => (ROLE_RANK[a.role] ?? 9) - (ROLE_RANK[b.role] ?? 9) || a.sortOrder - b.sortOrder)
    // SOCIAL/THUMBNAIL crops are for sharing and lists, not the gallery.
    .filter((image) => image.role !== "SOCIAL" && image.role !== "THUMBNAIL");
  const alts = uniqueAltTexts(
    source.name,
    orderedImages.map((image) => image.altText),
  );
  const images: PdpImageDTO[] = orderedImages.map((image, index) => ({
    url: image.url,
    alt: alts[index] ?? source.name,
    width: image.width && image.width > 0 ? image.width : null,
    height: image.height && image.height > 0 ? image.height : null,
    colorKey: image.variantId ? (colorByVariantId.get(image.variantId) ?? null) : null,
  }));

  const social = source.images.find((image) => image.role === "SOCIAL" && isSafeImageSrc(image.url));
  const purchasable = variantDtos.some((variant) => variant.state === "AVAILABLE");

  return {
    id: source.id,
    slug: source.slug,
    name: source.name,
    shortDescription: source.shortDescription?.trim() ? plainText(source.shortDescription, 400) : null,
    description: plainParagraphs(source.description).join("\n\n") || null,
    productType: source.productType,
    productTypeLabel: PRODUCT_TYPE_SINGULAR[source.productType] ?? "Product",
    currency: source.currency,
    price: {
      amountPaise: source.basePricePaise,
      compareAtPaise:
        source.compareAtPricePaise !== null && source.compareAtPricePaise > source.basePricePaise
          ? source.compareAtPricePaise
          : null,
      discountPercent: discountPercent(source.basePricePaise, source.compareAtPricePaise),
    },
    variants: variantDtos,
    colors,
    sizes,
    purchasable,
    images,
    categoryTrail: source.categoryTrail.map((category) => ({ name: category.name, slug: category.slug })),
    collection: source.collection ? { name: source.collection.name, slug: source.collection.slug } : null,
    details: parseProductDetails(source.details),
    designs: source.designs
      .filter((design) => design.name.trim().length > 0 && design.placements.length > 0)
      .map((design) => ({ name: plainText(design.name, 120), placements: [...design.placements] })),
    sizeChart: parseSizeChart(source.sizeChart),
    rating: source.rating && source.rating.count > 0 ? { ...source.rating } : null,
    isNew: isNewProduct(source.publishedAt, now),
    seo: {
      title: source.seoTitle?.trim() || null,
      description: source.seoDescription?.trim() || null,
      image: social?.url ?? images[0]?.url ?? null,
    },
  };
}

export const PLACEMENT_LABELS: Record<string, string> = {
  FRONT: "Front",
  BACK: "Back",
  LEFT_SLEEVE: "Left sleeve",
  RIGHT_SLEEVE: "Right sleeve",
  CENTER: "Centre",
  OTHER: "Other placement",
};
