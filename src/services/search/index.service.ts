import "server-only";

import { and, asc, eq, gt, inArray, or, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  brands,
  catalogEvents,
  categories,
  productSearchIndex,
  products,
  searchQueryLogs,
} from "@/db/schema";
import type { DbClient } from "@/db/utils";
import { withTransaction } from "@/db/utils";
import { logger } from "@/lib/logger";
import { indexProduct, pruneOrphanIndexRows } from "@/services/catalog/search.service";
import { invalidateLexiconCache } from "@/services/search/lexicon.service";
import { invalidateSynonymCache } from "@/services/search/synonym.service";
import { refreshSuggestionTable } from "@/services/search/suggest.service";
import { rebuildVocabulary, recordObservedTerms } from "@/services/search/vocabulary.service";
import { claimEvents, markEventFailed, markEventsPublished } from "@/services/catalog/events.service";

/**
 * The indexing pipeline.
 *
 *   catalog write → catalog_events (outbox) → this worker → product_search_index
 *
 * Part 11 wrote catalog changes to an outbox inside the same transaction as the
 * change, so an event is never lost and never fabricated. This worker is the
 * consumer: it claims unprocessed events, applies the index change, and marks
 * them done.
 *
 * ## Why an outbox rather than an inline index write
 *
 * Indexing inside the product-write transaction would make a slow index write
 * fail the save, and a failed save would silently leave the index stale if the
 * write were skipped instead. The outbox decouples them: the product save is
 * fast and durable, and the index catches up. The cost is eventual consistency,
 * which for search is the right trade — a product appearing a second late is
 * invisible; a product save that fails is not.
 *
 * ## Failure behaviour
 *
 * A failed event is marked failed and skipped, not retried forever. One
 * unindexable product must not wedge the queue behind it. Failed events stay
 * visible in `catalog_events` so an operator can see and fix them.
 */

/** Catalog event types that require a search-index update. */
const SEARCH_RELEVANT_EVENTS = new Set([
  "PRODUCT_CREATED",
  "PRODUCT_UPDATED",
  "PRODUCT_DELETED",
  "PRODUCT_PUBLISHED",
  "PRODUCT_UNPUBLISHED",
  "PRICE_CHANGED",
  "STOCK_CHANGED",
  "VARIANT_CREATED",
  "VARIANT_UPDATED",
  "VARIANT_RETIRED",
  "MEDIA_CHANGED",
  "BRAND_CREATED",
  "BRAND_UPDATED",
  "BRAND_DELETED",
  "CATEGORY_UPDATED",
]);

export interface IndexRunResult {
  claimed: number;
  processed: number;
  failed: number;
  skipped: number;
  tookMs: number;
}

/**
 * Process a batch of pending catalog events.
 *
 * Returns counts so a caller (a cron route, a CLI, a test) can tell whether the
 * queue is draining. Never throws for an individual event.
 */
