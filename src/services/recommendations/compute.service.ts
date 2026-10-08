import "server-only";

import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/db";
import { productCoPurchases, productPopularity, productSimilarity, productSearchIndex } from "@/db/schema";
import type { DbClient } from "@/db/utils";
import { logger } from "@/lib/logger";
import { rankCoPurchases } from "@/lib/recommendations/cooccurrence";
import {
  computeSimilarity as scoreSimilarity,
  similarityProfileFor,
  type SimilarityInput,
  type SimilarityProfile,
} from "@/lib/recommendations/similarity";
import { conversionRate, popularityScore, trendingScore } from "@/lib/recommendations/popularity";
import { coPurchaseCounts, coViewCounts } from "./events.service";

/**
 * Offline computation.
 *
 * Everything here is expensive and none of it belongs on a request path.
 * Similarity is `O(products × candidates)`, co-purchase is `O(order lines²)`,
 * and popularity needs a scan of the event log. Running any of them
 * synchronously during a page render would make the rail slower than the page
 * it sits on — which is the specific failure §49 exists to prevent.
 *
 * Every function is idempotent: re-running produces the same rows rather than
 * accumulating. That is what makes the jobs safely retryable, which §72
 * requires.
 */

export interface ComputeResult {
  wrote: number;
  skipped: number;
  durationMs: number;
}

/* ── Product similarity ───────────────────────────────────────────────── */

interface SimilarityRow {
  productId: string;
  categoryId: string | null;
  categoryPath: string | null;
  subcategoryId: string | null;
  brandId: string | null;
  productType: string | null;
  pricePaise: number;
  attributeText: string;
  textTokens: string[];
}

/**
 * Load the fields similarity needs, in one query.
 *
 * Reads the denormalized search index plus the variant attribute text, rather
 * than joining the normalized attribute tables per product. The search index
 * already carries `attribute_text` for exactly this reason.
 */
async function loadSimilarityRows(
  options: { limit: number; offset: number },
  client: DbClient,
): Promise<SimilarityRow[]> {
  const rows = await client.execute<{
    product_id: string;
    category_id: string | null;
    category_path: string | null;
    brand_id: string | null;
    price_paise: number;
    attribute_text: string;
    name: string;
    description_text: string;
    tag_text: string;
    product_type: string | null;
  }>(sql`
    select psi.product_id,
           psi.category_id,
           psi.category_path,
           psi.brand_id,
           psi.price_paise,
           psi.attribute_text,
           psi.name,
           psi.description_text,
           psi.tag_text,
           p.product_type::text as product_type
      from product_search_index psi
      join products p on p.id = psi.product_id
     where psi.is_searchable = true
     order by psi.product_id
     limit ${options.limit} offset ${options.offset}
  `);

  // Subcategory is not in the search index; fetch it for the page of products
  // in one query rather than per product.
  const ids = rows.rows.map((row) => row.product_id);
  const subcategories = new Map<string, string | null>();
  if (ids.length > 0) {
    const subRows = await client.execute<{ id: string; subcategory_id: string | null }>(sql`
      select id, subcategory_id from products where id in (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})
    `);
    for (const row of subRows.rows) subcategories.set(row.id, row.subcategory_id);
  }

  return rows.rows.map((row) => ({
    productId: row.product_id,
    categoryId: row.category_id,
    categoryPath: row.category_path,
    subcategoryId: subcategories.get(row.product_id) ?? null,
    brandId: row.brand_id,
    productType: row.product_type,
    pricePaise: row.price_paise,
    attributeText: row.attribute_text,
    textTokens: tokenize(`${row.name} ${row.tag_text} ${row.description_text}`),
  }));
}

/** Lowercase alphanumeric tokens, deduplicated, capped. */
function tokenize(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
  // Capped: an unbounded token list makes the Jaccard comparison quadratic in
  // description length, which rewards verbose copy for no ranking benefit.
  return [...new Set(tokens)].slice(0, 60);
}

/**
 * Compute and store similarity for a batch of products.
 *
 * Candidates are drawn from the same category first, because cross-category
 * similarity is almost always noise — and comparing every product against
 * every other product is `O(n²)`, which does not survive a real catalog.
 *
 * Only pairs above `minScore` are stored. Persisting near-zero pairs would
 * multiply the table size by the catalog size for rows nothing will ever read.
 */
