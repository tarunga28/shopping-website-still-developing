import type { CatalogProductType } from "@/lib/catalog-rules";

/**
 * Public catalog constants. One place for page sizes, sort keys, type slugs
 * and cache windows so the URL contract, the service and the UI cannot drift.
 */

export const DEFAULT_PAGE_SIZE = 24;
/** Hard cap for any caller (URL, API). The storefront UI always uses the default. */
export const MAX_PAGE_SIZE = 48;
/** Deep pagination is a scraping/DoS vector. Beyond this we redirect back into range. */
export const MAX_PAGE = 500;
export const MAX_FILTER_VALUES = 8;
/** ₹99,99,999 in paise. Anything above is not a real catalog price. */
export const MAX_FILTER_PRICE_PAISE = 999_999_900;

export const CATALOG_SORTS = ["featured", "newest", "price-asc", "price-desc", "name"] as const;
export type CatalogSortKey = (typeof CATALOG_SORTS)[number];
export const DEFAULT_SORT: CatalogSortKey = "featured";

export const SORT_LABELS: Record<CatalogSortKey, string> = {
  featured: "Featured",
  newest: "Newest",
  "price-asc": "Price: low to high",
  "price-desc": "Price: high to low",
  name: "Name: A–Z",
};

/** URL slug ⇄ database enum. Slugs are what customers see and share. */
export const PRODUCT_TYPE_SLUGS = {
  "t-shirt": "T_SHIRT",
  hoodie: "HOODIE",
  sweatshirt: "SWEATSHIRT",
  mug: "MUG",
  poster: "POSTER",
  "phone-case": "PHONE_CASE",
  "tote-bag": "TOTE_BAG",
  custom: "CUSTOM",
  other: "OTHER",
} as const satisfies Record<string, CatalogProductType>;

export type ProductTypeSlug = keyof typeof PRODUCT_TYPE_SLUGS;

export const PRODUCT_TYPE_LABELS: Record<CatalogProductType, string> = {
  T_SHIRT: "T-Shirts",
  HOODIE: "Hoodies",
  SWEATSHIRT: "Sweatshirts",
  MUG: "Mugs",
  POSTER: "Posters",
  PHONE_CASE: "Phone Cases",
  TOTE_BAG: "Tote Bags",
  CUSTOM: "Custom",
  OTHER: "Other",
};

export const PRODUCT_TYPE_SINGULAR: Record<CatalogProductType, string> = {
  T_SHIRT: "T-Shirt",
  HOODIE: "Hoodie",
  SWEATSHIRT: "Sweatshirt",
  MUG: "Mug",
  POSTER: "Poster",
  PHONE_CASE: "Phone Case",
  TOTE_BAG: "Tote Bag",
  CUSTOM: "Custom",
  OTHER: "Other",
};

export function typeToSlug(type: CatalogProductType): ProductTypeSlug {
  const entry = (Object.entries(PRODUCT_TYPE_SLUGS) as [ProductTypeSlug, CatalogProductType][]).find(
    ([, value]) => value === type,
  );
  return entry ? entry[0] : "other";
}

/** Cache tag shared by every cached public catalog read. */
export const CATALOG_CACHE_TAG = "catalog";
/**
 * Upper bound on staleness even if an invalidation is missed
 * (scheduled collections, direct SQL edits, imports).
 */
export const CATALOG_REVALIDATE_SECONDS = 60;
export const TAXONOMY_REVALIDATE_SECONDS = 120;

/** A product counts as "New" for this long after `publishedAt`. */
export const NEW_PRODUCT_WINDOW_DAYS = 30;
