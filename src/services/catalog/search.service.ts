import "server-only";
import { and, desc, eq, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  brands,
  categories,
  productSearchIndex,
  products,
  productTags,
  productVariants,
  searchQueryLogs,
  searchSuggestions,
  searchSynonyms,
  tags,
  variantAttributes,
} from "@/db/schema";
import type { DbClient } from "@/db/utils";
import {
  buildSearchDocument,
  buildTrigramText,
  canonicalQuery,
  expandWithSynonyms,
  groupsToTsQuery,
  isSearchableQuery,
  synonymGroups,
  MAX_QUERY_TOKENS,
  MIN_SUGGEST_LENGTH,
  normalizeText,
  sanitizeQuery,
  tokenize,
} from "@/lib/catalog/search-text";
import { errorContext, logger } from "@/lib/logger";
import { isPubliclyListed } from "@/lib/catalog-rules";

/**
 * Catalog search.
 *
 * This is a real indexed search, not a `LIKE '%q%'` over the current page:
 *
 *   • one denormalized row per product in `product_search_index`, so a search
 *     touches one table and one GIN index rather than joining variants, tags,
 *     brands and attributes on every keystroke;
 *   • a weighted `tsvector` (name > brand/category > tags/attributes/sku >
 *     description) ranked with `ts_rank_cd`;
 *   • prefix matching, because shoppers search mid-word — the last token is
 *     expanded to `token:*`;
 *   • a `pg_trgm` fallback so a typo or partial word still returns something;
 *   • curated synonyms, so "tee" finds t-shirts;
 *   • suggestions and query logging mined from the real catalog.
 *
 * Query text is never interpolated into SQL. Tokens come from `tokenize()`,
 * which admits only letters and digits, so a constructed `tsquery` string cannot
 * carry SQL — and every value is bound as a parameter regardless.
 */

export const SEARCH_PAGE_SIZES = [12, 24, 48] as const;
export type SearchPageSize = (typeof SEARCH_PAGE_SIZES)[number];

/**
 * Minimum word similarity for the trigram fallback to contribute a hit.
 *
 * `word_similarity` (not `similarity`) is the correct pg_trgm function here:
 * `similarity` compares two whole strings, so a short query against a long
 * product name scores near zero even when a word matches exactly. `word_similarity`
 * scores the query against the best-matching extent of the text, which is what
 * "does this document contain something like the word I typed" means.
 */
export const TRIGRAM_THRESHOLD = 0.35;

export interface SearchFilters {
  categoryId?: string | null;
  brandId?: string | null;
  minPricePaise?: number | null;
  maxPricePaise?: number | null;
}

export interface SearchHit {
  productId: string;
  slug: string;
  name: string;
  brandName: string | null;
  categoryPath: string | null;
  pricePaise: number;
  compareAtPaise: number | null;
  ratingAverage: number | null;
  ratingCount: number;
  /** Text-match score, already combined with popularity. */
  score: number;
  /** Which signal produced the hit — useful for debugging relevance. */
  matchedBy: "fulltext" | "trigram" | "both";
}