export async function computeSimilarity(
  options: {
    batchSize?: number;
    maxBatches?: number;
    candidatesPerProduct?: number;
    minScore?: number;
    client?: DbClient;
  } = {},
): Promise<ComputeResult> {
  const startedAt = Date.now();
  const client = options.client ?? db;
  const batchSize = Math.min(options.batchSize ?? 200, 1000);
  const maxBatches = Math.min(options.maxBatches ?? 50, 500);
  const candidatesPerProduct = Math.min(options.candidatesPerProduct ?? 24, 100);
  const minScore = options.minScore ?? 0.08;

  let wrote = 0;
  let skipped = 0;

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const seeds = await loadSimilarityRows({ limit: batchSize, offset: batch * batchSize }, client);
    if (seeds.length === 0) break;

    for (const seed of seeds) {
      // Same-category candidates, excluding the seed.
      const candidates = await loadCandidatesFor(seed, candidatesPerProduct * 3, client);
      if (candidates.length === 0) {
        skipped += 1;
        continue;
      }

      const profile = similarityProfileFor({
        categoryPath: seed.categoryPath,
        productType: seed.productType,
        attributeAxes: seed.attributeText.split(/\s+/).filter(Boolean).slice(0, 8),
      });

      const scored = candidates
        .map((candidate) => ({ candidate, ...scoreSimilarity(toInput(seed), toInput(candidate), profile) }))
        .filter((entry) => entry.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, candidatesPerProduct);

      if (scored.length === 0) {
        skipped += 1;
        continue;
      }

      // Delete-then-insert keeps the job idempotent. An upsert alone would
      // leave stale pairs behind when a product's similarity falls below the
      // threshold, and those stale rows would keep being recommended.
      await client.delete(productSimilarity).where(eq(productSimilarity.productId, seed.productId));
      await client.insert(productSimilarity).values(
        scored.map((entry) => ({
          productId: seed.productId,
          similarProductId: entry.candidate.productId,
          score: entry.score,
          algorithm: `content-v1:${profile.name}`,
          sources: entry.parts,
        })),
      );
      wrote += scored.length;
    }
  }

  const durationMs = Date.now() - startedAt;
  logger.info("product similarity computed", { wrote, skipped, durationMs });
  return { wrote, skipped, durationMs };
}

async function loadCandidatesFor(
  seed: SimilarityRow,
  limit: number,
  client: DbClient,
): Promise<SimilarityRow[]> {
  if (!seed.categoryId) return [];
  const rows = await client.execute<{
    product_id: string;
    category_id: string | null;
    category_path: string | null;
    brand_id: string | null;
    price_paise: number;
    attribute_text: string;
    name: string;
    description_text: string;
    tag_text: string;
    product_type: string | null;
  }>(sql`
    select psi.product_id,
           psi.category_id,
           psi.category_path,
           psi.brand_id,
           psi.price_paise,
           psi.attribute_text,
           psi.name,
           psi.description_text,
           psi.tag_text,
           p.product_type::text as product_type
      from product_search_index psi
      join products p on p.id = psi.product_id
     where psi.is_searchable = true
       and psi.category_id = ${seed.categoryId}
       and psi.product_id <> ${seed.productId}
     order by psi.popularity desc
     limit ${limit}
  `);

  return rows.rows.map((row) => ({
    productId: row.product_id,
    categoryId: row.category_id,
    categoryPath: row.category_path,
    subcategoryId: null,
    brandId: row.brand_id,
    productType: row.product_type,
    pricePaise: row.price_paise,
    attributeText: row.attribute_text,
    textTokens: tokenize(`${row.name} ${row.tag_text} ${row.description_text}`),
  }));
}

function toInput(row: SimilarityRow): SimilarityInput {
  return {
    categoryId: row.categoryId,
    subcategoryId: row.subcategoryId,
    categoryPath: row.categoryPath,
    brandId: row.brandId,
    productType: row.productType,
    attributes: row.attributeText.split(/\s+/).filter(Boolean),
    pricePaise: row.pricePaise,
    textTokens: row.textTokens,
  };
}

/* ── Co-purchase ──────────────────────────────────────────────────────── */

/**
 * Recompute the co-purchase matrix from real orders.
 *
 * Reads pair counts from `coPurchaseCounts` (which filters to paid,
 * non-cancelled orders) and stores only pairs that clear the significance
 * floor. Storing every observed pair would fill the table with coincidences:
 * with enough orders, any two products are eventually bought together once.
 *
 * The whole table is rebuilt inside a transaction, so a failed run leaves the
 * previous matrix intact rather than a half-written one.
 */
