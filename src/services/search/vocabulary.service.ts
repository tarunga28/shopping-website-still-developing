import "server-only";

import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  attributeDefinitions,
  attributeOptions,
  brands,
  categories,
  productSearchIndex,
  searchVocabulary,
  tags,
} from "@/db/schema";
import type { DbClient } from "@/db/utils";
import { withTransaction } from "@/db/utils";
import { tokenize } from "@/lib/catalog/search-text";
import { VOCABULARY_SOURCES, type VocabularySource } from "@/db/schema/search";
import { type VocabularyTerm } from "@/lib/search/spell";

/**
 * The spell-correction vocabulary.
 *
 * `search_vocabulary` holds one row per distinct *term* the catalog knows, not
 * one row per product. That is what makes controlled typo correction possible at
 * a bounded cost: correcting a token means scanning a few thousand distinct
 * words, not a few hundred thousand products.
 *
 * The table is a projection of data that already exists (product names, brands,
 * categories, attribute values, tags). It is rebuilt from those sources, so it
 * can never be the authority — deleting it and re-running `rebuildVocabulary`
 * reproduces it exactly.
 */

/** Terms shorter than this are not useful corrections and add noise. */
const MIN_TERM_LENGTH = 3;

/**
 * Rebuild the vocabulary from the catalog.
 *
 * Runs in batches and upserts by term, so it is safe to re-run and safe to run
 * while the storefront is serving. The `document_count` is accumulated across
 * sources because a word that is both a brand and a tag is stronger evidence
 * than one that appears once.
 */
export async function rebuildVocabulary(
  options: { batchSize?: number; client?: DbClient } = {},
): Promise<{ terms: number; sources: Record<VocabularySource, number> }> {
  const client = options.client ?? db;
  const batchSize = Math.max(50, Math.min(options.batchSize ?? 500, 5000));

  // term -> { source, documentCount, brandId, categoryId }
  const collected = new Map<
    string,
    { source: VocabularySource; documentCount: number; brandId: string | null; categoryId: string | null }
  >();

  const record = (
    term: string,
    source: VocabularySource,
    weight: number,
    ids: { brandId?: string | null; categoryId?: string | null } = {},
  ) => {
    const folded = term.trim().toLowerCase();
    if (folded.length < MIN_TERM_LENGTH) return;
    if (!/^[a-z0-9][a-z0-9\s-]*$/.test(folded)) return;

    const existing = collected.get(folded);
    if (existing) {
      existing.documentCount += weight;
      // Keep the most specific source: a term that is a brand is more useful to
      // a correction than the same term appearing as a product word.
      if (sourcePriority(source) > sourcePriority(existing.source)) {
        existing.source = source;
        existing.brandId = ids.brandId ?? existing.brandId;
        existing.categoryId = ids.categoryId ?? existing.categoryId;
      }
      return;
    }
    collected.set(folded, {
      source,
      documentCount: weight,
      brandId: ids.brandId ?? null,
      categoryId: ids.categoryId ?? null,
    });
  };

  // ── Brands ───────────────────────────────────────────────────────────
  const brandRows = await client
    .select({ id: brands.id, name: brands.name })
    .from(brands)
    .where(eq(brands.isActive, true));
  for (const brand of brandRows) {
    record(brand.name, "BRAND", 50, { brandId: brand.id });
    // Each word of a multi-word brand is also a correction target, so "addidas"
    // can be corrected from a query that only typed part of the name.
    for (const token of tokenize(brand.name)) record(token, "BRAND", 25, { brandId: brand.id });
  }

  // ── Categories ───────────────────────────────────────────────────────
  const categoryRows = await client
    .select({ id: categories.id, name: categories.name, slug: categories.slug })
    .from(categories);
  for (const category of categoryRows) {
    record(category.name, "CATEGORY", 30, { categoryId: category.id });
    record(category.slug.replace(/-/g, " "), "CATEGORY", 15, { categoryId: category.id });
    for (const token of tokenize(category.name)) record(token, "CATEGORY", 12, { categoryId: category.id });
  }

  // ── Attribute axes and their options ─────────────────────────────────
  const optionRows = await client
    .select({
      axisCode: attributeDefinitions.code,
      label: attributeDefinitions.name,
      optionLabel: attributeOptions.label,
    })
    .from(attributeOptions)
    .innerJoin(attributeDefinitions, eq(attributeOptions.definitionId, attributeDefinitions.id))
    .where(eq(attributeOptions.isActive, true));
  for (const option of optionRows) {
    record(option.optionLabel, "ATTRIBUTE", 20);
    record(`${option.optionLabel} ${option.label}`, "ATTRIBUTE", 8);
    void option.axisCode;
  }

  // ── Tags ─────────────────────────────────────────────────────────────
  const tagRows = await client.select({ name: tags.name }).from(tags);
  for (const tag of tagRows) record(tag.name, "TAG", 6);

  // ── Product terms ────────────────────────────────────────────────────
  // Keyset-paged so a large catalog never lands in memory at once.
  let cursor: string | null = null;
  for (;;) {
    const conditions = [isNotNull(productSearchIndex.name)];
    if (cursor) conditions.push(sql`${productSearchIndex.productId} > ${cursor}`);

    const batch = await client
      .select({
        productId: productSearchIndex.productId,
        name: productSearchIndex.name,
        attributeText: productSearchIndex.attributeText,
      })
      .from(productSearchIndex)
      .where(and(...conditions))
      .orderBy(productSearchIndex.productId)
      .limit(batchSize);

    if (batch.length === 0) break;

    for (const row of batch) {
      for (const token of tokenize(row.name)) record(token, "PRODUCT", 1);
      for (const token of tokenize(row.attributeText)) record(token, "ATTRIBUTE", 2);
    }
    cursor = batch[batch.length - 1]!.productId;
    if (batch.length < batchSize) break;
  }

  // ── Write ────────────────────────────────────────────────────────────
  const sourceCounts: Record<VocabularySource, number> = {
    PRODUCT: 0,
    BRAND: 0,
    CATEGORY: 0,
    ATTRIBUTE: 0,
    TAG: 0,
    QUERY: 0,
  };

  await withTransaction(async (tx) => {
    const entries = [...collected.entries()];
    for (let index = 0; index < entries.length; index += 500) {
      const chunk = entries.slice(index, index + 500);
      await tx
        .insert(searchVocabulary)
        .values(
          chunk.map(([term, meta]) => ({
            term,
            source: meta.source,
            documentCount: Math.max(1, meta.documentCount),
            brandId: meta.brandId,
            categoryId: meta.categoryId,
            trigramText: term,
            lastSeenAt: new Date(),
          })),
        )
        .onConflictDoUpdate({
          target: searchVocabulary.term,
          set: {
            source: sql`excluded.source`,
            documentCount: sql`excluded.document_count`,
            brandId: sql`excluded.brand_id`,
            categoryId: sql`excluded.category_id`,
            lastSeenAt: sql`excluded.last_seen_at`,
          },
        });
      for (const [, meta] of chunk) sourceCounts[meta.source] += 1;
    }
  });

  return { terms: collected.size, sources: sourceCounts };
}

