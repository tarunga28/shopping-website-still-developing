/**
 * Storefront view models.
 * These are the shapes homepage and catalogue pages render — not table rows.
 * A future CMS can populate the same interfaces without touching the UI.
 */

import type { ProductAvailability, ProductBadge, ProductSummary } from "@/types";

export interface StorefrontCategory {
  slug: string;
  name: string;
  description: string;
  image: string;
  imageAlt: string;
  fromPricePaise: number | null;
  productCount: number;
  seoTitle?: string | null;
  seoDescription?: string | null;
}

export interface StorefrontCollection {
  slug: string;
  name: string;
  description: string;
  image: string | null;
  imageAlt: string;
  productCount: number;
  seoTitle: string | null;
  seoDescription: string | null;
}

export interface StorefrontReview {
  id: string;
  rating: number;
  title: string | null;
  quote: string;
  authorName: string;
  productLabel: string;
  productHref: string | null;
  verifiedPurchase: boolean;
  image: string | null;
  imageAlt: string | null;
}

export interface ProductImageAsset {
  src: string;
  alt: string;
  width: number | null;
  height: number | null;
}

export interface ProductVariantSummary {
  name: string;
  sku?: string;
  size: string | null;
  color: string | null;
  availability: ProductAvailability;
  pricePaise: number;
}

export interface ProductDetail {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  blurb: string | null;
  category: string;
  categorySlug: string | null;
  pricePaise: number;
  compareAtPaise?: number;
  badge?: ProductBadge;
  availability: ProductAvailability;
  rating?: ProductSummary["rating"];
  images: ProductImageAsset[];
  variants: ProductVariantSummary[];
  seoTitle: string | null;
  seoDescription: string | null;
  catalogStatus?: "ACTIVE" | "DISCONTINUED";
  /** Social or primary image for Open Graph. Not a separate public page. */
  socialImage?: string | null;
}

export type SectionStatus = "ok" | "empty" | "error";

export interface SectionResult<T> {
  data: T;
  status: SectionStatus;
}
