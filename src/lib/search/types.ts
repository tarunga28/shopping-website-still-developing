/**
 * Shared types for the search & discovery layer.
 *
 * These live in one place because the query pipeline, the ranking engine, the
 * filter engine, and the API all speak the same vocabulary. A type that only one
 * module knows about is how two modules end up disagreeing about what a "filter"
 * is.
 */

/* ── Query understanding ─────────────────────────────────────────────── */

/** What the shopper appears to want. Detected, never assumed. */
export type SearchIntent =
  | "PRODUCT"       // a specific thing: "iphone 17 pro max"
  | "CATEGORY"      // a browsing intent: "gaming laptop"
  | "BRAND"         // "nike"
  | "NAVIGATIONAL"  // an SKU or model number
  | "BROAD";        // too short or too vague to classify

/** A constraint the query placed on the result set. */
export interface PriceConstraint {
  /** Inclusive lower bound in paise. */
  minPaise: number | null;
  /** Inclusive upper bound in paise. */
  maxPaise: number | null;
  /** The exact text that produced this, e.g. "under 100000". */
  source: string;
}

export interface ExtractedEntity {
  kind: "BRAND" | "CATEGORY" | "ATTRIBUTE" | "COLOR" | "SIZE" | "GENDER" | "MATERIAL";
  /** The matched text as it appeared in the query. */
  matched: string;
  /** The canonical value, e.g. matched "blak" -> value "black". */
  value: string;
  /** Attribute axis code when `kind` is ATTRIBUTE. */
  axis?: string;
  /** Database id when the entity resolved to a real row. */
  id?: string;
  /** 0..1 — how sure the extraction is. Low-confidence entities are not applied. */
  confidence: number;
}

/** A single spell correction that was applied. */
export interface QueryCorrection {
  from: string;
  to: string;
  /** Edit distance between the two. */
  distance: number;
  /** How common the corrected term is; rare corrections are suspect. */
  documentCount: number;
}

/**
 * The vocabulary the engine actually searches with.
 *
 * `remainingTerms` is what is left after entities and price constraints have
 * been pulled out, and it is what gets matched against the index. Keeping it
 * separate from the raw query is what stops a brand name being searched for as
 * a keyword *and* applied as a filter.
 */
export interface ProcessedQuery {
  /** Exactly what the user typed, sanitized for length and control characters. */
  raw: string;
  /** Lowercased, folded, whitespace-collapsed. */
  normalized: string;
  /** Sorted, deduplicated tokens — the cache key and the analytics key. */
  canonical: string;
  tokens: string[];
  /** Terms left after entity and price extraction. */
  remainingTerms: string[];
  intent: SearchIntent;
  entities: ExtractedEntity[];
  price: PriceConstraint | null;
  corrections: QueryCorrection[];
  /** The query as it should be re-run after corrections. Null when unchanged. */
  correctedQuery: string | null;
  /** Terms expanded by synonyms. */
  synonymsApplied: string[];
  /** True when the query is a bare SKU/barcode and should match exactly. */
  isExactIdentifier: boolean;
}

/* ── Filters ─────────────────────────────────────────────────────────── */

export type AvailabilityFilter = "any" | "in_stock" | "out_of_stock" | "on_sale";

/** A single facet dimension's value and its match count. */
export interface FacetValue {
  value: string;
  label: string;
  count: number;
  /** Database id when the value maps to a row (brand, category). */
  id?: string;
  /** True when the shopper already selected this value. */
  selected: boolean;
}

export interface FacetGroup {
  /** Stable key used in the URL, e.g. "brand", "color", "storage". */
  key: string;
  label: string;
  /** Whether more than one value may be selected. */
  multi: boolean;
  values: FacetValue[];
}

export interface PriceFacet {
  minPaise: number;
  maxPaise: number;
  buckets: Array<{ label: string; minPaise: number | null; maxPaise: number | null; count: number }>;
}

export interface SearchFilters {
  categoryIds: string[];
  brandIds: string[];
  minPricePaise: number | null;
  maxPricePaise: number | null;
  minRating: number | null;
  availability: AvailabilityFilter;
  onSaleOnly: boolean;
  /** axis code -> selected values, e.g. { color: ["black"], storage: ["256gb"] }. */
  attributes: Record<string, string[]>;
}

export interface SearchFacets {
  groups: FacetGroup[];
  price: PriceFacet | null;
  /** Total matches before facet narrowing — what "123 results" means. */
  total: number;
}

/* ── Ranking ─────────────────────────────────────────────────────────── */

