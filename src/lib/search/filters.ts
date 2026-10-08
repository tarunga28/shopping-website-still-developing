/**
 * Filter engine and facets.
 *
 * ## Filters are data, not code
 *
 * The set of filterable attributes is not enumerated anywhere in the frontend.
 * A facet group is produced from whatever attribute axes the matched products
 * actually carry, so adding a "Material" axis to the catalog in the admin makes
 * a Material filter appear on the storefront with no deploy. Hard-coding
 * size/colour/material into a component is exactly what Part 11's attribute
 * engine was built to avoid.
 *
 * ## Facets answer "what else could I pick?"
 *
 * A count is computed per value *within the current query and the other active
 * filters*, which is what makes a facet honest: it never offers a combination
 * that returns nothing. Price is bucketed rather than left as a raw range
 * because "₹4,999 – ₹5,001" is not a choice a shopper can act on.
 */

import type {
  AvailabilityFilter,
  FacetGroup,
  FacetValue,
  PriceFacet,
  SearchFacets,
  SearchFilters,
  SearchSort,
} from "@/lib/search/types";
import { SEARCH_SORTS } from "@/lib/search/types";

export const EMPTY_SEARCH_FILTERS: SearchFilters = {
  categoryIds: [],
  brandIds: [],
  minPricePaise: null,
  maxPricePaise: null,
  minRating: null,
  availability: "any",
  onSaleOnly: false,
  attributes: {},
};

/** Maximum values returned per facet group. Beyond this the UI is unusable. */
export const MAX_FACET_VALUES = 50;

/** Price buckets, in paise. Fixed bands beat computed quartiles for shoppers. */
export const PRICE_BUCKETS: ReadonlyArray<{
  label: string;
  minPaise: number | null;
  maxPaise: number | null;
}> = [
  { label: "Under ₹1,000", minPaise: null, maxPaise: 100_000 },
  { label: "₹1,000 – ₹5,000", minPaise: 100_000, maxPaise: 500_000 },
  { label: "₹5,000 – ₹10,000", minPaise: 500_000, maxPaise: 1_000_000 },
  { label: "₹10,000 – ₹25,000", minPaise: 1_000_000, maxPaise: 2_500_000 },
  { label: "₹25,000 – ₹50,000", minPaise: 2_500_000, maxPaise: 5_000_000 },
  { label: "₹50,000 – ₹1,00,000", minPaise: 5_000_000, maxPaise: 10_000_000 },
  { label: "Above ₹1,00,000", minPaise: 10_000_000, maxPaise: null },
];

/** Human labels for axes whose code is not presentable on its own. */
const AXIS_LABELS: Readonly<Record<string, string>> = {
  color: "Colour",
  size: "Size",
  material: "Material",
  storage: "Storage",
  ram: "RAM",
  screen_size: "Screen size",
  battery: "Battery",
  gender: "Gender",
  compatibility: "Compatibility",
  weight: "Weight",
  brand: "Brand",
  category: "Category",
};

/** Axes shown first, because they are the ones shoppers actually filter on. */
const AXIS_PRIORITY: readonly string[] = [
  "brand",
  "category",
  "color",
  "size",
  "storage",
  "ram",
  "material",
  "gender",
  "screen_size",
  "battery",
  "compatibility",
];