export async function computeCoPurchases(
  options: { windowDays?: number; limit?: number; client?: DbClient } = {},
): Promise<ComputeResult> {
  const startedAt = Date.now();
  const client = options.client ?? db;
  const windowDays = options.windowDays ?? 90;
  const since = new Date(Date.now() - windowDays * 86_400_000);

  const counts = await coPurchaseCounts({ since, minPairOrders: 2 }, client);
  if (counts.length === 0) {
    return { wrote: 0, skipped: 0, durationMs: Date.now() - startedAt };
  }

  // Group by seed so each seed's companions are ranked together — lift alone
  // is not the whole story, since a seed with one companion should not crowd
  // out a seed with ten.
  const bySeed = new Map<string, typeof counts>();
  for (const row of counts) {
    const list = bySeed.get(row.productId) ?? [];
    list.push(row);
    bySeed.set(row.productId, list);
  }

  let wrote = 0;
  let skipped = 0;
  const perSeedLimit = Math.min(options.limit ?? 24, 100);

  await client.transaction(async (tx) => {
    await tx.delete(productCoPurchases);
    for (const [seedProductId, pairs] of bySeed) {
      const ranked = rankCoPurchases(seedProductId, pairs, { limit: perSeedLimit });
      if (ranked.length === 0) {
        skipped += 1;
        continue;
      }
      await tx.insert(productCoPurchases).values(
        ranked.map((entry) => ({
          productId: seedProductId,
          coProductId: entry.coProductId,
          orderCount: entry.pairOrders,
          support: entry.metrics.support,
          confidence: entry.metrics.confidence,
          lift: entry.metrics.lift,
        })),
      );
      wrote += ranked.length;
    }
  });

  const durationMs = Date.now() - startedAt;
  logger.info("co-purchase matrix computed", { wrote, skipped, durationMs, seeds: bySeed.size });
  return { wrote, skipped, durationMs };
}

/* ── Popularity and trending ──────────────────────────────────────────── */

/**
 * Recompute popularity, trending and conversion for every product.
 *
 * Three scopes are written per product: GLOBAL, and one each for its category
 * and brand. Writing all three in one pass costs one scan of the event log;
 * computing them lazily per request would cost that scan on every page view.
 *
 * Trending compares a recent window against the product's *own* baseline
 * rather than against other products, which is what lets a niche product trend
 * without being outsold site-wide.
 */