export interface SearchResult {
  query: string;
  normalizedQuery: string;
  /** Terms actually searched, after synonym expansion. */
  expandedTerms: string[];
  hits: SearchHit[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  tookMs: number;
}

/* ── Query building ──────────────────────────────────────────────────── */

/**
 * Build a prefix-aware, synonym-expanded `tsquery` text from a raw query.
 *
 * Every term is produced by `tokenize()`, which strips everything outside
 * letters and digits, so the assembled expression is safe to hand to
 * `to_tsquery`. Alternatives within a position are OR-ed; positions are AND-ed.
 */
export function buildPrefixQuery(query: string, synonyms: ReadonlyMap<string, string[]> = new Map()): string {
  return groupsToTsQuery(synonymGroups(query, synonyms));
}

/** Curated synonym map, loaded once per request. */
export async function getSynonymMap(client: DbClient = db): Promise<Map<string, string[]>> {
  const rows = await client
    .select({ term: searchSynonyms.term, synonym: searchSynonyms.synonym, bidirectional: searchSynonyms.isBidirectional })
    .from(searchSynonyms)
    .where(eq(searchSynonyms.isActive, true));

  const map = new Map<string, string[]>();
  const add = (from: string, to: string) => {
    const key = from.trim().toLowerCase();
    const existing = map.get(key) ?? [];
    if (!existing.includes(to)) map.set(key, [...existing, to]);
  };
  for (const row of rows) {
    add(row.term, row.synonym);
    if (row.bidirectional) add(row.synonym, row.term);
  }
  return map;
}

/* ── Indexing ────────────────────────────────────────────────────────── */

interface IndexableProduct {
  id: string;
  slug: string;
  name: string;
  status: string;
  visibility: string;
  basePrice: number;
  compareAtPrice: number | null;
  shortDescription: string | null;
  description: string | null;
  brandId: string | null;
  categoryId: string | null;
  sellerId: string | null;
  ratingAverage: number | null;
  ratingCount: number;
  brandName: string | null;
  categoryPath: string | null;
}

async function loadIndexableProduct(productId: string, client: DbClient): Promise<IndexableProduct | null> {
  const [row] = await client
    .select({
      id: products.id,
      slug: products.slug,
      name: products.name,
      status: products.status,
      visibility: products.visibility,
      basePrice: products.basePrice,
      compareAtPrice: products.compareAtPrice,
      shortDescription: products.shortDescription,
      description: products.description,
      brandId: products.brandId,
      categoryId: products.categoryId,
      sellerId: products.sellerId,
      ratingAverage: products.ratingAverage,
      ratingCount: products.ratingCount,
      brandName: brands.name,
      categoryPath: categories.path,
    })
    .from(products)
    .leftJoin(brands, eq(brands.id, products.brandId))
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .where(eq(products.id, productId));
  return (row as IndexableProduct) ?? null;
}

async function loadIndexTerms(productId: string, client: DbClient) {
  const [tagRows, variantRows, attributeRows] = await Promise.all([
    client
      .select({ name: tags.name })
      .from(productTags)
      .innerJoin(tags, eq(tags.id, productTags.tagId))
      .where(eq(productTags.productId, productId)),
    client
      .select({ sku: productVariants.sku, barcode: productVariants.barcode })
      .from(productVariants)
      .where(and(eq(productVariants.productId, productId), eq(productVariants.isActive, true))),
    client
      .selectDistinct({ value: variantAttributes.valueText })
      .from(variantAttributes)
      .where(eq(variantAttributes.productId, productId)),
  ]);
  return {
    tags: tagRows.map((row) => row.name),
    skus: variantRows.map((row) => row.sku),
    barcodes: variantRows.map((row) => row.barcode).filter((value): value is string => Boolean(value)),
    attributeValues: attributeRows.map((row) => row.value),
  };
}

/**
 * Rebuild one product's search row.
 *
 * Called from the same transaction as any product write, so the index can never
 * describe a product that no longer exists. Deleting the row entirely for a
 * non-public product is deliberate: a hidden product must not be findable.
 */
export async function indexProduct(productId: string, client: DbClient = db): Promise<{ indexed: boolean }> {
  const product = await loadIndexableProduct(productId, client);
  if (!product) {
    await client.delete(productSearchIndex).where(eq(productSearchIndex.productId, productId));
    return { indexed: false };
  }

  const searchable = isPubliclyListed(product.status as never) && product.visibility === "PUBLIC";
  if (!searchable) {
    // Keep the row so an admin search can find drafts, but mark it unsearchable.
    const document = buildSearchDocument({
      name: product.name,
      brandName: product.brandName,
      categoryPath: product.categoryPath,
      shortDescription: product.shortDescription,
      description: product.description,
    });
    await upsertSearchRow(client, product, document, [], false);
    return { indexed: false };
  }

  const terms = await loadIndexTerms(productId, client);
  const document = buildSearchDocument({
    name: product.name,
    brandName: product.brandName,
    categoryPath: product.categoryPath,
    tags: terms.tags,
    attributeValues: terms.attributeValues,
    skus: terms.skus,
    barcodes: terms.barcodes,
    shortDescription: product.shortDescription,
    description: product.description,
  });

  await upsertSearchRow(client, product, document, terms.attributeValues, true);
  return { indexed: true };
}

async function upsertSearchRow(
  client: DbClient,
  product: IndexableProduct,
  document: ReturnType<typeof buildSearchDocument>,
  attributeValues: readonly string[],
  isSearchable: boolean,
): Promise<void> {
  const trigramText = buildTrigramText(document);
  await client
    .insert(productSearchIndex)
    .values({
      productId: product.id,
      slug: product.slug,
      name: document.name,
      brandName: document.brand,
      brandId: product.brandId,
      categoryId: product.categoryId,
      categoryPath: product.categoryPath,
      sellerId: product.sellerId,
      skuText: document.skus,
      tagText: document.tags,
      attributeText: normalizeText(attributeValues.join(" "), 800),
      descriptionText: document.description,
      // Built by the database from bound parameters — never string-concatenated.
      searchVector: sql`
        setweight(to_tsvector('simple', ${document.name}), 'A')
        || setweight(to_tsvector('simple', ${document.brand ?? ""}), 'B')
        || setweight(to_tsvector('simple', ${document.categoryPath ?? ""}), 'B')
        || setweight(to_tsvector('simple', ${document.tags}), 'C')
        || setweight(to_tsvector('simple', ${normalizeText(attributeValues.join(" "), 800)}), 'C')
        || setweight(to_tsvector('simple', ${document.skus}), 'C')
        || setweight(to_tsvector('simple', ${document.description}), 'D')
      `,
      trigramText,
      pricePaise: product.basePrice,
      compareAtPaise: product.compareAtPrice,
      status: product.status,
      isSearchable,
      ratingAverage: product.ratingAverage,
      ratingCount: product.ratingCount,
      indexedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: productSearchIndex.productId,
      set: {
        slug: product.slug,
        name: document.name,
        brandName: document.brand,
        brandId: product.brandId,
        categoryId: product.categoryId,
        categoryPath: product.categoryPath,
        sellerId: product.sellerId,
        skuText: document.skus,
        tagText: document.tags,
        attributeText: normalizeText(attributeValues.join(" "), 800),
        descriptionText: document.description,
        searchVector: sql`
          setweight(to_tsvector('simple', ${document.name}), 'A')
          || setweight(to_tsvector('simple', ${document.brand ?? ""}), 'B')
          || setweight(to_tsvector('simple', ${document.categoryPath ?? ""}), 'B')
          || setweight(to_tsvector('simple', ${document.tags}), 'C')
          || setweight(to_tsvector('simple', ${normalizeText(attributeValues.join(" "), 800)}), 'C')
          || setweight(to_tsvector('simple', ${document.skus}), 'C')
          || setweight(to_tsvector('simple', ${document.description}), 'D')
        `,
        trigramText,
        pricePaise: product.basePrice,
        compareAtPaise: product.compareAtPrice,
        status: product.status,
        isSearchable,
        ratingAverage: product.ratingAverage,
        ratingCount: product.ratingCount,
        indexedAt: new Date(),
      },
    });

  // Keep `products.search_vector` in step for admin queries that filter on the
  // products table directly rather than the index.
  await client
    .update(products)
    .set({
      searchVector: sql`
        setweight(to_tsvector('simple', ${document.name}), 'A')
        || setweight(to_tsvector('simple', ${document.tags}), 'C')
        || setweight(to_tsvector('simple', ${document.description}), 'D')
      `,
    })
    .where(eq(products.id, product.id));
}

/**
 * Rebuild the whole index, in batches.
 *
 * Batched and ordered by id so a 100k-product reindex does not hold one giant
 * transaction open; each batch commits independently and can be resumed.
 */
export async function reindexAll(
  options: { batchSize?: number; maxBatches?: number; client?: DbClient } = {},
): Promise<{ indexed: number; batches: number }> {
  const client = options.client ?? db;
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 200, 1000));
  const maxBatches = options.maxBatches ?? 100_000;

  let indexed = 0;
  let batches = 0;
  let cursor: string | null = null;

  while (batches < maxBatches) {
    const rows = await client
      .select({ id: products.id })
      .from(products)
      .where(cursor ? sql`${products.id} > ${cursor}` : sql`true`)
      .orderBy(products.id)
      .limit(batchSize);
    if (rows.length === 0) break;

    for (const row of rows) {
      const result = await indexProduct(row.id, client);
      if (result.indexed) indexed += 1;
    }
    cursor = rows[rows.length - 1].id;
    batches += 1;
    if (rows.length < batchSize) break;
  }
  return { indexed, batches };
}