export async function processIndexQueue(
  options: { batchSize?: number; client?: DbClient } = {},
): Promise<IndexRunResult> {
  const startedAt = Date.now();
  const client = options.client ?? db;
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 100, 500));

  const claimed = await claimEvents({ limit: batchSize }, client);
  if (claimed.length === 0) {
    return { claimed: 0, processed: 0, failed: 0, skipped: 0, tookMs: Date.now() - startedAt };
  }

  let processed = 0;
  let failed = 0;
  let skipped = 0;
  const succeeded: string[] = [];

  // A product touched by several events only needs indexing once, so the work is
  // de-duplicated before executing rather than after.
  const productIds = new Set<string>();

  for (const event of claimed) {
    if (!SEARCH_RELEVANT_EVENTS.has(event.eventType)) {
      skipped += 1;
      succeeded.push(event.id);
      continue;
    }
    if (event.aggregateType === "product" && event.aggregateId) {
      productIds.add(event.aggregateId);
      succeeded.push(event.id);
      continue;
    }
    // Brand and category changes invalidate the lexicon rather than a product
    // row; they are handled after the batch.
    succeeded.push(event.id);
  }

  for (const productId of productIds) {
    try {
      await indexProduct(productId, client);
      processed += 1;
    } catch (error) {
      failed += 1;
      logger.error("could not index product", {
        productId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (succeeded.length) {
    await markEventsPublished(succeeded, client).catch((error) => {
      logger.error("could not mark catalog events published", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  // A brand or category rename changes how queries are understood, not how any
  // one product is indexed.
  const touchedTaxonomy = claimed.some(
    (event) =>
      event.aggregateType === "brand" ||
      event.aggregateType === "category" ||
      event.eventType === "CATEGORY_UPDATED",
  );
  if (touchedTaxonomy) invalidateLexiconCache();

  return {
    claimed: claimed.length,
    processed,
    failed,
    skipped,
    tookMs: Date.now() - startedAt,
  };
}

/**
 * Mark an event failed so it stops blocking the queue.
 *
 * Called by the worker when a retry would not help (a deleted product, a
 * malformed payload). The row stays in `catalog_events` for inspection.
 */
export async function failEvent(
  eventId: string,
  reason: string,
  client: DbClient = db,
): Promise<void> {
  await markEventFailed(eventId, new Error(reason), client);
}

/* ── Bulk indexing ───────────────────────────────────────────────────── */

export interface ReindexProgress {
  total: number;
  indexed: number;
  failed: number;
  /** Products whose index row is missing or stale. */
  pending: number;
  tookMs: number;
}

/**
 * Rebuild the whole index, in batches.
 *
 * Reports progress through the callback so a CLI can print a bar and an admin
 * route can stream status. Never loads the catalog into memory: it pages by
 * primary key.
 */
export async function reindexCatalog(
  options: {
    batchSize?: number;
    client?: DbClient;
    onProgress?: (progress: { done: number; total: number }) => void;
  } = {},
): Promise<ReindexProgress> {
  const startedAt = Date.now();
  const client = options.client ?? db;
  const batchSize = Math.max(50, Math.min(options.batchSize ?? 500, 2000));

  const [countRow] = await client.select({ total: sql<number>`count(*)::int` }).from(products);
  const total = countRow?.total ?? 0;

  // Paged here rather than delegating wholesale to `reindexAll`, because that
  // helper cannot report progress and a CLI with no output on a 100k-product
  // catalog looks hung. Keyset pagination on the primary key keeps each page
  // cheap regardless of how deep into the catalog we are.
  let indexed = 0;
  let failed = 0;
  let cursor: string | null = null;

  for (;;) {
    const conditions = [];
    if (cursor) conditions.push(gt(products.id, cursor));

    const batch = await client
      .select({ id: products.id })
      .from(products)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(asc(products.id))
      .limit(batchSize);

    if (batch.length === 0) break;

    for (const product of batch) {
      try {
        await indexProduct(product.id, client);
        indexed += 1;
      } catch (error) {
        failed += 1;
        logger.error("could not index product during catalog reindex", {
          productId: product.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    cursor = batch[batch.length - 1]!.id;
    options.onProgress?.({ done: indexed + failed, total });
    if (batch.length < batchSize) break;
  }

  const pruned = await pruneOrphanIndexRows(client).catch(() => 0);
  if (pruned > 0) logger.info(`pruned ${pruned} orphan search-index rows`);

  const pending = await countUnindexed(client);

  return { total, indexed, failed, pending, tookMs: Date.now() - startedAt };
}

/**
 * Products with no search-index row at all.
 *
 * Deliberately does NOT try to detect staleness from `products.updated_at`.
 * `indexProduct` writes `indexed_at` and then updates `products.search_vector`,
 * whose `$onUpdate` hook bumps `updated_at` to a *later* instant — so comparing
 * the two reports every freshly indexed product as stale. Staleness is measured
 * from the event outbox instead (see `indexStatus`).
 */
export async function countUnindexed(client: DbClient = db): Promise<number> {
  const [row] = await client
    .select({ total: sql<number>`count(*)::int` })
    .from(products)
    .leftJoin(productSearchIndex, eq(productSearchIndex.productId, products.id))
    .where(sql`${productSearchIndex.productId} IS NULL`);
  return row?.total ?? 0;
}

/** Reindex everything in one category subtree. */
export async function reindexCategory(
  categoryId: string,
  options: { client?: DbClient } = {},
): Promise<{ indexed: number }> {
  const client = options.client ?? db;

  // Descendants matter: a category filter on the storefront includes the whole
  // subtree, so a category rename must refresh every product beneath it.
  const subtree = await client
    .select({ id: categories.id })
    .from(categories)
    .where(
      or(
        eq(categories.id, categoryId),
        sql`${categories.path} LIKE (SELECT ${categories.path} || '%' FROM ${categories} WHERE ${categories.id} = ${categoryId})`,
      ),
    );

  const ids = subtree.map((row) => row.id);
  if (ids.length === 0) return { indexed: 0 };

  const affected = await client
    .select({ id: products.id })
    .from(products)
    .where(inArray(products.categoryId, ids));

  let indexed = 0;
  for (const product of affected) {
    await indexProduct(product.id, client).catch(() => {
      logger.warn("could not index product during category reindex", { productId: product.id });
    });
    indexed += 1;
  }
  invalidateLexiconCache();
  return { indexed };
}

/** Reindex every product of one brand. */
export async function reindexBrand(
  brandId: string,
  options: { client?: DbClient } = {},
): Promise<{ indexed: number }> {
  const client = options.client ?? db;
  const affected = await client
    .select({ id: products.id })
    .from(products)
    .where(eq(products.brandId, brandId));

  let indexed = 0;
  for (const product of affected) {
    await indexProduct(product.id, client).catch(() => {
      logger.warn("could not index product during brand reindex", { productId: product.id });
    });
    indexed += 1;
  }
  invalidateLexiconCache();
  return { indexed };
}

/* ── Derived indexes ─────────────────────────────────────────────────── */

export interface DerivedIndexResult {
  vocabularyTerms: number;
  suggestionRows: number;
  observedTerms: number;
  tookMs: number;
}

/**
 * Rebuild the derived indexes that search depends on but that are not the
 * product index: the spell-correction vocabulary, the autocomplete table, and
 * the observed-query terms.
 *
 * Kept separate from `reindexCatalog` because these change on a different
 * cadence — the vocabulary shifts when the catalog shifts, while the suggestion
 * table shifts as shoppers search.
 */
export async function refreshDerivedIndexes(
  options: { client?: DbClient } = {},
): Promise<DerivedIndexResult> {
  const startedAt = Date.now();
  const client = options.client ?? db;

  const [vocabulary, suggestions, observed] = await Promise.all([
    rebuildVocabulary({ client }).catch((error) => {
      logger.error("vocabulary rebuild failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { terms: 0, sources: {} as never };
    }),
    refreshSuggestionTable({ client }).catch((error) => {
      logger.error("suggestion table refresh failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { rows: 0 };
    }),
    harvestObservedTerms(client),
  ]);

  invalidateSynonymCache();

  return {
    vocabularyTerms: vocabulary.terms,
    suggestionRows: suggestions.rows,
    observedTerms: observed,
    tookMs: Date.now() - startedAt,
  };
}

/**
 * Promote frequently-successful queries into the vocabulary.
 *
 * A term shoppers type that returns results is evidence about this catalog's
 * language, and belongs in the correction dictionary. Restricted to queries that
 * actually matched something, so a nonsense query can never become a correction
 * target.
 */
async function harvestObservedTerms(client: DbClient): Promise<number> {
  try {
    const rows = await client
      .select({
        query: searchQueryLogs.normalizedQuery,
        count: sql<number>`count(*)::int`,
      })
      .from(searchQueryLogs)
      .where(
        and(
          gt(searchQueryLogs.resultCount, 0),
          sql`${searchQueryLogs.createdAt} > now() - interval '30 days'`,
        ),
      )
      .groupBy(searchQueryLogs.normalizedQuery)
      .having(sql`count(*) >= 3`)
      .orderBy(asc(sql`count(*)`))
      .limit(500);

    const terms = rows.flatMap((row) =>
      row.query
        .split(/\s+/)
        .filter((token) => token.length >= 3)
        .map((token) => ({ term: token, count: row.count })),
    );

    return recordObservedTerms(terms, client);
  } catch (error) {
    logger.warn("could not harvest observed search terms", {
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

/* ── Status ──────────────────────────────────────────────────────────── */

export interface IndexStatus {
  products: number;
  indexedProducts: number;
  searchableProducts: number;
  staleProducts: number;
  pendingEvents: number;
  failedEvents: number;
  lastIndexedAt: Date | null;
}

/** Index health, for the admin dashboard and the health endpoint. */
export async function indexStatus(client: DbClient = db): Promise<IndexStatus> {
  const [productCount, indexCount, stale, pending, failed, latest] = await Promise.all([
    client.select({ total: sql<number>`count(*)::int` }).from(products),
    client
      .select({
        total: sql<number>`count(*)::int`,
        searchable: sql<number>`count(*) filter (where ${productSearchIndex.isSearchable})::int`,
      })
      .from(productSearchIndex),
    // A product is stale when the outbox holds an unpublished change for it that
    // postdates the index row. Comparing against products.updated_at instead
    // would report everything as stale, because indexing itself touches that
    // column (see countUnindexed).
    client
      .select({ total: sql<number>`count(distinct ${catalogEvents.aggregateId})::int` })
      .from(catalogEvents)
      .innerJoin(productSearchIndex, eq(productSearchIndex.productId, catalogEvents.aggregateId))
      .where(
        sql`${catalogEvents.publishedAt} IS NULL
             AND ${catalogEvents.aggregateType} = 'product'
             AND ${catalogEvents.createdAt} > ${productSearchIndex.indexedAt}`,
      ),
    client
      .select({ total: sql<number>`count(*)::int` })
      .from(catalogEvents)
      .where(sql`${catalogEvents.publishedAt} IS NULL`),
    client
      .select({ total: sql<number>`count(*)::int` })
      .from(catalogEvents)
      // There is no failed_at column: a failed event is one that was attempted
      // and recorded an error, and was never published.
      .where(sql`${catalogEvents.publishedAt} IS NULL AND ${catalogEvents.lastError} IS NOT NULL`),
    client
      .select({ latest: sql<string | Date | null>`max(${productSearchIndex.indexedAt})` })
      .from(productSearchIndex),
  ]);

  return {
    products: productCount[0]?.total ?? 0,
    indexedProducts: indexCount[0]?.total ?? 0,
    searchableProducts: indexCount[0]?.searchable ?? 0,
    staleProducts: stale[0]?.total ?? 0,
    pendingEvents: pending[0]?.total ?? 0,
    failedEvents: failed[0]?.total ?? 0,
    // Coerced: an aggregate over a timestamptz arrives as a string, and callers
    // reasonably expect a Date.
    lastIndexedAt: latest[0]?.latest ? new Date(latest[0].latest) : null,
  };
}

/** Brands and categories, for the admin "reindex this" controls. */
export async function reindexTargets(client: DbClient = db): Promise<{
  brands: Array<{ id: string; name: string }>;
  categories: Array<{ id: string; name: string }>;
}> {
  const [brandRows, categoryRows] = await Promise.all([
    client.select({ id: brands.id, name: brands.name }).from(brands).orderBy(asc(brands.name)),
    client.select({ id: categories.id, name: categories.name }).from(categories).orderBy(asc(categories.name)),
  ]);
  return { brands: brandRows, categories: categoryRows };
}

export { withTransaction };