export async function computePopularity(
  options: { windowDays?: number; recentDays?: number; client?: DbClient } = {},
): Promise<ComputeResult> {
  const startedAt = Date.now();
  const client = options.client ?? db;
  const windowDays = Math.min(options.windowDays ?? 30, 365);
  const recentDays = Math.min(options.recentDays ?? 2, 30);
  const since = new Date(Date.now() - windowDays * 86_400_000);
  const recentSince = new Date(Date.now() - recentDays * 86_400_000);

  const rows = await client.execute<{
    product_id: string;
    category_id: string | null;
    brand_id: string | null;
    views: number;
    carts: number;
    wishlists: number;
    purchases: number;
    revenue: number;
    recent_views: number;
    recent_carts: number;
    recent_purchases: number;
  }>(sql`
    with scope as (
      select psi.product_id, psi.category_id, psi.brand_id
        from product_search_index psi
       where psi.is_searchable = true
    ),
    window_events as (
      select ae.product_id,
             count(*) filter (where ae.event_type in ('PRODUCT_VIEW','PRODUCT_CLICK'))::int as views,
             count(*) filter (where ae.event_type = 'ADD_TO_CART')::int as carts,
             count(*) filter (where ae.event_type = 'WISHLIST_ADD')::int as wishlists,
             count(*) filter (where ae.event_type = 'PURCHASE')::int as purchases,
             count(*) filter (
               where ae.event_type in ('PRODUCT_VIEW','PRODUCT_CLICK')
                 and ae.created_at >= ${recentSince}
             )::int as recent_views,
             count(*) filter (
               where ae.event_type = 'ADD_TO_CART' and ae.created_at >= ${recentSince}
             )::int as recent_carts,
             count(*) filter (
               where ae.event_type = 'PURCHASE' and ae.created_at >= ${recentSince}
             )::int as recent_purchases
        from analytics_events ae
       where ae.product_id is not null
         and ae.created_at >= ${since}
       group by ae.product_id
    ),
    order_lines as (
      select oi.product_id,
             count(*)::int as purchases,
             coalesce(sum(oi.total_price), 0)::bigint as revenue
        from order_items oi
        join orders o on o.id = oi.order_id
       where o.created_at >= ${since}
         and o.payment_status in ('PAID','PARTIALLY_REFUNDED')
         and o.status <> 'CANCELLED'
         and oi.product_id is not null
       group by oi.product_id
    )
    select s.product_id,
           s.category_id,
           s.brand_id,
           coalesce(we.views, 0)::int as views,
           coalesce(we.carts, 0)::int as carts,
           coalesce(we.wishlists, 0)::int as wishlists,
           coalesce(ol.purchases, we.purchases, 0)::int as purchases,
           coalesce(ol.revenue, 0)::bigint as revenue,
           coalesce(we.recent_views, 0)::int as recent_views,
           coalesce(we.recent_carts, 0)::int as recent_carts,
           coalesce(we.recent_purchases, 0)::int as recent_purchases
      from scope s
      left join window_events we on we.product_id = s.product_id
      left join order_lines ol on ol.product_id = s.product_id
  `);

  if (rows.rows.length === 0) {
    return { wrote: 0, skipped: 0, durationMs: Date.now() - startedAt };
  }

  const values: Array<{
    productId: string;
    scope: "GLOBAL" | "CATEGORY" | "BRAND";
    scopeId: string;
    viewCount: number;
    addToCartCount: number;
    wishlistCount: number;
    purchaseCount: number;
    revenuePaise: number;
    score: number;
    trendingScore: number;
    conversionRate: number;
    windowDays: number;
  }> = [];

  for (const row of rows.rows) {
    const counters = {
      viewCount: row.views,
      addToCartCount: row.carts,
      wishlistCount: row.wishlists,
      purchaseCount: row.purchases,
      revenuePaise: Number(row.revenue),
    };
    const score = popularityScore(counters);
    const trending = trendingScore({
      recent: {
        viewCount: row.recent_views,
        addToCartCount: row.recent_carts,
        wishlistCount: 0,
        purchaseCount: row.recent_purchases,
        revenuePaise: 0,
      },
      baseline: counters,
      baselineDays: windowDays,
      recentDays,
    });
    const conversion = conversionRate(counters);

    const scopes: Array<["GLOBAL" | "CATEGORY" | "BRAND", string]> = [["GLOBAL", ""]];
    if (row.category_id) scopes.push(["CATEGORY", row.category_id]);
    if (row.brand_id) scopes.push(["BRAND", row.brand_id]);

    for (const [scope, scopeId] of scopes) {
      values.push({
        productId: row.product_id,
        scope,
        scopeId,
        viewCount: counters.viewCount,
        addToCartCount: counters.addToCartCount,
        wishlistCount: counters.wishlistCount,
        purchaseCount: counters.purchaseCount,
        revenuePaise: counters.revenuePaise,
        score,
        trendingScore: trending,
        conversionRate: conversion,
        windowDays,
      });
    }
  }

  // Rebuild in one transaction: a partial popularity table would rank some
  // products against stale numbers and others against fresh ones, which is
  // worse than either extreme because the ordering becomes unexplainable.
  await client.transaction(async (tx) => {
    await tx.delete(productPopularity);
    // Chunked: a single insert with tens of thousands of rows can exceed the
    // driver's parameter limit.
    const chunkSize = 500;
    for (let i = 0; i < values.length; i += chunkSize) {
      await tx.insert(productPopularity).values(values.slice(i, i + chunkSize));
    }
  });

  const durationMs = Date.now() - startedAt;
  logger.info("popularity computed", { products: rows.rows.length, rows: values.length, durationMs });
  return { wrote: values.length, skipped: 0, durationMs };
}

/* ── Co-view ──────────────────────────────────────────────────────────── */

/**
 * Co-view pairs, stored as `CUSTOMER_ALSO_VIEWED` candidates.
 *
 * Views are a weaker signal than purchases (§15), so the lift floor is higher
 * than for co-purchase: a browsing session compares several products without
 * intent, which produces coincidental pairs that purchases would not.
 *
 * Written into `product_co_purchases` rather than a separate table because the
 * association metrics and the lookup shape are identical, and two tables with
 * the same columns would drift.
 */