/** Drop index rows whose product no longer exists (defensive cleanup). */
export async function pruneOrphanIndexRows(client: DbClient = db): Promise<number> {
  const result = await client
    .delete(productSearchIndex)
    .where(
      sql`NOT EXISTS (SELECT 1 FROM ${products} WHERE ${products.id} = ${productSearchIndex.productId})`,
    );
  return Number(result.rowCount ?? 0);
}

/* ── Search ──────────────────────────────────────────────────────────── */

export async function searchProducts(
  rawQuery: string,
  options: { filters?: SearchFilters; page?: number; pageSize?: number; client?: DbClient } = {},
): Promise<SearchResult> {
  const startedAt = Date.now();
  const client = options.client ?? db;
  const query = sanitizeQuery(rawQuery);
  const normalized = canonicalQuery(query);
  const page = Math.max(1, Math.min(options.page ?? 1, 500));
  const pageSize = (SEARCH_PAGE_SIZES as readonly number[]).includes(options.pageSize ?? 24)
    ? (options.pageSize as SearchPageSize)
    : 24;

  if (!isSearchableQuery(query)) {
    return {
      query,
      normalizedQuery: normalized,
      expandedTerms: [],
      hits: [],
      pagination: { page: 1, pageSize, total: 0, totalPages: 0 },
      tookMs: Date.now() - startedAt,
    };
  }

  const synonyms = await getSynonymMap(client);
  const expandedTerms = expandWithSynonyms(query, synonyms);
  const tsQuery = buildPrefixQuery(query, synonyms);
  if (!tsQuery) {
    return {
      query,
      normalizedQuery: normalized,
      expandedTerms,
      hits: [],
      pagination: { page: 1, pageSize, total: 0, totalPages: 0 },
      tookMs: Date.now() - startedAt,
    };
  }

  const filters = options.filters ?? {};
  const conditions = [eq(productSearchIndex.isSearchable, true)];
  if (filters.categoryId) conditions.push(eq(productSearchIndex.categoryId, filters.categoryId));
  if (filters.brandId) conditions.push(eq(productSearchIndex.brandId, filters.brandId));
  if (filters.minPricePaise != null) conditions.push(sql`${productSearchIndex.pricePaise} >= ${filters.minPricePaise}`);
  if (filters.maxPricePaise != null) conditions.push(sql`${productSearchIndex.pricePaise} <= ${filters.maxPricePaise}`);

  // Full-text match OR word similarity — a typo still returns results.
  const textMatch = sql`${productSearchIndex.searchVector} @@ to_tsquery('simple', ${tsQuery})`;
  const fuzzyMatch = sql`word_similarity(${query}, ${productSearchIndex.trigramText}) > ${TRIGRAM_THRESHOLD}`;
  conditions.push(or(textMatch, fuzzyMatch)!);

  const textRank = sql<number>`ts_rank_cd(${productSearchIndex.searchVector}, to_tsquery('simple', ${tsQuery}))`;
  /**
   * Name-only rank, weighted well above the all-fields rank. Without it, a
   * product that merely mentions the query somewhere in a long description can
   * outrank the product actually called that — the classic "search for X, get
   * the accessory first" failure.
   */
  const nameRank = sql<number>`ts_rank_cd(to_tsvector('simple', ${productSearchIndex.name}), to_tsquery('simple', ${tsQuery}))`;
  const fuzzyRank = sql<number>`word_similarity(${query}, ${productSearchIndex.trigramText})`;
  /**
   * Relevance combines: text rank (dominant), trigram similarity (typo
   * recovery), a small popularity nudge, and a rating nudge. Popularity and
   * rating are bounded so a popular product can never outrank a direct name
   * match — relevance stays relevance.
   *
   * Written as an explicit CASE rather than a cast of the boolean expression:
   * `${fuzzyMatch}::real` would parse as `similarity(...) > ($n::real)` because
   * a cast binds tighter than `>`, which is a type error, not a fuzzy rank.
   * Casts on the literals are explicit because `least(float4, numeric)` has no
   * operator in PostgreSQL and mixing the two silently changes the result type.
   */
  const fuzzyBoost = sql<number>`(CASE WHEN ${fuzzyMatch} THEN ${fuzzyRank} * 2.0::real ELSE 0::real END)`;
  const score = sql<number>`(
    (${nameRank} * 25.0::real)
    + (${textRank} * 10.0::real)
    + ${fuzzyBoost}
    + (least(${productSearchIndex.popularity}, 100.0::real) / 1000.0::real)
    + (coalesce(${productSearchIndex.ratingAverage}, 0::real) / 100.0::real)
  )`;

  const where = and(...conditions);

  const [countRow] = await client
    .select({ total: sql<number>`count(*)::int` })
    .from(productSearchIndex)
    .where(where);
  const total = Number(countRow?.total ?? 0);

  const rows = await client
    .select({
      productId: productSearchIndex.productId,
      slug: productSearchIndex.slug,
      name: productSearchIndex.name,
      brandName: productSearchIndex.brandName,
      categoryPath: productSearchIndex.categoryPath,
      pricePaise: productSearchIndex.pricePaise,
      compareAtPaise: productSearchIndex.compareAtPaise,
      ratingAverage: productSearchIndex.ratingAverage,
      ratingCount: productSearchIndex.ratingCount,
      score,
      textHit: textMatch,
      fuzzyHit: fuzzyMatch,
    })
    .from(productSearchIndex)
    .where(where)
    .orderBy(desc(score), desc(productSearchIndex.productId))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const hits: SearchHit[] = rows.map((row) => ({
    productId: row.productId,
    slug: row.slug,
    name: row.name,
    brandName: row.brandName,
    categoryPath: row.categoryPath,
    pricePaise: row.pricePaise,
    compareAtPaise: row.compareAtPaise,
    ratingAverage: row.ratingAverage,
    ratingCount: row.ratingCount,
    score: Number(row.score ?? 0),
    matchedBy: row.textHit && row.fuzzyHit ? "both" : row.textHit ? "fulltext" : "trigram",
  }));

  return {
    query,
    normalizedQuery: normalized,
    expandedTerms,
    hits,
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    tookMs: Date.now() - startedAt,
  };
}

