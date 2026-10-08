import "server-only";

import { and, asc, desc, eq, inArray, ne, notInArray, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  productRelations,
  products,
  productSearchIndex,
  type ProductRelation,
} from "@/db/schema";
import type { DbClient } from "@/db/utils";
import { withTransaction } from "@/db/utils";
import { NotFoundError, ValidationError } from "@/lib/errors";
import type { PublicProductDTO } from "@/lib/catalog/dto";
import { getRelatedProducts } from "@/services/catalog/related.service";
import { searchProducts } from "@/services/catalog/search.service";
import { hydratePublicProducts, listColumns } from "@/services/catalog/public-catalog.service";
import { publicProductCondition } from "@/services/catalog/visibility";

/**
 * Recommendations.
 *
 * This module deliberately does **not** re-implement similarity scoring. Two
 * related-product paths already exist and stay authoritative for what they do:
 *
 *   - `related.service.ts` ranks by structural signals (shared collection,
 *     category, product type, tags) in one SQL query.
 *   - `search.service.ts#getRelatedProducts` ranks by the search index within a
 *     category.
 *
 * What this module adds is the layer neither of them has: **curated and observed
 * relationships** stored in `product_relations` — merchandising picks, upsells,
 * frequently-bought-together pairs, and accessories — blended with the inferred
 * results and always filtered down to products a shopper may actually see.
 *
 * The blend order is a product decision, not an accident: a human-curated link
 * beats an inferred one, because a merchandiser who pinned "this case goes with
 * this phone" knows something the corpus does not.
 */

export const MAX_RECOMMENDATIONS = 24;
export const DEFAULT_RECOMMENDATIONS = 8;

export const RELATION_TYPES = [
  "RELATED",
  "UPSELL",
  "CROSS_SELL",
  "FREQUENTLY_BOUGHT_TOGETHER",
  "ACCESSORY",
] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

export type RecommendationStrategy = "similar" | "complementary" | "upsell" | "popular";

export interface RecommendationOptions {
  strategy?: RecommendationStrategy;
  limit?: number;
  /** Exclude ids the caller has already shown, e.g. the rest of the basket. */
  exclude?: readonly string[];
  categoryId?: string | null;
}

export interface RecommendationResult {
  strategy: RecommendationStrategy;
  seeds: string[];
  items: PublicProductDTO[];
  /** Which signals produced each item, for the admin "why this?" view. */
  sources: Record<string, RelationType | "inferred" | "popularity">;
}

export interface RelationRow extends ProductRelation {}

/* ── curated relations ───────────────────────────────────────────────── */

/**
 * Relations pointing away from a product, best first.
 *
 * Ordering: score, then manual-over-inferred, then observed co-occurrence. A
 * curated 0.5 outranks an inferred 0.9 — intent beats statistics.
 */
export async function listRelations(
  productId: string,
  options: { relationType?: RelationType | null; limit?: number } = {},
  client: DbClient = db,
): Promise<RelationRow[]> {
  const filters = [eq(productRelations.productId, productId)];
  if (options.relationType) filters.push(eq(productRelations.relationType, options.relationType));

  return client
    .select()
    .from(productRelations)
    .where(and(...filters))
    .orderBy(
      desc(productRelations.isManual),
      desc(productRelations.score),
      desc(productRelations.coOccurrenceCount),
    )
    .limit(Math.max(1, Math.min(options.limit ?? MAX_RECOMMENDATIONS, MAX_RECOMMENDATIONS)));
}

export async function setRelation(
  input: {
    productId: string;
    relatedProductId: string;
    relationType?: RelationType;
    score?: number;
  },
  options: { actorId?: string | null } = {},
): Promise<RelationRow> {
  if (input.productId === input.relatedProductId) {
    // A product related to itself is a no-op at best and an infinite loop in a
    // naive recommendation walk at worst.
    throw new ValidationError("A product cannot be related to itself.");
  }
  if (input.score !== undefined && (!Number.isFinite(input.score) || input.score < 0 || input.score > 1)) {
    throw new ValidationError("score must be between 0 and 1.");
  }

  return withTransaction(async (tx) => {
    const [target] = await tx
      .select({ id: products.id })
      .from(products)
      .where(eq(products.id, input.relatedProductId))
      .limit(1);
    if (!target) throw new NotFoundError("Related product not found");

    const relationType = input.relationType ?? "RELATED";

    // Existence check rather than an upsert: the pair is unique per relation
    // type, and reading first lets us keep the accumulated co-occurrence count
    // instead of resetting it on every re-save.
    const [existing] = await tx
      .select()
      .from(productRelations)
      .where(
        and(
          eq(productRelations.productId, input.productId),
          eq(productRelations.relatedProductId, input.relatedProductId),
          eq(productRelations.relationType, relationType),
        ),
      )
      .limit(1);

    if (existing) {
      const [row] = await tx
        .update(productRelations)
        .set({ score: input.score ?? existing.score, isManual: true })
        .where(eq(productRelations.id, existing.id))
        .returning();
      return row;
    }

    const [row] = await tx
      .insert(productRelations)
      .values({
        productId: input.productId,
        relatedProductId: input.relatedProductId,
        relationType,
        score: input.score ?? 0.5,
        isManual: true,
        coOccurrenceCount: 0,
      })
      .returning();
    void options.actorId;
    return row;
  });
}

