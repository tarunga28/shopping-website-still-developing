/**
 * Shared domain-lean types used across UI, services and (later) DB mappers.
 * Money is always an integer in the smallest currency unit (paise for INR).
 */

export interface ProductCategory {
  slug: string;
  name: string;
  description: string;
  /** Representative hero/category artwork. */
  image: string;
  /** Starting price for the category, in paise. */
  fromPricePaise: number;
}

export type ProductBadge = "NEW" | "BESTSELLER" | "LOW_STOCK" | "SALE" | "LIMITED" | "SOLD_OUT";

export type ProductAvailability = "in_stock" | "low_stock" | "sold_out" | "coming_soon";

export interface ProductRating {
  value: number;
  count: number;
}

export interface ProductSummary {
  id: string;
  slug: string;
  title: string;
  category: string;
  pricePaise: number;
  compareAtPaise?: number;
  image: string;
  /** Second angle shown on hover (falls back to the primary image). */
  hoverImage?: string;
  badge?: ProductBadge;
  rating?: ProductRating;
  availability?: ProductAvailability;
  /** One-line preview description for quick views / list layouts. */
  blurb?: string;
}

export interface Testimonial {
  id: string;
  quote: string;
  name: string;
  location: string;
  rating: 1 | 2 | 3 | 4 | 5;
  productLabel: string;
}

export interface HowItWorksStep {
  step: string;
  title: string;
  description: string;
}
