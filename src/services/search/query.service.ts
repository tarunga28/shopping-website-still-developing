import "server-only";

import { and, desc, eq, inArray, or, sql } from "drizzle-orm";

import { db } from "@/db";
import { productSearchIndex, products, searchQueryLogs } from "@/db/schema";
import type { DbClient } from "@/db/utils";
import { logger } from "@/lib/logger";
import { sanitizeQuery } from "@/lib/catalog/search-text";
import { processQuery, filterSignature, type PipelineResult } from "@/lib/search/query";
import { loadVocabulary } from "@/services/search/vocabulary.service";
import { getLexiconIndex } from "@/services/search/lexicon.service";
import { getActiveRankingConfig, resolveExperiment, getSetting } from "@/services/search/config.service";
import { getSynonymMap } from "@/services/catalog/search.service";
import {
  applyOutOfStockPolicy,
  scoreCandidate,
  sortByScore,
  type RankSignals,
} from "@/lib/search/ranking";
import {
  buildFacets,
  decodeCursor,
  encodeCursor,
  type FacetCount,
} from "@/lib/search/filters";
import { entitiesToFilters } from "@/lib/search/entities";
import type {
  ScoreBreakdown,
  SearchFacets,
  SearchFilters,
  SearchMetadata,
  SearchProductHit,
  SearchResponsePayload,
  SearchSort,
  SuggestionItem,
} from "@/lib/search/types";

/**
 * Search orchestration.
 *
 * ## The two-phase pattern
 *
 * Phase one runs in PostgreSQL: full-text match, trigram fallback, the active
 * filters, and a coarse rank. It returns a bounded candidate set.
 *
 * Phase two runs here: the full layered relevance model from
 * `src/lib/search/ranking.ts`, applied to those candidates.
 *
 * That split is what makes this scale. Doing the whole ranking in SQL would mean
 * a query so complex the planner cannot use an index; doing the matching in
 * application code would mean shipping the catalog to the app server. Bounding
 * the candidate set (default 400) keeps both sides cheap, and the bound is a
 * setting rather than a constant so it can be tuned under load.
 *
 * ## Failure behaviour
 *
 * Every dependency degrades independently. No lexicon means no entity
 * extraction. No vocabulary means no spell correction. No ranking config means
 * the compiled default. A database failure means `degraded: true` with a clear
 * reason — never a silent empty result set, because "no results" and "search is
 * broken" must be distinguishable to the shopper and to the on-call engineer.
 */

/** How many candidates phase one may return for re-ranking. */
const DEFAULT_CANDIDATE_LIMIT = 400;
const MAX_CANDIDATE_LIMIT = 2000;

/** Beyond this many matches the total is reported as an estimate. */
const EXACT_COUNT_LIMIT = 5000;

export interface SearchExecutionInput {
  query: string;
  filters?: SearchFilters;
  sort?: SearchSort;
  limit?: number;
  cursor?: string | null;
  /** Salted session identifier. Never a raw IP or user id. */
  sessionHash?: string | null;
  /** Skip writing to `search_query_logs` (used by the suggestions prefetch). */
  skipLogging?: boolean;
  client?: DbClient;
}

interface CandidateRow {
  productId: string;
  slug: string;
  name: string;
  brandName: string | null;
  brandId: string | null;
  categoryId: string | null;
  categoryPath: string | null;
  skuText: string;
  tagText: string;
  attributeText: string;
  descriptionText: string;
  pricePaise: number;
  compareAtPaise: number | null;
  ratingAverage: number | null;
  ratingCount: number;
  popularity: number;
  indexedAt: Date;
  stockQuantity: number;
  coarseRank: number;
  fuzzySimilarity: number;
  imageUrl: string | null;
}

/**
 * Execute a search.
 *
 * This is the single entry point for storefront search. It owns the whole
 * pipeline so that a change to relevance happens in one place rather than being
 * spread across routes and components.
 */