export async function removeRelation(relationId: string): Promise<void> {
  const [row] = await db.delete(productRelations).where(eq(productRelations.id, relationId)).returning();
  if (!row) throw new NotFoundError("Relation not found");
}

/**
 * Record an observed co-purchase.
 *
 * Kept separate from `setRelation` because it runs on the order path, must never
 * throw into a checkout, and accumulates a count rather than expressing intent.
 */
export async function recordCoOccurrence(
  productIds: readonly string[],
  client: DbClient = db,
): Promise<number> {
  const unique = [...new Set(productIds)];
  if (unique.length < 2) return 0;

  let written = 0;
  for (const a of unique) {
    for (const b of unique) {
      if (a === b) continue;
      // Symmetric pairs are stored in both directions so a recommendation lookup
      // never has to scan for the reverse row.
      const [existing] = await client
        .select({ id: productRelations.id, coOccurrenceCount: productRelations.coOccurrenceCount })
        .from(productRelations)
        .where(
          and(
            eq(productRelations.productId, a),
            eq(productRelations.relatedProductId, b),
            eq(productRelations.relationType, "FREQUENTLY_BOUGHT_TOGETHER"),
          ),
        )
        .limit(1);

      if (existing) {
        await client
          .update(productRelations)
          .set({ coOccurrenceCount: existing.coOccurrenceCount + 1 })
          .where(eq(productRelations.id, existing.id));
      } else {
        await client.insert(productRelations).values({
          productId: a,
          relatedProductId: b,
          relationType: "FREQUENTLY_BOUGHT_TOGETHER",
          // Inferred links start below the curated default so a merchandiser's
          // pick always wins until the data earns its place.
          score: 0.2,
          isManual: false,
          coOccurrenceCount: 1,
        });
      }
      written += 1;
    }
  }
  return written;
}

/* ── recommendation strategies ───────────────────────────────────────── */

/**
 * Curated/inferred relations for a product, filtered to what is publicly
 * viewable.
 *
 * The visibility filter is the whole point of doing this in a service rather
 * than a raw query: `product_relations` has no visibility column, so joining
 * straight to it would happily recommend an unpublished or hidden product.
 */
async function relationCandidates(
  productId: string,
  relationTypes: readonly RelationType[],
  limit: number,
  exclude: readonly string[],
  client: DbClient,
): Promise<Array<{ id: string; source: RelationType }>> {
  const rows = await client
    .select({
      id: productRelations.relatedProductId,
      relationType: productRelations.relationType,
    })
    .from(productRelations)
    .where(and(eq(productRelations.productId, productId), inArray(productRelations.relationType, [...relationTypes])))
    .orderBy(desc(productRelations.isManual), desc(productRelations.score), desc(productRelations.coOccurrenceCount))
    .limit(limit * 3);

  const filtered = rows.filter((row) => !exclude.includes(row.id) && row.id !== productId);
  return filtered.slice(0, limit).map((row) => ({ id: row.id, source: row.relationType }));
}

export async function recommendForProduct(
  productId: string,
  options: RecommendationOptions = {},
  client: DbClient = db,
): Promise<RecommendationResult> {
  const strategy = options.strategy ?? "similar";
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_RECOMMENDATIONS, MAX_RECOMMENDATIONS));
  const exclude = [...(options.exclude ?? []), productId];

  const relationTypes: readonly RelationType[] =
    strategy === "complementary"
      ? ["FREQUENTLY_BOUGHT_TOGETHER", "ACCESSORY", "CROSS_SELL"]
      : strategy === "upsell"
        ? ["UPSELL", "CROSS_SELL"]
        : ["RELATED", "UPSELL"];

  const curated =
    strategy === "popular" ? [] : await relationCandidates(productId, relationTypes, limit, exclude, client);

  const sources: Record<string, RelationType | "inferred" | "popularity"> = {};
  for (const item of curated) sources[item.id] = item.source;

  let ids = curated.map((item) => item.id);

  // Top up from the inferred path when curation does not fill the slot count.
  // Padding with real related items beats padding with bestsellers, which would
  // make every product page show the same four things.
  if (ids.length < limit) {
    const inferred = await getRelatedProducts(productId, limit - ids.length);
    for (const item of inferred) {
      if (ids.includes(item.id) || exclude.includes(item.id)) continue;
      ids.push(item.id);
      sources[item.id] = "inferred";
      if (ids.length >= limit) break;
    }
  }

  if (strategy === "popular" || ids.length < limit) {
    const popular = await popularIds(limit - ids.length, [...exclude, ...ids], options.categoryId ?? null, client);
    for (const id of popular) {
      if (ids.includes(id)) continue;
      ids.push(id);
      sources[id] = "popularity";
      if (ids.length >= limit) break;
    }
  }

  const items = ids.length ? await hydrateInOrder(ids, client) : [];
  return { strategy, seeds: [productId], items, sources };
}