export async function computeCoViews(
  options: { windowDays?: number; limit?: number; client?: DbClient } = {},
): Promise<ComputeResult> {
  const startedAt = Date.now();
  const client = options.client ?? db;
  const windowDays = options.windowDays ?? 30;
  const since = new Date(Date.now() - windowDays * 86_400_000);

  const counts = await coViewCounts({ since, minPairViews: 3 }, client);
  if (counts.length === 0) return { wrote: 0, skipped: 0, durationMs: Date.now() - startedAt };

  const ranked = rankCoPurchases(counts[0]!.productId, counts, {
    limit: Math.min(options.limit ?? 16, 100),
    minLift: 1.2,
    minPairOrders: 3,
  });

  let wrote = 0;
  if (ranked.length > 0) {
    // Upsert rather than replace: co-purchase rows for the same pair are
    // authoritative and must not be overwritten by the weaker co-view signal.
    await client
      .insert(productCoPurchases)
      .values(
        ranked.map((entry) => ({
          productId: counts[0]!.productId,
          coProductId: entry.coProductId,
          orderCount: entry.pairOrders,
          support: entry.metrics.support,
          confidence: entry.metrics.confidence,
          lift: entry.metrics.lift,
        })),
      )
      .onConflictDoNothing();
    wrote = ranked.length;
  }

  return { wrote, skipped: 0, durationMs: Date.now() - startedAt };
}

/* ── Orchestration ────────────────────────────────────────────────────── */

export interface FullComputeResult {
  similarity: ComputeResult;
  coPurchases: ComputeResult;
  popularity: ComputeResult;
  totalMs: number;
}

/**
 * Run every offline job in the order that matters.
 *
 * Popularity runs last because similarity and co-purchase determine *which*
 * products are candidates, and popularity determines how they are ordered —
 * computing popularity first would rank a candidate set that is about to
 * change.
 *
 * Each stage is independent: a failure in one is logged and the others still
 * run, because a stale similarity matrix with fresh popularity is far more
 * useful than nothing at all.
 */
export async function computeAll(
  options: { client?: DbClient; batchSize?: number; skipSimilarity?: boolean } = {},
): Promise<FullComputeResult> {
  const startedAt = Date.now();
  const client = options.client ?? db;

  const similarity = options.skipSimilarity
    ? { wrote: 0, skipped: 0, durationMs: 0 }
    : await runStage("similarity", () => computeSimilarity({ client, batchSize: options.batchSize }));

  const coPurchases = await runStage("co-purchase", () => computeCoPurchases({ client }));
  const popularity = await runStage("popularity", () => computePopularity({ client }));

  const totalMs = Date.now() - startedAt;
  logger.info("recommendation offline compute complete", {
    similarity: similarity.wrote,
    coPurchases: coPurchases.wrote,
    popularity: popularity.wrote,
    totalMs,
  });
  return { similarity, coPurchases, popularity, totalMs };
}

async function runStage(name: string, run: () => Promise<ComputeResult>): Promise<ComputeResult> {
  const startedAt = Date.now();
  try {
    return await run();
  } catch (error) {
    // A failed stage must not take the rest of the batch down with it.
    logger.error("recommendation compute stage failed", {
      stage: name,
      error: error instanceof Error ? error.message : String(error),
    });
    return { wrote: 0, skipped: 0, durationMs: Date.now() - startedAt };
  }
}

/* ── Diagnostics ──────────────────────────────────────────────────────── */

/**
 * Coverage of the precomputed tables.
 *
 * Reported so a missing job run is visible as a number rather than inferred
 * from recommendations quietly degrading. A catalog where 4% of products have
 * similarity rows will still "work" — it will just fall back to the
 * content-similarity floor for 96% of requests, and nothing would say so.
 */
export async function computeCoverage(
  client: DbClient = db,
): Promise<{
  products: number;
  withSimilarity: number;
  withCoPurchase: number;
  withPopularity: number;
  similarityCoverage: number;
  coPurchaseCoverage: number;
  popularityCoverage: number;
}> {
  const coverageResult = await client.execute<{
    products: number;
    with_similarity: number;
    with_co_purchase: number;
    with_popularity: number;
  }>(sql`
    select
      (select count(*)::int from product_search_index where is_searchable = true) as products,
      (select count(distinct product_id)::int from product_similarity) as with_similarity,
      (select count(distinct product_id)::int from product_co_purchases) as with_co_purchase,
      (select count(distinct product_id)::int from product_popularity) as with_popularity
  `);

  const row = coverageResult.rows[0];
  const products = row?.products ?? 0;
  const ratio = (value: number) => (products > 0 ? Number((value / products).toFixed(4)) : 0);

  return {
    products,
    withSimilarity: row?.with_similarity ?? 0,
    withCoPurchase: row?.with_co_purchase ?? 0,
    withPopularity: row?.with_popularity ?? 0,
    similarityCoverage: ratio(row?.with_similarity ?? 0),
    coPurchaseCoverage: ratio(row?.with_co_purchase ?? 0),
    popularityCoverage: ratio(row?.with_popularity ?? 0),
  };
}

export const COMPUTE_INTERNALS = { tokenize, toInput, loadSimilarityRows, and, inArray, desc };