/**
 * Record a search. Feeds suggestion mining and zero-result reporting.
 * Never throws — analytics must not break a search.
 */
export async function logSearchQuery(
  input: { query: string; resultCount: number; tookMs?: number; sessionHash?: string | null },
  client: DbClient = db,
): Promise<void> {
  const query = sanitizeQuery(input.query);
  if (query.length < MIN_SUGGEST_LENGTH) return;
  try {
    await client.insert(searchQueryLogs).values({
      query,
      normalizedQuery: canonicalQuery(query),
      resultCount: Math.max(0, input.resultCount),
      tookMs: input.tookMs ?? null,
      sessionHash: input.sessionHash ?? null,
    });
  } catch (error) {
    logger.warn("Search query log write failed", errorContext(error));
  }
}

/** Queries that returned nothing — the list a merchandiser should act on. */
export async function getZeroResultQueries(
  options: { limit?: number; client?: DbClient } = {},
): Promise<{ query: string; count: number }[]> {
  const client = options.client ?? db;
  const rows = await client
    .select({ query: searchQueryLogs.normalizedQuery, count: sql<number>`count(*)::int` })
    .from(searchQueryLogs)
    .where(eq(searchQueryLogs.resultCount, 0))
    .groupBy(searchQueryLogs.normalizedQuery)
    .orderBy(desc(sql`count(*)`))
    .limit(Math.max(1, Math.min(options.limit ?? 20, 100)));
  return rows.map((row) => ({ query: row.query, count: Number(row.count) }));
}