/** Recommendations for a whole basket, de-duplicated across the lines. */
export async function recommendForBasket(
  productIds: readonly string[],
  options: RecommendationOptions = {},
  client: DbClient = db,
): Promise<RecommendationResult> {
  const seeds = [...new Set(productIds)];
  if (!seeds.length) {
    return { strategy: options.strategy ?? "complementary", seeds: [], items: [], sources: {} };
  }

  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_RECOMMENDATIONS, MAX_RECOMMENDATIONS));
  const sources: Record<string, RelationType | "inferred" | "popularity"> = {};
  const ids: string[] = [];

  for (const seed of seeds) {
    const result = await recommendForProduct(
      seed,
      { ...options, limit, exclude: [...(options.exclude ?? []), ...seeds, ...ids] },
      client,
    );
    for (const item of result.items) {
      if (ids.includes(item.id)) continue;
      ids.push(item.id);
      sources[item.id] = result.sources[item.id] ?? "inferred";
      if (ids.length >= limit) break;
    }
    if (ids.length >= limit) break;
  }

  const items = ids.length ? await hydrateInOrder(ids, client) : [];
  return { strategy: options.strategy ?? "complementary", seeds, items, sources };
}

/** Bestsellers, used as the last-resort filler. */
async function popularIds(
  limit: number,
  exclude: readonly string[],
  categoryId: string | null,
  client: DbClient,
): Promise<string[]> {
  if (limit <= 0) return [];

  const filters = [eq(productSearchIndex.isSearchable, true)];
  if (exclude.length) filters.push(notInArray(productSearchIndex.productId, [...exclude]));
  if (categoryId) filters.push(eq(productSearchIndex.categoryId, categoryId));

  const rows = await client
    .select({ productId: productSearchIndex.productId })
    .from(productSearchIndex)
    .where(and(...filters))
    .orderBy(desc(productSearchIndex.popularity), desc(productSearchIndex.ratingAverage))
    .limit(limit);

  return rows.map((row) => row.productId);
}

/**
 * Hydrate ids into public DTOs, preserving the caller's order.
 *
 * `hydratePublicProducts` returns rows in whatever order the query produced, so
 * re-sorting here is what keeps a curated ranking intact. Dropping ids that do
 * not hydrate is intentional: a recommendation pointing at a product that has
 * since been unpublished must disappear rather than render as a broken card.
 */
async function hydrateInOrder(ids: readonly string[], client: DbClient): Promise<PublicProductDTO[]> {
  if (!ids.length) return [];
  // Same two-step as related.service: select the listing columns, restore the
  // caller's order, then hydrate. `hydratePublicProducts` takes rows rather than
  // ids, and hydrating before ordering would lose the ranking.
  const rows = await client.select(listColumns).from(products).where(inArray(products.id, [...ids]));
  const order = new Map(ids.map((value, index) => [value, index]));
  rows.sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  return hydratePublicProducts(rows);
}

/* ── reporting ───────────────────────────────────────────────────────── */

export interface RelationCoverage {
  totalProducts: number;
  productsWithRelations: number;
  coverage: number;
  byType: Record<string, number>;
}

/**
 * How much of the catalog has curated relationships.
 *
 * This is the metric that tells merchandising whether the recommendation slots
 * are being filled by intent or by fallback — a low coverage number means most
 * shoppers are seeing the inferred path.
 */
export async function relationCoverage(client: DbClient = db): Promise<RelationCoverage> {
  const [total] = await client
    .select({ total: sql<number>`count(*)::int` })
    .from(products)
    .where(eq(products.status, "ACTIVE"));

  const byTypeRows = await client
    .select({
      relationType: productRelations.relationType,
      total: sql<number>`count(*)::int`,
      distinctProducts: sql<number>`count(distinct ${productRelations.productId})::int`,
    })
    .from(productRelations)
    .groupBy(productRelations.relationType);

  const [distinct] = await client
    .select({ total: sql<number>`count(distinct product_id)::int` })
    .from(productRelations);

  const totalProducts = total?.total ?? 0;
  const withRelations = distinct?.total ?? 0;

  return {
    totalProducts,
    productsWithRelations: withRelations,
    coverage: totalProducts === 0 ? 0 : Math.round((withRelations / totalProducts) * 1000) / 1000,
    byType: Object.fromEntries(byTypeRows.map((row) => [row.relationType, row.total])),
  };
}

/** Products with no curated relations — the merchandising worklist. */
export async function productsMissingRelations(
  limit = 50,
  client: DbClient = db,
): Promise<Array<{ id: string; name: string; slug: string }>> {
  return client
    .select({ id: products.id, name: products.name, slug: products.slug })
    .from(products)
    .where(
      and(
        eq(products.status, "ACTIVE"),
        sql`not exists (select 1 from product_relations pr where pr.product_id = ${products.id})`,
      ),
    )
    .orderBy(asc(products.name))
    .limit(limit);
}

export const RECOMMENDATION_INTERNALS = { RELATION_TYPES, publicProductCondition, searchProducts, ne };