export function axisLabel(code: string): string {
  return AXIS_LABELS[code] ?? code.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/* ── URL state ───────────────────────────────────────────────────────── */

/**
 * Parse search state out of a URL query string.
 *
 * Every parameter is validated and clamped. An unparseable value is dropped
 * rather than throwing, because a hand-edited or maliciously crafted search URL
 * must degrade to a working search, not a 500.
 */
export function parseSearchFilters(raw: URLSearchParams): SearchFilters {
  const filters: SearchFilters = { ...EMPTY_SEARCH_FILTERS, attributes: {} };

  filters.categoryIds = csv(raw.get("category")).slice(0, 20);
  filters.brandIds = csv(raw.get("brand")).slice(0, 20);

  const minPrice = parseRupeeParam(raw.get("minPrice"));
  const maxPrice = parseRupeeParam(raw.get("maxPrice"));
  // An inverted band is a nonsense filter; dropping it beats returning nothing.
  if (minPrice !== null && maxPrice !== null && maxPrice < minPrice) {
    filters.minPricePaise = maxPrice;
    filters.maxPricePaise = minPrice;
  } else {
    filters.minPricePaise = minPrice;
    filters.maxPricePaise = maxPrice;
  }

  const rating = Number.parseFloat(raw.get("rating") ?? "");
  if (Number.isFinite(rating) && rating > 0 && rating <= 5) filters.minRating = rating;

  const availability = raw.get("availability");
  if (
    availability === "any" ||
    availability === "in_stock" ||
    availability === "out_of_stock" ||
    availability === "on_sale"
  ) {
    filters.availability = availability;
  }
  filters.onSaleOnly = raw.get("sale") === "1";

  // Attribute filters arrive as `attr.color=black,white`. The prefix keeps them
  // namespaced so an axis named "brand" cannot collide with the brand filter.
  for (const [key, value] of raw.entries()) {
    if (!key.startsWith("attr.")) continue;
    const axis = key.slice(5);
    if (!axis || axis.length > 40) continue;
    const values = csv(value).slice(0, 20);
    if (values.length) filters.attributes[axis] = values;
  }

  return filters;
}

export function parseSearchSort(raw: URLSearchParams): SearchSort {
  const sort = raw.get("sort");
  return sort && (SEARCH_SORTS as readonly string[]).includes(sort) ? (sort as SearchSort) : "relevance";
}

/**
 * Cursor pagination.
 *
 * The cursor is an opaque base64 of `score:productId`, which is the ordering key.
 * Encoding rather than exposing a raw offset is what makes deep pagination cheap:
 * the engine seeks to the last seen item instead of scanning and discarding
 * everything before it.
 */
export function encodeCursor(score: number, productId: string): string {
  const encoded = Buffer.from(`${score.toFixed(6)}:${productId}`, "utf8").toString("base64url");
  return encoded;
}

export function decodeCursor(cursor: string | null | undefined): { score: number; productId: string } | null {
  if (!cursor) return null;
  if (cursor.length > 200) return null;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    // The FIRST colon, not the last: the cursor is "<score>:<productId>" and the
    // score is a fixed-format float that never contains a colon, whereas a
    // product id legitimately can. Splitting on the last colon would truncate any
    // id containing one.
    const separator = decoded.indexOf(":");
    if (separator <= 0) return null;
    const score = Number.parseFloat(decoded.slice(0, separator));
    const productId = decoded.slice(separator + 1);
    if (!Number.isFinite(score) || !productId) return null;
    return { score, productId };
  } catch {
    return null;
  }
}