function sourcePriority(source: VocabularySource): number {
  return VOCABULARY_SOURCES.indexOf(source);
}

/**
 * Load the vocabulary as the spell checker needs it.
 *
 * Ordered by document count descending so that when a caller truncates for
 * performance, it keeps the most useful corrections rather than the rarest.
 */
export async function loadVocabulary(
  options: { limit?: number; minDocumentCount?: number; client?: DbClient } = {},
): Promise<VocabularyTerm[]> {
  const client = options.client ?? db;
  const limit = Math.max(100, Math.min(options.limit ?? 20_000, 100_000));

  const conditions = [];
  if (options.minDocumentCount && options.minDocumentCount > 1) {
    conditions.push(gte(searchVocabulary.documentCount, options.minDocumentCount));
  }

  const rows = await client
    .select({
      term: searchVocabulary.term,
      source: searchVocabulary.source,
      documentCount: searchVocabulary.documentCount,
    })
    .from(searchVocabulary)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(searchVocabulary.documentCount))
    .limit(limit);

  return rows;
}

/**
 * Seed the vocabulary with terms observed in real shopper queries.
 *
 * A query that returned results and was typed often is evidence that the term is
 * part of how people describe this catalog, so it belongs in the dictionary —
 * which in turn makes it a valid correction target.
 */
export async function recordObservedTerms(
  terms: ReadonlyArray<{ term: string; count: number }>,
  client: DbClient = db,
): Promise<number> {
  if (terms.length === 0) return 0;

  let written = 0;
  for (const entry of terms) {
    const folded = entry.term.trim().toLowerCase();
    if (folded.length < MIN_TERM_LENGTH) continue;
    await client
      .insert(searchVocabulary)
      .values({
        term: folded,
        source: "QUERY",
        documentCount: Math.max(1, entry.count),
        trigramText: folded,
        lastSeenAt: new Date(),
      })
      .onConflictDoUpdate({
        target: searchVocabulary.term,
        set: { lastSeenAt: new Date() },
      });
    written += 1;
  }
  return written;
}

export async function vocabularyStats(client: DbClient = db): Promise<{
  total: number;
  bySource: Array<{ source: string; count: number }>;
}> {
  const rows = await client
    .select({ source: searchVocabulary.source, count: sql<number>`count(*)::int` })
    .from(searchVocabulary)
    .groupBy(searchVocabulary.source);

  return {
    total: rows.reduce((sum, row) => sum + row.count, 0),
    bySource: rows,
  };
}