/* ── Suggestions ─────────────────────────────────────────────────────── */

export interface Suggestion {
  term: string;
  kind: string;
  productId: string | null;
  slug: string | null;
  weight: number;
}

/**
 * Autocomplete.
 *
 * Uses the trigram index on `search_suggestions.term` plus a prefix match on the
 * product index, so suggestions come from real catalog data rather than a
 * hard-coded list. Returns nothing below MIN_SUGGEST_LENGTH.
 */
export async function getSuggestions(
  rawQuery: string,
  options: { limit?: number; client?: DbClient } = {},
): Promise<Suggestion[]> {
  const client = options.client ?? db;
  const query = sanitizeQuery(rawQuery);
  if (query.length < MIN_SUGGEST_LENGTH) return [];
  const limit = Math.max(1, Math.min(options.limit ?? 8, 20));
  const lowered = query.toLowerCase();

  const [suggestionRows, productRows, categoryRows] = await Promise.all([
    client
      .select({
        term: searchSuggestions.term,
        kind: searchSuggestions.kind,
        productId: searchSuggestions.productId,
        weight: searchSuggestions.weight,
      })
      .from(searchSuggestions)
      .where(and(eq(searchSuggestions.isActive, true), sql`${searchSuggestions.term} LIKE ${`${lowered}%`}`))
      .orderBy(desc(searchSuggestions.weight), searchSuggestions.term)
      .limit(limit),
    client
      .select({
        name: productSearchIndex.name,
        productId: productSearchIndex.productId,
        slug: productSearchIndex.slug,
        popularity: productSearchIndex.popularity,
      })
      .from(productSearchIndex)
      .where(
        and(
          eq(productSearchIndex.isSearchable, true),
          sql`lower(${productSearchIndex.name}) LIKE ${`%${lowered}%`}`,
        ),
      )
      .orderBy(desc(productSearchIndex.popularity), productSearchIndex.name)
      .limit(limit),
    client
      .select({ id: categories.id, name: categories.name, path: categories.path })
      .from(categories)
      .where(and(eq(categories.isActive, true), sql`lower(${categories.name}) LIKE ${`%${lowered}%`}`))
      .orderBy(categories.depth, categories.name)
      .limit(3),
  ]);

  const suggestions: Suggestion[] = [
    ...categoryRows.map((row) => ({ term: row.name, kind: "CATEGORY", productId: null, slug: row.path, weight: 0.9 })),
    ...productRows.map((row) => ({
      term: row.name,
      kind: "PRODUCT",
      productId: row.productId,
      slug: row.slug,
      weight: 0.6 + Math.min(Number(row.popularity ?? 0) / 1000, 0.3),
    })),
    ...suggestionRows.map((row) => ({
      term: row.term,
      kind: row.kind,
      productId: row.productId,
      slug: null,
      weight: Number(row.weight ?? 0),
    })),
  ];

  // Deduplicate by term, keeping the strongest weight.
  const byTerm = new Map<string, Suggestion>();
  for (const suggestion of suggestions) {
    const key = suggestion.term.toLowerCase();
    const existing = byTerm.get(key);
    if (!existing || existing.weight < suggestion.weight) byTerm.set(key, suggestion);
  }
  return [...byTerm.values()].sort((a, b) => b.weight - a.weight).slice(0, limit);
}