/**
 * The complete set of ranking signals.
 *
 * Declared as a closed list rather than a free-form record so that adding a
 * weight without implementing the signal is a type error, and so a stored
 * configuration containing an unknown key can be rejected instead of silently
 * ignored.
 */
export type RankingWeightKey =
  // Text relevance (layer 1)
  | "exactSku"
  | "exactName"
  | "prefixName"
  | "tokenName"
  | "descriptionMatch"
  // Entity relevance (layer 2)
  | "exactBrand"
  | "exactCategory"
  | "attributeMatch"
  | "tagMatch"
  // Commercial (layer 4)
  | "popularity"
  | "salesVelocity"
  // Quality (layer 5)
  | "rating"
  | "reviewVolume"
  | "freshness"
  // Penalties
  | "fuzzyPenalty"
  | "outOfStockPenalty";

export type RankingWeights = Record<RankingWeightKey, number>;

/** How unavailable products are treated. */
export type OutOfStockMode = "HIDE" | "DEMOTE" | "ONLY_IF_EMPTY";

export interface RankingConfig {
  version: string;
  label: string;
  weights: RankingWeights;
  outOfStockMode: OutOfStockMode;
  /** Minimum trigram similarity before fuzzy matching is attempted. */
  fuzzyThreshold: number;
  /** Maximum edit distance for spell correction. 0 disables correction. */
  maxEditDistance: number;
}

/** Which ranking layers contributed, for debugging and the admin view. */
export interface ScoreBreakdown {
  text: number;
  entity: number;
  availability: number;
  commercial: number;
  quality: number;
  personalization: number;
  penalties: number;
  total: number;
}

/* ── Results ─────────────────────────────────────────────────────────── */

export type SearchSort =
  | "relevance"
  | "popularity"
  | "newest"
  | "price-asc"
  | "price-desc"
  | "rating"
  | "discount"
  | "best-selling";

export const SEARCH_SORTS: readonly SearchSort[] = [
  "relevance",
  "popularity",
  "newest",
  "price-asc",
  "price-desc",
  "rating",
  "discount",
  "best-selling",
];

export interface SearchProductHit {
  productId: string;
  slug: string;
  name: string;
  brandName: string | null;
  categoryPath: string | null;
  pricePaise: number;
  compareAtPaise: number | null;
  ratingAverage: number | null;
  ratingCount: number;
  inStock: boolean;
  /**
   * Primary image, resolved during recall.
   *
   * Fetched with the result set rather than per card: a results page asking for
   * twenty images in twenty requests is the N+1 that makes a search feel slow.
   */
  imageUrl: string | null;
  imageAlt: string | null;
  /** Relevance score. Comparable only within one response. */
  score: number;
  /** 1-based position in the returned page, for click attribution. */
  position: number;
  /** Which signals fired. Exposed to the admin "why this result?" view. */
  breakdown: ScoreBreakdown;
  matchedOn: string[];
  /** True when this hit came from a fuzzy/corrected match rather than an exact one. */
  fuzzy: boolean;
}

export interface SuggestionItem {
  /** How the frontend should render it. */
  type: "PRODUCT" | "BRAND" | "CATEGORY" | "SEARCH_QUERY" | "TRENDING_QUERY" | "HISTORY";
  text: string;
  /** Where to go when chosen. Null for a pure query suggestion. */
  href: string | null;
  /** Product thumbnail or brand logo, when there is one. */
  imageUrl: string | null;
  /** Secondary line, e.g. "in Smartphones" or "1,204 searches". */
  meta: string | null;
  /** Sort weight; higher first. */
  weight: number;
}

export interface SearchMetadata {
  /** The query actually executed, after correction. */
  query: string;
  normalizedQuery: string;
  correctedQuery: string | null;
  wasCorrected: boolean;
  intent: SearchIntent;
  /** Ranking version that produced these results. */
  rankingVersion: string;
  experimentVariant: string | null;
  tookMs: number;
  /** Total matches, or an estimate for very large result sets. */
  total: number;
  totalIsEstimate: boolean;
  nextCursor: string | null;
  previousCursor: string | null;
  sort: SearchSort;
  limit: number;
  /** Set when the engine was unavailable and results came from a fallback. */
  degraded: boolean;
  degradeReason: string | null;
  /** Query log id, so a subsequent click can be attributed to this search. */
  searchLogId: string | null;
  detectedEntities: ExtractedEntity[];
  appliedPrice: PriceConstraint | null;
}

export interface SearchResponsePayload {
  query: string;
  correctedQuery: string | null;
  results: SearchProductHit[];
  facets: SearchFacets;
  suggestions: SuggestionItem[];
  nextCursor: string | null;
  metadata: SearchMetadata;
}