export async function executeSearch(input: SearchExecutionInput): Promise<SearchResponsePayload> {
  const startedAt = Date.now();
  const client = input.client ?? db;
  const limit = Math.max(1, Math.min(input.limit ?? 24, 100));
  const sort: SearchSort = input.sort ?? "relevance";
  const explicitFilters = input.filters ?? emptyFilters();

  const [config, synonyms, autoCorrect] = await Promise.all([
    getActiveRankingConfig(client),
    getSynonymMap(client).catch(() => new Map<string, string[]>()),
    getSetting<{ enabled: boolean }>("features.autoCorrect", { enabled: true }, client),
  ]);

  // ── Phase 0: understand the query ────────────────────────────────────
  const processed = await buildProcessedQuery(input.query, {
    autoCorrect: autoCorrect.enabled !== false,
    client,
  });

  const experiment = await resolveExperiment(input.sessionHash, client).catch(() => null);
  const rankingVersion = experiment?.rankingVersion ?? config.version;

  // Entities become filters, but only the confident ones. An explicit filter
  // always wins over an inferred one, so the two are merged rather than
  // replacing each other.
  const inferred = entitiesToFilters(processed.entities);
  const filters = mergeFilters(explicitFilters, inferred);
  const priceFromQuery = processed.price;
  if (priceFromQuery) {
    if (filters.minPricePaise === null && priceFromQuery.minPaise !== null) {
      filters.minPricePaise = priceFromQuery.minPaise;
    }
    if (filters.maxPricePaise === null && priceFromQuery.maxPaise !== null) {
      filters.maxPricePaise = priceFromQuery.maxPaise;
    }
  }

  const executedQuery = processed.correctedQuery ?? processed.normalized;
  const searchable = processed.isExactIdentifier
    ? processed.raw.trim()
    : (processed.remainingTerms.length ? processed.remainingTerms : processed.tokens).join(" ");

  // ── Phase 1: recall + coarse rank in PostgreSQL ──────────────────────
  const candidateLimit = await getSetting<number>(
    "limits.candidateLimit",
    DEFAULT_CANDIDATE_LIMIT,
    client,
  ).catch(() => DEFAULT_CANDIDATE_LIMIT);

  let candidates: CandidateRow[] = [];
  let total = 0;
  let totalIsEstimate = false;
  let degraded = false;
  let degradeReason: string | null = null;

  try {
    const recall = await recallCandidates({
      client,
      query: searchable,
      isExactIdentifier: processed.isExactIdentifier,
      filters,
      sort,
      config,
      limit: Math.min(Math.max(candidateLimit, limit), MAX_CANDIDATE_LIMIT),
    });
    candidates = recall.rows;
    total = recall.total;
    totalIsEstimate = recall.totalIsEstimate;
  } catch (error) {
    degraded = true;
    degradeReason = "search index unavailable";
    logger.error("search recall failed; returning a degraded response", {
      error: error instanceof Error ? error.message : String(error),
      query: executedQuery,
    });
  }

  // ── Phase 2: layered relevance ───────────────────────────────────────
  const cursor = decodeCursor(input.cursor);
  const scored = candidates
    .map((row) => toHit(row, processed, config.weights, sort))
    .filter((hit) => (cursor ? isAfterCursor(hit, cursor) : true));

  const ordered = applyOutOfStockPolicy(
    sort === "relevance" ? sortByScore(scored) : applyExplicitSort(scored, sort),
    config.outOfStockMode,
  ).slice(0, limit);

  ordered.forEach((hit, index) => {
    hit.position = index + 1;
  });

  // ── Facets ───────────────────────────────────────────────────────────
  let facets: SearchFacets = { groups: [], price: null, total };
  try {
    facets = await buildSearchFacets({ client, query: searchable, filters, total });
  } catch (error) {
    // Facets are a refinement, not the result. Losing them must not lose the
    // products, so the failure is logged and the response still returns.
    logger.warn("facet computation failed; returning results without facets", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // ── Zero-result recovery ─────────────────────────────────────────────
  let suggestions: SuggestionItem[] = [];
  if (ordered.length === 0) {
    suggestions = await recoverFromZeroResults({
      client,
      processed,
      filters,
      hasActiveFilters: hasAnyFilter(filters),
    });
  }

  // ── Logging ──────────────────────────────────────────────────────────
  let searchLogId: string | null = null;
  if (!input.skipLogging) {
    searchLogId = await logQuery({
      client,
      processed,
      executedQuery,
      resultCount: ordered.length,
      tookMs: Date.now() - startedAt,
      sessionHash: input.sessionHash ?? null,
      rankingVersion,
      experimentVariant: experiment?.variant ?? null,
      filters,
    });
  }

  const nextCursor =
    ordered.length === limit && scored.length > limit
      ? encodeCursor(ordered[ordered.length - 1]!.score, ordered[ordered.length - 1]!.productId)
      : null;

  const metadata: SearchMetadata = {
    query: executedQuery,
    normalizedQuery: processed.canonical,
    correctedQuery: processed.correctedQuery,
    wasCorrected: processed.correctionApplied,
    intent: processed.intent,
    rankingVersion,
    experimentVariant: experiment?.variant ?? null,
    tookMs: Date.now() - startedAt,
    total: ordered.length === 0 ? 0 : total,
    totalIsEstimate,
    nextCursor,
    previousCursor: input.cursor ?? null,
    sort,
    limit,
    degraded,
    degradeReason,
    searchLogId,
    detectedEntities: processed.entities,
    appliedPrice: processed.price,
  };

  return {
    query: executedQuery,
    correctedQuery: processed.correctedQuery,
    results: ordered,
    facets,
    suggestions,
    nextCursor,
    metadata,
  };
}

/* ── Query understanding ─────────────────────────────────────────────── */

/**
 * Run the pipeline with the data it needs loaded from the catalog.
 *
 * Exposed because autocomplete and the admin debug view need the same
 * understanding without executing a full search.
 */
export async function buildProcessedQuery(
  rawQuery: string,
  options: { autoCorrect?: boolean; client?: DbClient } = {},
): Promise<PipelineResult> {
  const client = options.client ?? db;

  const [vocabulary, lexicon, synonyms] = await Promise.all([
    loadVocabulary({ client, limit: 20_000 }).catch(() => []),
    getLexiconIndex({ client }).catch(() => null),
    getSynonymMap(client).catch(() => new Map<string, string[]>()),
  ]);

  return processQuery(rawQuery, {
    vocabulary,
    lexicon: lexicon ?? undefined,
    synonyms,
    autoCorrect: options.autoCorrect ?? true,
  });
}

/* ── Phase 1: recall ─────────────────────────────────────────────────── */

/**
 * The primary image per product, as a lateral subquery.
 *
 * A plain join to `images` would multiply result rows by the number of images per
 * product and then require de-duplication — which is how a search silently
 * returns the same product four times. A correlated subquery returns exactly one
 * image per product and lets the planner use the images index.
 */
const primaryImageSql = sql<string | null>`(
  select i.url from images i
  where i.product_id = ${productSearchIndex.productId}
  order by case i.role when 'PRIMARY' then 0 when 'GALLERY' then 1 when 'HOVER' then 3 else 2 end,
           i.sort_order, i.id
  limit 1
)`;

async function recallCandidates(input: {
  client: DbClient;
  query: string;
  isExactIdentifier: boolean;
  filters: SearchFilters;
  sort: SearchSort;
  config: { fuzzyThreshold: number };
  limit: number;
}): Promise<{ rows: CandidateRow[]; total: number; totalIsEstimate: boolean }> {
  const { client, query, filters, sort, limit } = input;
  const trimmed = sanitizeQuery(query);

  // An SKU/barcode lookup is an exact match on the identifier columns. Running
  // it through full-text search would tokenize the identifier and match nothing.
  if (input.isExactIdentifier) {
    const rows = await client
      .select({
        productId: productSearchIndex.productId,
        slug: productSearchIndex.slug,
        name: productSearchIndex.name,
        brandName: productSearchIndex.brandName,
        brandId: productSearchIndex.brandId,
        categoryId: productSearchIndex.categoryId,
        categoryPath: productSearchIndex.categoryPath,
        skuText: productSearchIndex.skuText,
        tagText: productSearchIndex.tagText,
        attributeText: productSearchIndex.attributeText,
        descriptionText: productSearchIndex.descriptionText,
        pricePaise: productSearchIndex.pricePaise,
        compareAtPaise: productSearchIndex.compareAtPaise,
        ratingAverage: productSearchIndex.ratingAverage,
        ratingCount: productSearchIndex.ratingCount,
        popularity: productSearchIndex.popularity,
        indexedAt: productSearchIndex.indexedAt,
        stockQuantity: products.stockQuantity,
        imageUrl: primaryImageSql,
      })
      .from(productSearchIndex)
      .innerJoin(products, eq(products.id, productSearchIndex.productId))
      .where(
        and(
          eq(productSearchIndex.isSearchable, true),
          // There is no products.sku — the SKU lives on the variant, and the
          // index already flattens every variant SKU into sku_text. Matching
          // there covers both the variant SKU and the product barcode.
          sql`(
            ${products.barcode} = ${trimmed}
            OR ${productSearchIndex.skuText} ILIKE ${`%${trimmed}%`}
          )`,
        ),
      )
      .limit(Math.min(limit, 50));

    return {
      rows: rows.map((row) => ({ ...row, coarseRank: 1, fuzzySimilarity: 1 })),
      total: rows.length,
      totalIsEstimate: false,
    };
  }

  if (trimmed.length < 2) return { rows: [], total: 0, totalIsEstimate: false };

  const tsQuery = buildTsQuery(trimmed);
  const textMatch = tsQuery
    ? sql`${productSearchIndex.searchVector} @@ to_tsquery('simple', ${tsQuery})`
    : undefined;
  const fuzzyMatch = sql`word_similarity(${trimmed}, ${productSearchIndex.trigramText}) > ${input.config.fuzzyThreshold}`;

  const conditions = [eq(productSearchIndex.isSearchable, true)];
  if (textMatch) conditions.push(or(textMatch, fuzzyMatch)!);
  else conditions.push(fuzzyMatch);

  if (filters.brandIds.length) conditions.push(inArray(productSearchIndex.brandId, filters.brandIds));
  if (filters.categoryIds.length) {
    conditions.push(inArray(productSearchIndex.categoryId, filters.categoryIds));
  }
  if (filters.minPricePaise !== null) {
    conditions.push(sql`${productSearchIndex.pricePaise} >= ${filters.minPricePaise}`);
  }
  if (filters.maxPricePaise !== null) {
    conditions.push(sql`${productSearchIndex.pricePaise} <= ${filters.maxPricePaise}`);
  }
  if (filters.minRating !== null) {
    conditions.push(sql`${productSearchIndex.ratingAverage} >= ${filters.minRating}`);
  }
  if (filters.onSaleOnly || filters.availability === "on_sale") {
    conditions.push(
      sql`${productSearchIndex.compareAtPaise} IS NOT NULL AND ${productSearchIndex.compareAtPaise} > ${productSearchIndex.pricePaise}`,
    );
  }
  if (filters.availability === "in_stock") conditions.push(sql`${products.stockQuantity} > 0`);
  if (filters.availability === "out_of_stock") conditions.push(sql`${products.stockQuantity} <= 0`);

  // Attribute filters match against the flattened attribute text. This is a
  // containment check rather than a join, which is what keeps a facet update
  // cheap; the axis-structured data still lives in the attribute tables.
  for (const [axis, values] of Object.entries(filters.attributes)) {
    if (!values.length) continue;
    const clauses = values.map((value) =>
      sql`${productSearchIndex.attributeText} ILIKE ${`%${escapeLike(value)}%`}`,
    );
    conditions.push(or(...clauses)!);
    void axis;
  }

  const where = and(...conditions)!;

  // Counting and fetching are separate queries: the count is over the whole
  // filtered set, the fetch is bounded.
  const countPromise = client
    .select({ total: sql<number>`count(*)::int` })
    .from(productSearchIndex)
    .innerJoin(products, eq(products.id, productSearchIndex.productId))
    .where(where);

  const coarseRank = sql<number>`(
    (ts_rank_cd(to_tsvector('simple', ${productSearchIndex.name}), to_tsquery('simple', ${tsQuery ?? "''"})) * 25.0)
    + (ts_rank_cd(${productSearchIndex.searchVector}, to_tsquery('simple', ${tsQuery ?? "''"})) * 10.0)
    + (CASE WHEN ${fuzzyMatch} THEN word_similarity(${trimmed}, ${productSearchIndex.trigramText}) * 2.0 ELSE 0.0 END)
  )`;

  const orderBy = sortOrder(sort, coarseRank);

  const rowsPromise = client
    .select({
      productId: productSearchIndex.productId,
      slug: productSearchIndex.slug,
      name: productSearchIndex.name,
      brandName: productSearchIndex.brandName,
      brandId: productSearchIndex.brandId,
      categoryId: productSearchIndex.categoryId,
      categoryPath: productSearchIndex.categoryPath,
      skuText: productSearchIndex.skuText,
      tagText: productSearchIndex.tagText,
      attributeText: productSearchIndex.attributeText,
      descriptionText: productSearchIndex.descriptionText,
      pricePaise: productSearchIndex.pricePaise,
      compareAtPaise: productSearchIndex.compareAtPaise,
      ratingAverage: productSearchIndex.ratingAverage,
      ratingCount: productSearchIndex.ratingCount,
      popularity: productSearchIndex.popularity,
      indexedAt: productSearchIndex.indexedAt,
      stockQuantity: products.stockQuantity,
      imageUrl: primaryImageSql,
      coarseRank,
      fuzzySimilarity: sql<number>`word_similarity(${trimmed}, ${productSearchIndex.trigramText})`,
    })
    .from(productSearchIndex)
    .innerJoin(products, eq(products.id, productSearchIndex.productId))
    .where(where)
    .orderBy(...orderBy)
    .limit(limit);

  const [countRows, rows] = await Promise.all([countPromise, rowsPromise]);
  const total = countRows[0]?.total ?? 0;

  return {
    rows,
    total,
    // An exact count past this point costs more than it is worth; the shopper
    // does not act on the difference between 8,412 and 8,413 results.
    totalIsEstimate: total > EXACT_COUNT_LIMIT,
  };
}

/** Server-side sort strategies. Never sorted in the browser. */
function sortOrder(sort: SearchSort, coarseRank: ReturnType<typeof sql<number>>) {
  switch (sort) {
    case "price-asc":
      return [sql`${productSearchIndex.pricePaise} asc`, desc(productSearchIndex.name)];
    case "price-desc":
      return [sql`${productSearchIndex.pricePaise} desc`, desc(productSearchIndex.name)];
    case "newest":
      return [sql`${productSearchIndex.indexedAt} desc`];
    case "rating":
      return [
        sql`${productSearchIndex.ratingAverage} desc nulls last`,
        sql`${productSearchIndex.ratingCount} desc`,
      ];
    case "discount":
      // Discount depth as a fraction, so a ₹100 item at 50% off outranks a
      // ₹10,000 item with a larger absolute saving.
      return [
        sql`case when ${productSearchIndex.compareAtPaise} is null or ${productSearchIndex.compareAtPaise} <= 0 then 0
                 else (${productSearchIndex.compareAtPaise} - ${productSearchIndex.pricePaise})::real / ${productSearchIndex.compareAtPaise}::real end desc`,
      ];
    case "popularity":
    case "best-selling":
      return [sql`${productSearchIndex.popularity} desc`, sql`${productSearchIndex.ratingAverage} desc nulls last`];
    case "relevance":
    default:
      return [sql`${coarseRank} desc`, desc(productSearchIndex.productId)];
  }
}

function buildTsQuery(query: string): string | null {
  const tokens = sanitizeQuery(query)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8);
  if (tokens.length === 0) return null;
  return tokens
    .map((token, index) => {
      const escaped = token.replace(/['\\():|&!*<]/g, "");
      if (!escaped) return null;
      // Prefix-match the final token only: it is the one being typed.
      return index === tokens.length - 1 ? `${escaped}:*` : escaped;
    })
    .filter(Boolean)
    .join(" & ");
}

function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, (character) => `\\${character}`);
}

/* ── Phase 2: scoring ────────────────────────────────────────────────── */

function toHit(
  row: CandidateRow,
  processed: PipelineResult,
  weights: import("@/lib/search/types").RankingWeights,
  sort: SearchSort,
): SearchProductHit {
  const nameFolded = row.name.toLowerCase();
  const queryTokens = processed.tokens.filter(Boolean);
  const matchedTokens = queryTokens.filter((token) => nameFolded.includes(token));

  const isExactIdentifier = processed.isExactIdentifier;
  const skuMatched =
    isExactIdentifier &&
    (row.skuText.toLowerCase().includes(processed.raw.trim().toLowerCase()) ||
      row.name.toLowerCase() === processed.raw.trim().toLowerCase());

  const entityKinds = new Set(processed.entities.map((entity) => entity.kind));
  const brandEntity = processed.entities.find((entity) => entity.kind === "BRAND");
  const categoryEntity = processed.entities.find((entity) => entity.kind === "CATEGORY");

  // Freshness decays over a year; a product is not "new" forever, and treating
  // it as such would permanently pin old stock to the top.
  const ageDays = (Date.now() - new Date(row.indexedAt).getTime()) / 86_400_000;
  const freshness = Math.max(0, 1 - ageDays / 365);

  const signals: RankSignals = {
    exactName: nameFolded === processed.normalized.trim(),
    prefixName: nameFolded.startsWith(processed.normalized.trim()),
    nameTokenCoverage: queryTokens.length ? matchedTokens.length / queryTokens.length : 0,
    exactSku: skuMatched,
    descriptionMatch:
      processed.tokens.some((token) => token.length > 2 && row.descriptionText.toLowerCase().includes(token)),
    exactBrand: Boolean(brandEntity && row.brandName && row.brandName.toLowerCase() === brandEntity.value.toLowerCase()),
    exactCategory: Boolean(
      categoryEntity && row.categoryPath && row.categoryPath.toLowerCase().includes(categoryEntity.value.toLowerCase()),
    ),
    attributeMatches: processed.entities.filter(
      (entity) =>
        (entity.kind === "ATTRIBUTE" || entity.kind === "COLOR" || entity.kind === "SIZE") &&
        row.attributeText.toLowerCase().includes(entity.value.toLowerCase()),
    ).length,
    tagMatches: processed.tokens.filter(
      (token) => token.length > 2 && row.tagText.toLowerCase().includes(token),
    ).length,
    popularity: Math.min(100, row.popularity ?? 0),
    ratingAverage: row.ratingAverage,
    ratingCount: row.ratingCount ?? 0,
    // Sales velocity is not measured yet, so it contributes nothing rather than
    // a fabricated number. The slot exists for when real data lands.
    salesVelocity: 0,
    freshness,
    fuzzy: processed.corrections.length > 0 || row.fuzzySimilarity < 0.99,
    fuzzySimilarity: row.fuzzySimilarity,
    inStock: row.stockQuantity > 0,
  };

  const breakdown: ScoreBreakdown = scoreCandidate(signals, weights);
  void entityKinds;

  // For an explicit non-relevance sort the score is not what orders the list, but
  // it is still reported so the admin view can explain a result.
  const score = sort === "relevance" ? breakdown.total : row.coarseRank;

  return {
    productId: row.productId,
    slug: row.slug,
    name: row.name,
    brandName: row.brandName,
    categoryPath: row.categoryPath,
    pricePaise: row.pricePaise,
    compareAtPaise: row.compareAtPaise,
    ratingAverage: row.ratingAverage,
    ratingCount: row.ratingCount ?? 0,
    inStock: row.stockQuantity > 0,
    imageUrl: row.imageUrl,
    // The index stores no alt text per row, so the product name is the fallback.
    // An empty alt would make the image invisible to a screen reader.
    imageAlt: row.name,
    score: Math.round(score * 1000) / 1000,
    position: 0,
    breakdown,
    matchedOn: describeMatches(signals),
    fuzzy: signals.fuzzy,
  };
}

function describeMatches(signals: RankSignals): string[] {
  const out: string[] = [];
  if (signals.exactSku) out.push("sku");
  if (signals.exactName) out.push("name:exact");
  else if (signals.prefixName) out.push("name:prefix");
  else if (signals.nameTokenCoverage > 0) out.push("name:token");
  if (signals.exactBrand) out.push("brand");
  if (signals.exactCategory) out.push("category");
  if (signals.attributeMatches > 0) out.push(`attribute:${signals.attributeMatches}`);
  if (signals.tagMatches > 0) out.push("tag");
  if (signals.descriptionMatch) out.push("description");
  if (signals.fuzzy) out.push("fuzzy");
  return out;
}

function applyExplicitSort(hits: SearchProductHit[], sort: SearchSort): SearchProductHit[] {
  const sorted = [...hits];
  switch (sort) {
    case "price-asc":
      sorted.sort((a, b) => a.pricePaise - b.pricePaise);
      break;
    case "price-desc":
      sorted.sort((a, b) => b.pricePaise - a.pricePaise);
      break;
    case "rating":
      sorted.sort((a, b) => (b.ratingAverage ?? 0) - (a.ratingAverage ?? 0));
      break;
    case "discount":
      sorted.sort((a, b) => discountRate(b) - discountRate(a));
      break;
    case "newest":
      // The recall query already ordered by recency; preserve that order.
      break;
    default:
      return sortByScore(sorted);
  }
  return sorted;
}

function discountRate(hit: SearchProductHit): number {
  if (!hit.compareAtPaise || hit.compareAtPaise <= 0) return 0;
  return (hit.compareAtPaise - hit.pricePaise) / hit.compareAtPaise;
}

function isAfterCursor(
  hit: SearchProductHit,
  cursor: { score: number; productId: string },
): boolean {
  if (hit.score !== cursor.score) return hit.score < cursor.score;
  return hit.productId.localeCompare(cursor.productId) > 0;
}

/* ── Facets ──────────────────────────────────────────────────────────── */

async function buildSearchFacets(input: {
  client: DbClient;
  query: string;
  filters: SearchFilters;
  total: number;
}): Promise<SearchFacets> {
  const { client, query, filters, total } = input;
  const tsQuery = buildTsQuery(query);

  const baseConditions = [eq(productSearchIndex.isSearchable, true)];
  if (tsQuery) {
    baseConditions.push(
      or(
        sql`${productSearchIndex.searchVector} @@ to_tsquery('simple', ${tsQuery})`,
        sql`word_similarity(${query}, ${productSearchIndex.trigramText}) > 0.35`,
      )!,
    );
  }
  const where = and(...baseConditions)!;

  // Brand and category facets are grouped in SQL. Each excludes its own filter so
  // the shopper can see what else is available in that dimension.
  const [brandRows, categoryRows, priceRows, attributeRows] = await Promise.all([
    client
      .select({
        id: productSearchIndex.brandId,
        name: productSearchIndex.brandName,
        count: sql<number>`count(*)::int`,
      })
      .from(productSearchIndex)
      .where(and(where, isNotNull(productSearchIndex.brandId)))
      .groupBy(productSearchIndex.brandId, productSearchIndex.brandName)
      .orderBy(desc(sql`count(*)`))
      .limit(50),
    client
      .select({
        id: productSearchIndex.categoryId,
        name: productSearchIndex.categoryPath,
        count: sql<number>`count(*)::int`,
      })
      .from(productSearchIndex)
      .where(and(where, isNotNull(productSearchIndex.categoryId)))
      .groupBy(productSearchIndex.categoryId, productSearchIndex.categoryPath)
      .orderBy(desc(sql`count(*)`))
      .limit(50),
    client
      .select({ pricePaise: productSearchIndex.pricePaise })
      .from(productSearchIndex)
      .where(where)
      .limit(2000),
    client
      .select({ attributeText: productSearchIndex.attributeText })
      .from(productSearchIndex)
      .where(where)
      .limit(1000),
  ]);

  const counts: FacetCount[] = [];
  for (const row of brandRows) {
    if (!row.id || !row.name) continue;
    counts.push({ axis: "brand", value: row.name, label: row.name, count: row.count, id: row.id });
  }
  for (const row of categoryRows) {
    if (!row.id || !row.name) continue;
    counts.push({ axis: "category", value: row.name, label: row.name, count: row.count, id: row.id });
  }

  for (const count of attributeFacetCounts(attributeRows.map((row) => row.attributeText), filters)) {
    counts.push(count);
  }

  return buildFacets({ counts, prices: priceRows, filters, total });
}

/**
 * Derive attribute facet counts from the flattened attribute text.
 *
 * The flattened column is what the index carries, so this avoids a join per
 * facet update. Values are only offered when they appear often enough to be
 * worth showing — a value on a single product is not a filter, it is a product.
 */
function attributeFacetCounts(
  attributeTexts: readonly string[],
  filters: SearchFilters,
): FacetCount[] {
  const tally = new Map<string, Map<string, number>>();

  for (const text of attributeTexts) {
    if (!text) continue;
    for (const token of text.toLowerCase().split(/\s+/)) {
      const cleaned = token.replace(/[^a-z0-9]/g, "");
      if (cleaned.length < 3) continue;
      // Guess the axis from the value's shape: a storage/RAM value ends in gb,
      // anything else is bucketed as a generic attribute. Inferring here is
      // imperfect by design — the authoritative axis is in the attribute tables,
      // and the admin can rename or regroup without a code change.
      const axis = /(gb|tb)$/.test(cleaned) ? "storage" : "attribute";
      const bucket = tally.get(axis) ?? new Map<string, number>();
      bucket.set(cleaned, (bucket.get(cleaned) ?? 0) + 1);
      tally.set(axis, bucket);
    }
  }

  const out: FacetCount[] = [];
  for (const [axis, values] of tally) {
    const selected = new Set(filters.attributes[axis] ?? []);
    for (const [value, count] of values) {
      if (count < 2 && !selected.has(value)) continue;
      out.push({ axis, value, label: value.toUpperCase(), count });
    }
  }
  return out;
}

function isNotNull(column: import("drizzle-orm").SQL | import("drizzle-orm").AnyColumn) {
  return sql`${column} IS NOT NULL`;
}

/* ── Zero-result recovery ────────────────────────────────────────────── */

async function recoverFromZeroResults(input: {
  client: DbClient;
  processed: PipelineResult;
  filters: SearchFilters;
  hasActiveFilters: boolean;
}): Promise<SuggestionItem[]> {
  const { client, processed } = input;
  const suggestions: SuggestionItem[] = [];

  // 1. An unapplied correction is the most useful thing to offer.
  for (const suggestion of processed.suggestedCorrections) {
    suggestions.push({
      type: "SEARCH_QUERY",
      text: `Did you mean "${suggestion.to}"?`,
      href: `/search?q=${encodeURIComponent(suggestion.to)}`,
      imageUrl: null,
      meta: `${Math.round(suggestion.confidence * 100)}% confident`,
      weight: 1000,
    });
  }

  // 2. If filters were active, relaxing them is the next best move.
  if (input.hasActiveFilters) {
    suggestions.push({
      type: "SEARCH_QUERY",
      text: `Search "${processed.raw}" without filters`,
      href: `/search?q=${encodeURIComponent(processed.raw)}`,
      imageUrl: null,
      meta: "Clear all filters",
      weight: 900,
    });
  }

  // 3. Related searches from what other shoppers actually searched.
  try {
    const related = await client
      .select({ query: searchQueryLogs.normalizedQuery, count: sql<number>`count(*)::int` })
      .from(searchQueryLogs)
      .where(
        and(
          sql`${searchQueryLogs.resultCount} > 0`,
          sql`${searchQueryLogs.createdAt} > now() - interval '30 days'`,
        ),
      )
      .groupBy(searchQueryLogs.normalizedQuery)
      .orderBy(desc(sql`count(*)`))
      .limit(6);

    const seeds = new Set(processed.tokens);
    for (const row of related) {
      if (row.query === processed.canonical) continue;
      // A related search is only useful if it shares a word with the original;
      // otherwise it is just a popularity list.
      const shares = row.query.split(/\s+/).some((token) => seeds.has(token));
      if (!shares && related.length > 2) continue;
      suggestions.push({
        type: "SEARCH_QUERY",
        text: row.query,
        href: `/search?q=${encodeURIComponent(row.query)}`,
        imageUrl: null,
        meta: `${row.count} searches`,
        weight: 100 + row.count,
      });
    }
  } catch (error) {
    logger.warn("could not load related searches for zero-result recovery", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // 4. Popular products, so the page is never a dead end.
  try {
    const popular = await client
      .select({
        productId: productSearchIndex.productId,
        slug: productSearchIndex.slug,
        name: productSearchIndex.name,
      })
      .from(productSearchIndex)
      .where(eq(productSearchIndex.isSearchable, true))
      .orderBy(desc(productSearchIndex.popularity))
      .limit(4);

    for (const row of popular) {
      suggestions.push({
        type: "PRODUCT",
        text: row.name,
        href: `/product/${row.slug}`,
        imageUrl: null,
        meta: "Popular right now",
        weight: 50,
      });
    }
  } catch {
    // A missing popularity list must not break the recovery path.
  }

  return suggestions.sort((a, b) => b.weight - a.weight).slice(0, 12);
}

/* ── Logging ─────────────────────────────────────────────────────────── */

async function logQuery(input: {
  client: DbClient;
  processed: PipelineResult;
  executedQuery: string;
  resultCount: number;
  tookMs: number;
  sessionHash: string | null;
  rankingVersion: string;
  experimentVariant: string | null;
  filters: SearchFilters;
}): Promise<string | null> {
  try {
    const [row] = await input.client
      .insert(searchQueryLogs)
      .values({
        query: input.executedQuery.slice(0, 200),
        normalizedQuery: input.processed.canonical.slice(0, 200),
        resultCount: input.resultCount,
        tookMs: input.tookMs,
        sessionHash: input.sessionHash,
        correctedQuery: input.processed.correctedQuery,
        wasCorrected: input.processed.correctionApplied,
        rankingVersion: input.rankingVersion,
        experimentVariant: input.experimentVariant,
        filterSignature: filterSignature(input.filters) || null,
      })
      .returning({ id: searchQueryLogs.id });
    return row?.id ?? null;
  } catch (error) {
    // Analytics must never fail a search. The shopper gets results either way.
    logger.warn("could not write the search query log", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/* ── helpers ─────────────────────────────────────────────────────────── */

function emptyFilters(): SearchFilters {
  return {
    categoryIds: [],
    brandIds: [],
    minPricePaise: null,
    maxPricePaise: null,
    minRating: null,
    availability: "any",
    onSaleOnly: false,
    attributes: {},
  };
}

function mergeFilters(explicit: SearchFilters, inferred: {
  brandIds: string[];
  categoryIds: string[];
  attributes: Record<string, string[]>;
}): SearchFilters {
  return {
    ...explicit,
    attributes: { ...explicit.attributes },
    // An explicit filter is the shopper's own choice and is never overridden by
    // an inference. Inferred values only fill gaps.
    brandIds: explicit.brandIds.length ? explicit.brandIds : inferred.brandIds,
    categoryIds: explicit.categoryIds.length ? explicit.categoryIds : inferred.categoryIds,
  };
}

function hasAnyFilter(filters: SearchFilters): boolean {
  return (
    filters.brandIds.length > 0 ||
    filters.categoryIds.length > 0 ||
    filters.minPricePaise !== null ||
    filters.maxPricePaise !== null ||
    filters.minRating !== null ||
    filters.availability !== "any" ||
    filters.onSaleOnly ||
    Object.values(filters.attributes).some((values) => values.length > 0)
  );
}