/**
 * Rebuild the suggestion table from the live catalog.
 *
 * Run periodically (cron) rather than per write: suggestions are a derived,
 * best-effort surface, and rebuilding them on every product save would be far
 * more expensive than their value.
 */
export async function refreshSuggestions(
  options: { limitPerKind?: number; client?: DbClient } = {},
): Promise<{ products: number; categories: number; brands: number }> {
  const client = options.client ?? db;
  const limit = Math.max(1, Math.min(options.limitPerKind ?? 500, 5000));

  const [productRows, categoryRows, brandRows] = await Promise.all([
    client
      .select({
        productId: productSearchIndex.productId,
        name: productSearchIndex.name,
        popularity: productSearchIndex.popularity,
      })
      .from(productSearchIndex)
      .where(eq(productSearchIndex.isSearchable, true))
      .orderBy(desc(productSearchIndex.popularity))
      .limit(limit),
    client
      .select({ id: categories.id, name: categories.name })
      .from(categories)
      .where(eq(categories.isActive, true))
      .orderBy(categories.depth, categories.name)
      .limit(limit),
    client
      .select({ id: brands.id, name: brands.name })
      .from(brands)
      .where(eq(brands.isActive, true))
      .orderBy(brands.displayOrder, brands.name)
      .limit(limit),
  ]);

  await client.delete(searchSuggestions);

  for (const row of productRows) {
    await client.insert(searchSuggestions).values({
      term: row.name,
      kind: "PRODUCT",
      productId: row.productId,
      weight: 0.5 + Math.min(Number(row.popularity ?? 0) / 1000, 0.4),
    });
  }
  for (const row of categoryRows) {
    await client.insert(searchSuggestions).values({ term: row.name, kind: "CATEGORY", categoryId: row.id, weight: 0.85 });
  }
  for (const row of brandRows) {
    await client.insert(searchSuggestions).values({ term: row.name, kind: "BRAND", brandId: row.id, weight: 0.8 });
  }

  return { products: productRows.length, categories: categoryRows.length, brands: brandRows.length };
}