export function parseSearchLimit(raw: URLSearchParams, fallback = 24, maximum = 100): number {
  const parsed = Number.parseInt(raw.get("limit") ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

/**
 * Serialize filters back into URL parameters.
 *
 * The round trip is the contract: `parseSearchFilters(serializeSearchFilters(f))`
 * must equal `f`. That is what makes a search page bookmarkable and shareable,
 * and what makes browser back/forward behave.
 */
export function serializeSearchFilters(
  filters: SearchFilters,
  extra: { q?: string; sort?: SearchSort; cursor?: string | null; limit?: number } = {},
): URLSearchParams {
  const params = new URLSearchParams();
  if (extra.q) params.set("q", extra.q);

  if (filters.categoryIds.length) params.set("category", filters.categoryIds.join(","));
  if (filters.brandIds.length) params.set("brand", filters.brandIds.join(","));
  if (filters.minPricePaise !== null) params.set("minPrice", String(Math.round(filters.minPricePaise / 100)));
  if (filters.maxPricePaise !== null) params.set("maxPrice", String(Math.round(filters.maxPricePaise / 100)));
  if (filters.minRating !== null) params.set("rating", String(filters.minRating));
  if (filters.availability !== "any") params.set("availability", filters.availability);
  if (filters.onSaleOnly) params.set("sale", "1");

  for (const axis of Object.keys(filters.attributes).sort()) {
    const values = filters.attributes[axis] ?? [];
    if (values.length) params.set(`attr.${axis}`, values.join(","));
  }

  if (extra.sort && extra.sort !== "relevance") params.set("sort", extra.sort);
  if (extra.limit && extra.limit !== 24) params.set("limit", String(extra.limit));
  if (extra.cursor) params.set("cursor", extra.cursor);

  return params;
}

/** The active filters as removable chips, for the "clear one / clear all" UI. */
export interface ActiveFilterChip {
  key: string;
  axis: string;
  label: string;
  value: string;
  /** The params remaining after this chip is removed. */
  removeHref: string;
}

export function activeFilterChips(
  filters: SearchFilters,
  labels: { brands?: Record<string, string>; categories?: Record<string, string>; values?: Record<string, Record<string, string>> } = {},
  extra: { q?: string; sort?: SearchSort } = {},
): ActiveFilterChip[] {
  const chips: ActiveFilterChip[] = [];
  const buildHref = (next: SearchFilters) =>
    `/search?${serializeSearchFilters(next, extra).toString()}`;

  for (const id of filters.categoryIds) {
    const next = { ...filters, categoryIds: filters.categoryIds.filter((entry) => entry !== id) };
    chips.push({
      key: `category:${id}`,
      axis: "category",
      label: "Category",
      value: labels.categories?.[id] ?? id,
      removeHref: buildHref(next),
    });
  }
  for (const id of filters.brandIds) {
    const next = { ...filters, brandIds: filters.brandIds.filter((entry) => entry !== id) };
    chips.push({
      key: `brand:${id}`,
      axis: "brand",
      label: "Brand",
      value: labels.brands?.[id] ?? id,
      removeHref: buildHref(next),
    });
  }
  if (filters.minPricePaise !== null || filters.maxPricePaise !== null) {
    const next = { ...filters, minPricePaise: null, maxPricePaise: null };
    chips.push({
      key: "price",
      axis: "price",
      label: "Price",
      value: `${filters.minPricePaise !== null ? `₹${Math.round(filters.minPricePaise / 100)}` : "any"} – ${
        filters.maxPricePaise !== null ? `₹${Math.round(filters.maxPricePaise / 100)}` : "any"
      }`,
      removeHref: buildHref(next),
    });
  }
  if (filters.minRating !== null) {
    const next = { ...filters, minRating: null };
    chips.push({
      key: "rating",
      axis: "rating",
      label: "Rating",
      value: `${filters.minRating}★ & up`,
      removeHref: buildHref(next),
    });
  }
  if (filters.availability !== "any") {
    const next = { ...filters, availability: "any" as AvailabilityFilter };
    chips.push({
      key: "availability",
      axis: "availability",
      label: "Availability",
      value: filters.availability.replace("_", " "),
      removeHref: buildHref(next),
    });
  }
  if (filters.onSaleOnly) {
    const next = { ...filters, onSaleOnly: false };
    chips.push({
      key: "sale",
      axis: "sale",
      label: "Offer",
      value: "On sale",
      removeHref: buildHref(next),
    });
  }
  for (const axis of Object.keys(filters.attributes).sort()) {
    for (const value of filters.attributes[axis] ?? []) {
      const next: SearchFilters = {
        ...filters,
        attributes: {
          ...filters.attributes,
          [axis]: (filters.attributes[axis] ?? []).filter((entry) => entry !== value),
        },
      };
      chips.push({
        key: `${axis}:${value}`,
        axis,
        label: axisLabel(axis),
        value: labels.values?.[axis]?.[value] ?? value,
        removeHref: buildHref(next),
      });
    }
  }

  return chips;
}

export function hasActiveSearchFilters(filters: SearchFilters): boolean {
  return (
    filters.categoryIds.length > 0 ||
    filters.brandIds.length > 0 ||
    filters.minPricePaise !== null ||
    filters.maxPricePaise !== null ||
    filters.minRating !== null ||
    filters.availability !== "any" ||
    filters.onSaleOnly ||
    Object.values(filters.attributes).some((values) => values.length > 0)
  );
}

/* ── Facet construction ──────────────────────────────────────────────── */

/** One observed (axis, value) pair and how many products carry it. */
export interface FacetCount {
  axis: string;
  value: string;
  label?: string;
  count: number;
  id?: string;
}

/**
 * Build facet groups from observed counts.
 *
 * Values already selected are kept in the group and flagged, so the UI can show
 * them as checked rather than dropping them — a facet that disappears when you
 * tick it looks broken.
 */
export function buildFacetGroups(
  counts: readonly FacetCount[],
  filters: SearchFilters,
  options: { maxValues?: number } = {},
): FacetGroup[] {
  const maxValues = options.maxValues ?? MAX_FACET_VALUES;
  const byAxis = new Map<string, FacetCount[]>();
  for (const count of counts) {
    const bucket = byAxis.get(count.axis);
    if (bucket) bucket.push(count);
    else byAxis.set(count.axis, [count]);
  }

  const groups: FacetGroup[] = [];
  for (const [axis, values] of byAxis) {
    const selected = new Set(filters.attributes[axis] ?? []);
    const sorted = [...values].sort(
      // Selected values first so they are visible without scrolling, then by
      // count, then alphabetically for a stable order between requests.
      (a, b) =>
        Number(selected.has(b.value)) - Number(selected.has(a.value)) ||
        b.count - a.count ||
        a.value.localeCompare(b.value),
    );

    groups.push({
      key: axis,
      label: axisLabel(axis),
      multi: true,
      values: sorted.slice(0, maxValues).map((entry) => ({
        value: entry.value,
        label: entry.label ?? entry.value,
        count: entry.count,
        id: entry.id,
        selected: selected.has(entry.value),
      })),
    });
  }

  // A predictable group order matters: shoppers learn where the colour filter
  // lives, and a list that reorders itself per query feels broken.
  groups.sort((a, b) => {
    const priorityA = AXIS_PRIORITY.indexOf(a.key);
    const priorityB = AXIS_PRIORITY.indexOf(b.key);
    if (priorityA !== -1 || priorityB !== -1) {
      return (priorityA === -1 ? 99 : priorityA) - (priorityB === -1 ? 99 : priorityB);
    }
    return a.label.localeCompare(b.label);
  });

  return groups;
}

/**
 * Bucket prices.
 *
 * Only buckets with at least one product are returned, because an empty bucket
 * is a dead control. The observed min/max are returned alongside so the UI can
 * show a slider with real bounds.
 */
export function buildPriceFacet(
  observed: Array<{ pricePaise: number }>,
  filters: SearchFilters,
): PriceFacet | null {
  if (observed.length === 0) return null;

  const prices = observed.map((item) => item.pricePaise);
  const minPaise = Math.min(...prices);
  const maxPaise = Math.max(...prices);

  const buckets = PRICE_BUCKETS.map((bucket) => ({
    ...bucket,
    count: prices.filter(
      (price) =>
        (bucket.minPaise === null || price >= bucket.minPaise) &&
        (bucket.maxPaise === null || price < bucket.maxPaise),
    ).length,
  })).filter((bucket) => bucket.count > 0);

  return { minPaise, maxPaise, buckets };
}

export function buildFacets(input: {
  counts: readonly FacetCount[];
  prices: Array<{ pricePaise: number }>;
  filters: SearchFilters;
  total: number;
  maxValues?: number;
}): SearchFacets {
  return {
    groups: buildFacetGroups(input.counts, input.filters, { maxValues: input.maxValues }),
    price: buildPriceFacet(input.prices, input.filters),
    total: input.total,
  };
}

/** Rating facet options — fixed bands, since ratings are a fixed scale. */
export function ratingFacetOptions(countsByRating: Record<string, number>): FacetValue[] {
  return [4, 3, 2, 1].map((stars) => ({
    value: String(stars),
    label: `${stars}★ & up`,
    count: countsByRating[String(stars)] ?? 0,
    selected: false,
  }));
}

/* ── helpers ─────────────────────────────────────────────────────────── */

function csv(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 50);
}

/** Parse a rupee-denominated URL parameter into paise. */
function parseRupeeParam(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value.replace(/,/g, ""));
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  // Clamped: a maxPrice of 1e15 is a typo or an attack, and both should behave
  // like "no upper bound" rather than overflow an integer column.
  return Math.min(Math.round(parsed * 100), 100_000_000);
}
