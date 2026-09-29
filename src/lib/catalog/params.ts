import { z } from "zod";
import { SIZE_CATALOG, parseInrToPaise, type CatalogProductType } from "@/lib/catalog-rules";
import {
  CATALOG_SORTS,
  DEFAULT_PAGE_SIZE,
  DEFAULT_SORT,
  MAX_FILTER_PRICE_PAISE,
  MAX_FILTER_VALUES,
  MAX_PAGE,
  MAX_PAGE_SIZE,
  PRODUCT_TYPE_SLUGS,
  typeToSlug,
  type CatalogSortKey,
} from "./constants";

/**
 * URL ⇄ catalog state. The URL is the single source of truth for what the
 * customer is looking at. Everything arriving from a query string is
 * untrusted: it is normalized (case, whitespace, duplicates, arrays),
 * validated with Zod, and silently dropped when invalid. Parsed values are
 * only ever passed to the database as bound parameters.
 */

export type RawSearchParams = Record<string, string | string[] | undefined> | URLSearchParams;

export interface CatalogFilters {
  sort: CatalogSortKey;
  page: number;
  type: CatalogProductType | null;
  sizes: string[];
  colors: string[];
  minPricePaise: number | null;
  maxPricePaise: number | null;
  availableOnly: boolean;
  /** Only honored on /shop, where it redirects to the clean /category/[slug] URL. */
  category: string | null;
}

export const EMPTY_FILTERS: CatalogFilters = {
  sort: DEFAULT_SORT,
  page: 1,
  type: null,
  sizes: [],
  colors: [],
  minPricePaise: null,
  maxPricePaise: null,
  availableOnly: false,
  category: null,
};

const KNOWN_KEYS = new Set([
  "sort",
  "page",
  "type",
  "productType",
  "size",
  "color",
  "minPrice",
  "maxPrice",
  "availability",
  "category",
]);

const SIZE_ORDER = SIZE_CATALOG.map((size) => size.code);
const SIZE_SET = new Set(SIZE_ORDER);

const slugSchema = z
  .string()
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const colorSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9 '&-]*$/);
const sortSchema = z.enum(CATALOG_SORTS);
const typeSlugSchema = z.enum(Object.keys(PRODUCT_TYPE_SLUGS) as [keyof typeof PRODUCT_TYPE_SLUGS, ...(keyof typeof PRODUCT_TYPE_SLUGS)[]]);
const pageSchema = z.coerce.number().int().min(1).max(MAX_PAGE);

/** Flatten Next's `searchParams` / URLSearchParams into ordered key → values. */
function collect(raw: RawSearchParams): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const push = (key: string, value: string | undefined) => {
    if (value === undefined) return;
    const list = out.get(key) ?? [];
    list.push(value);
    out.set(key, list);
  };
  if (raw instanceof URLSearchParams) {
    for (const [key, value] of raw.entries()) push(key, value);
  } else {
    for (const [key, value] of Object.entries(raw)) {
      if (Array.isArray(value)) value.forEach((entry) => push(key, entry));
      else push(key, value);
    }
  }
  return out;
}

function firstValue(values: string[] | undefined): string {
  return (values?.find((value) => value.trim().length > 0) ?? "").trim();
}

function listValues(values: string[] | undefined): string[] {
  if (!values) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    for (const part of value.split(",")) {
      const clean = part.trim().replace(/\s+/g, " ");
      if (clean && !seen.has(clean.toLowerCase())) {
        seen.add(clean.toLowerCase());
        out.push(clean);
      }
    }
  }
  return out;
}

export function normalizeTypeSlug(value: string): string {
  return value.trim().toLowerCase().replace(/[_\s]+/g, "-");
}

function parseType(value: string): CatalogProductType | null {
  if (!value) return null;
  const normalized = normalizeTypeSlug(value);
  const alias = normalized === "tshirt" || normalized === "t-shirts" ? "t-shirt" : normalized;
  const parsed = typeSlugSchema.safeParse(alias);
  return parsed.success ? PRODUCT_TYPE_SLUGS[parsed.data] : null;
}

export function parsePriceParam(value: string): number | null {
  const cleaned = value.trim().replace(/[₹,\s]/g, "");
  if (!cleaned || !/^\d{1,8}(\.\d{1,2})?$/.test(cleaned)) return null;
  try {
    const paise = parseInrToPaise(cleaned);
    return paise <= MAX_FILTER_PRICE_PAISE ? paise : null;
  } catch {
    return null;
  }
}

export function sortSizes(sizes: string[]): string[] {
  return [...sizes].sort((a, b) => {
    const ai = SIZE_ORDER.indexOf(a);
    const bi = SIZE_ORDER.indexOf(b);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi) || a.localeCompare(b);
  });
}

export interface ParsedCatalogParams {
  filters: CatalogFilters;
  /** Query keys we do not understand. Their presence makes a URL non-canonical. */
  unknownKeys: string[];
  /** True when the URL carries anything besides a plain page number. */
  hasNonPageParams: boolean;
  /** The `page` value exactly as it appeared in the URL (null when absent). */
  rawPage: string | null;
}