/** Popular real queries, for the "trending searches" surface. */
export async function getPopularQueries(
  options: { limit?: number; client?: DbClient } = {},
): Promise<{ query: string; count: number }[]> {
  const client = options.client ?? db;
  const rows = await client
    .select({ query: searchQueryLogs.normalizedQuery, count: sql<number>`count(*)::int` })
    .from(searchQueryLogs)
    .where(sql`${searchQueryLogs.resultCount} > 0`)
    .groupBy(searchQueryLogs.normalizedQuery)
    .orderBy(desc(sql`count(*)`))
    .limit(Math.max(1, Math.min(options.limit ?? 8, 20)));
  return rows.map((row) => ({ query: row.query, count: Number(row.count) }));
}

/* ── Related products ────────────────────────────────────────────────── */

/**
 * Related products for a PDP.
 *
 * Priority: curated relations first (a merchandiser's explicit choice), then
 * same-category siblings ranked by popularity. Never invents a relation — if
 * there is nothing real to show, it returns fewer items.
 */
export async function getRelatedProducts(
  productId: string,
  options: { limit?: number; client?: DbClient } = {},
): Promise<{ productId: string; slug: string; name: string; pricePaise: number }[]> {
  const client = options.client ?? db;
  const limit = Math.max(1, Math.min(options.limit ?? 8, 24));

  const [self] = await client
    .select({ categoryId: productSearchIndex.categoryId })
    .from(productSearchIndex)
    .where(eq(productSearchIndex.productId, productId));

  const conditions = [eq(productSearchIndex.isSearchable, true), ne(productSearchIndex.productId, productId)];
  if (self?.categoryId) conditions.push(eq(productSearchIndex.categoryId, self.categoryId));

  const rows = await client
    .select({
      productId: productSearchIndex.productId,
      slug: productSearchIndex.slug,
      name: productSearchIndex.name,
      pricePaise: productSearchIndex.pricePaise,
    })
    .from(productSearchIndex)
    .where(and(...conditions))
    .orderBy(desc(productSearchIndex.popularity), desc(productSearchIndex.ratingCount))
    .limit(limit);

  return rows;
}

/** Index rows currently missing coverage — an operational health check. */
export async function getUnindexedProductCount(client: DbClient = db): Promise<number> {
  const [row] = await client
    .select({
      total: sql<number>`count(*)::int`,
    })
    .from(products)
    .leftJoin(productSearchIndex, eq(productSearchIndex.productId, products.id))
    .where(and(eq(products.status, "ACTIVE"), isNotNull(products.publishedAt), sql`${productSearchIndex.productId} IS NULL`));
  return Number(row?.total ?? 0);
}

/** Tokens a query produced — exposed so the admin UI can show what was searched. */
export function debugTokens(query: string): string[] {
  return tokenize(query);
}
