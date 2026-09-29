import type { CatalogProductType } from "@/lib/catalog-rules";
import type { ProductSummary } from "@/types";
import { deriveAvailability, type ProductAvailabilityState, type VariantAvailabilityCounts } from "./availability";
import { NEW_PRODUCT_WINDOW_DAYS, PRODUCT_TYPE_SINGULAR } from "./constants";

/**
 * The ONLY product shape the public storefront and public API are allowed to
 * see. It is built field-by-field from selected columns — a Prisma/Drizzle row
 * is never serialized directly — so a future column (supplier cost, admin
 * notes, storage keys, audit data) cannot leak by accident.
 */
export interface PublicProductDTO {
  /** Public catalog id. Needed by wishlist actions; carries no authority by itself. */
  id: string;
  slug: string;
  name: string;
  shortDescription: string | null;
  productType: CatalogProductType;
  productTypeLabel: string;
  price: {
    amountPaise: number;
    compareAtPaise: number | null;
    currency: string;
    /** Integer percent, only when compare-at is genuinely higher than price. */
    discountPercent: number | null;
  };
  image: { url: string; alt: string };
  hoverImage: { url: string; alt: string } | null;
  availability: ProductAvailabilityState;
  category: { name: string; slug: string } | null;
  collection: { name: string; slug: string } | null;
  /** Approved-review aggregate. Null unless real reviews exist. */
  rating: { average: number; count: number } | null;
  isNew: boolean;
}

/** Everything the DTO builder may read. Anything else on the input is ignored. */
export interface PublicProductSource {
  id: string;
  slug: string;
  name: string;
  shortDescription: string | null;
  productType: CatalogProductType;
  basePricePaise: number;
  compareAtPricePaise: number | null;
  currency: string;
  publishedAt: Date | string | null;
  image: { url: string; alt: string | null };
  hoverImage: { url: string; alt: string | null } | null;
  variants: VariantAvailabilityCounts | undefined;
  category: { name: string; slug: string } | null;
  collection: { name: string; slug: string } | null;
  rating: { average: number; count: number } | null;
}

/** Integer-only percent (rounded half up). No float money maths. */
export function discountPercent(pricePaise: number, compareAtPaise: number | null): number | null {
  if (compareAtPaise === null || !Number.isInteger(pricePaise) || !Number.isInteger(compareAtPaise)) return null;
  if (compareAtPaise <= pricePaise || compareAtPaise <= 0) return null;
  const percent = Math.floor(((compareAtPaise - pricePaise) * 200 + compareAtPaise) / (compareAtPaise * 2));
  return percent >= 1 && percent <= 99 ? percent : null;
}

export function isNewProduct(publishedAt: Date | string | null, now: Date = new Date()): boolean {
  if (!publishedAt) return false;
  const time = new Date(publishedAt).getTime();
  if (Number.isNaN(time)) return false;
  const age = now.getTime() - time;
  return age >= 0 && age < NEW_PRODUCT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}

export function toPublicProductDTO(source: PublicProductSource, now: Date = new Date()): PublicProductDTO {
  return {
    id: source.id,
    slug: source.slug,
    name: source.name,
    shortDescription: source.shortDescription,
    productType: source.productType,
    productTypeLabel: PRODUCT_TYPE_SINGULAR[source.productType] ?? "Product",
    price: {
      amountPaise: source.basePricePaise,
      compareAtPaise: source.compareAtPricePaise,
      currency: source.currency,
      discountPercent: discountPercent(source.basePricePaise, source.compareAtPricePaise),
    },
    image: { url: source.image.url, alt: source.image.alt?.trim() || source.name },
    hoverImage: source.hoverImage
      ? { url: source.hoverImage.url, alt: source.hoverImage.alt?.trim() || source.name }
      : null,
    availability: deriveAvailability(source.variants),
    category: source.category ? { name: source.category.name, slug: source.category.slug } : null,
    collection: source.collection ? { name: source.collection.name, slug: source.collection.slug } : null,
    rating:
      source.rating && source.rating.count > 0
        ? { average: source.rating.average, count: source.rating.count }
        : null,
    isNew: isNewProduct(source.publishedAt, now),
  };
}

/** Adapter to the shared ProductCard view model. */
export function toProductSummary(dto: PublicProductDTO): ProductSummary {
  return {
    id: dto.id,
    slug: dto.slug,
    title: dto.name,
    category: dto.category?.name ?? dto.productTypeLabel,
    categorySlug: dto.category?.slug,
    collectionSlugs: dto.collection ? [dto.collection.slug] : [],
    pricePaise: dto.price.amountPaise,
    compareAtPaise: dto.price.compareAtPaise ?? undefined,
    image: dto.image.url,
    imageAlt: dto.image.alt,
    hoverImage: dto.hoverImage?.url,
    badge: dto.availability === "UNAVAILABLE" ? "SOLD_OUT" : dto.isNew ? "NEW" : undefined,
    rating: dto.rating ? { value: dto.rating.average, count: dto.rating.count } : undefined,
    // UNKNOWN deliberately maps to "no claim" rather than in/out of stock.
    availability: dto.availability === "AVAILABLE" ? "in_stock" : dto.availability === "UNAVAILABLE" ? "sold_out" : undefined,
    blurb: dto.shortDescription ?? undefined,
  };
}