export function parseCatalogSearchParams(raw: RawSearchParams): ParsedCatalogParams {
  const values = collect(raw);

  const sortRaw = firstValue(values.get("sort")).toLowerCase();
  const sort = sortSchema.safeParse(sortRaw);

  const page = pageSchema.safeParse(firstValue(values.get("page")) || "1");

  const typeValue = firstValue(values.get("type")) || firstValue(values.get("productType"));

  const sizes = sortSizes(
    listValues(values.get("size"))
      .map((size) => size.toUpperCase())
      .filter((size) => SIZE_SET.has(size)),
  ).slice(0, MAX_FILTER_VALUES);

  const colors = listValues(values.get("color"))
    .map((color) => color.toLowerCase())
    .filter((color) => colorSchema.safeParse(color).success)
    .sort()
    .slice(0, MAX_FILTER_VALUES);

  let minPricePaise = parsePriceParam(firstValue(values.get("minPrice")));
  let maxPricePaise = parsePriceParam(firstValue(values.get("maxPrice")));
  if (minPricePaise != null && maxPricePaise != null && minPricePaise > maxPricePaise) {
    [minPricePaise, maxPricePaise] = [maxPricePaise, minPricePaise];
  }

  const availability = firstValue(values.get("availability")).toLowerCase();
  const categoryRaw = firstValue(values.get("category")).toLowerCase();
  const category = slugSchema.safeParse(categoryRaw);

  const unknownKeys = [...values.keys()].filter((key) => !KNOWN_KEYS.has(key));
  const keys = [...values.keys()];

  return {
    filters: {
      sort: sort.success ? sort.data : DEFAULT_SORT,
      page: page.success ? page.data : 1,
      type: parseType(typeValue),
      sizes,
      colors,
      minPricePaise,
      maxPricePaise,
      availableOnly: availability === "available" || availability === "in-stock",
      category: category.success ? category.data : null,
    },
    unknownKeys,
    hasNonPageParams: keys.some((key) => key !== "page"),
    rawPage: values.has("page") ? firstValue(values.get("page")) : null,
  };
}

export function hasActiveFilters(filters: CatalogFilters): boolean {
  return (
    filters.type !== null ||
    filters.sizes.length > 0 ||
    filters.colors.length > 0 ||
    filters.minPricePaise !== null ||
    filters.maxPricePaise !== null ||
    filters.availableOnly
  );
}

export function activeFilterCount(filters: CatalogFilters): number {
  return (
    (filters.type ? 1 : 0) +
    filters.sizes.length +
    filters.colors.length +
    (filters.minPricePaise !== null || filters.maxPricePaise !== null ? 1 : 0) +
    (filters.availableOnly ? 1 : 0)
  );
}

/** "500" not "500.00" — shorter, friendlier URLs. */
export function paiseToParam(paise: number): string {
  const whole = Math.trunc(paise / 100);
  const frac = paise % 100;
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, "0")}`;
}

const encode = (value: string) => encodeURIComponent(value).replace(/%2C/gi, ",");

/**
 * Canonical query string for a filter state: fixed key order, sorted lists,
 * defaults omitted. Two equal states always serialize identically, which is
 * what keeps cache keys and canonical URLs stable.
 */
export function serializeFilters(
  filters: CatalogFilters,
  options: { includePage?: boolean; includeCategory?: boolean } = {},
): string {
  const parts: string[] = [];
  if (options.includeCategory && filters.category) parts.push(`category=${encode(filters.category)}`);
  if (filters.type) parts.push(`type=${typeToSlug(filters.type)}`);
  if (filters.sizes.length) parts.push(`size=${filters.sizes.map(encode).join(",")}`);
  if (filters.colors.length) parts.push(`color=${filters.colors.map(encode).join(",")}`);
  if (filters.minPricePaise !== null) parts.push(`minPrice=${paiseToParam(filters.minPricePaise)}`);
  if (filters.maxPricePaise !== null) parts.push(`maxPrice=${paiseToParam(filters.maxPricePaise)}`);
  if (filters.availableOnly) parts.push("availability=available");
  if (filters.sort !== DEFAULT_SORT) parts.push(`sort=${filters.sort}`);
  if (options.includePage && filters.page > 1) parts.push(`page=${filters.page}`);
  return parts.join("&");
}

export function buildCatalogHref(
  basePath: string,
  filters: CatalogFilters,
  patch: Partial<CatalogFilters> = {},
  options: { resetPage?: boolean; includeCategory?: boolean } = {},
): string {
  const next: CatalogFilters = { ...filters, ...patch };
  // Any change to what is being listed starts again from page 1 unless a page is given.
  if (options.resetPage !== false && patch.page === undefined) next.page = 1;
  const query = serializeFilters(next, { includePage: true, includeCategory: options.includeCategory });
  return query ? `${basePath}?${query}` : basePath;
}

/* ── API params (validated, capped) ───────────────────────────────────── */

export interface ApiCatalogParams {
  filters: CatalogFilters;
  pageSize: number;
  category: string | null;
  collection: string | null;
}

export function parseApiPageSize(raw: string | null | undefined): number {
  const parsed = z.coerce.number().int().min(1).safeParse(raw ?? "");
  if (!parsed.success) return DEFAULT_PAGE_SIZE;
  return Math.min(parsed.data, MAX_PAGE_SIZE);
}

export function parseApiCatalogParams(params: URLSearchParams): ApiCatalogParams {
  const { filters } = parseCatalogSearchParams(params);
  const slug = (key: string) => {
    const parsed = slugSchema.safeParse((params.get(key) ?? "").trim().toLowerCase());
    return parsed.success ? parsed.data : null;
  };
  return {
    filters,
    pageSize: parseApiPageSize(params.get("pageSize")),
    category: slug("category"),
    collection: slug("collection"),
  };
}
