import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  brands,
  categories,
  productSearchIndex,
  searchQueryLogs,
  searchSuggestions,
} from "@/db/schema";
import type { DbClient } from "@/db/utils";
import { logger } from "@/lib/logger";
import { sanitizeQuery } from "@/lib/catalog/search-text";
import type { SuggestionItem } from "@/lib/search/types";
import { buildProcessedQuery } from "@/services/search/query.service";

/**
 * Autocomplete and typed suggestions.
 *
 * ## Optimised separately, on purpose
 *
 * Autocomplete fires on every keystroke. It must not run the search pipeline: no
 * spell correction pass over the vocabulary, no faceting, no result hydration.
 * This module queries pre-materialised suggestion rows and a bounded prefix scan
 * of the search index, and returns.
 *
 * The correctness trade-off is deliberate and stated: a suggestion may be
 * slightly stale (the table is refreshed by the indexing worker), because being
 * 30 seconds behind on autocomplete is invisible while being 300 ms slow on it is
 * not.
 *
 * ## Typed results
 *
 * Each suggestion carries a `type` so the frontend can render a product with a
 * thumbnail, a brand with a logo, and a plain query as text. That is a contract
 * with the UI, not a presentation detail leaking into the service.
 */

/** Longest prefix accepted. Longer input is a search, not a completion. */
export const MAX_SUGGESTION_PREFIX = 60;

/** Total suggestions returned across all types. */
export const DEFAULT_SUGGESTION_LIMIT = 10;

export interface SuggestionRequest {
  prefix: string;
  limit?: number;
  /** Include the signed-in shopper's own recent searches. */
  history?: SuggestionItem[];
  client?: DbClient;
}

export interface SuggestionResult {
  prefix: string;
  suggestions: SuggestionItem[];
  tookMs: number;
  /** True when the prefix was too short to complete from and only history/trending were returned. */
  partial: boolean;
}

/**
 * Autocomplete for a prefix.
 *
 * Never throws. Autocomplete failing must not break the search box; the shopper
 * can still type and press Enter.
 */
export async function getSuggestions(input: SuggestionRequest): Promise<SuggestionResult> {
  const startedAt = Date.now();
  const client = input.client ?? db;
  const prefix = sanitizeQuery(input.prefix).slice(0, MAX_SUGGESTION_PREFIX).trim();
  const limit = Math.max(1, Math.min(input.limit ?? DEFAULT_SUGGESTION_LIMIT, 20));

  if (prefix.length < 2) {
    return {
      prefix,
      suggestions: [...(input.history ?? []), ...(await trendingSuggestions(client, limit))].slice(0, limit),
      tookMs: Date.now() - startedAt,
      partial: true,
    };
  }

  const needle = `${prefix.toLowerCase()}%`;

  try {
    const [suggestionRows, brandRows, categoryRows, productRows] = await Promise.all([
      // Previously-typed queries that led somewhere. These are the highest-value
      // completions because they are proven to return results.
      client
        .select({
          term: searchSuggestions.term,
          kind: searchSuggestions.kind,
          productId: searchSuggestions.productId,
          categoryId: searchSuggestions.categoryId,
          brandId: searchSuggestions.brandId,
          weight: searchSuggestions.weight,
        })
        .from(searchSuggestions)
        .where(and(eq(searchSuggestions.isActive, true), sql`lower(${searchSuggestions.term}) like ${needle}`))
        .orderBy(desc(searchSuggestions.weight))
        .limit(limit * 2),
      client
        .select({ id: brands.id, name: brands.name, slug: brands.slug, logoUrl: brands.logoUrl })
        .from(brands)
        .where(and(eq(brands.isActive, true), sql`lower(${brands.name}) like ${needle}`))
        .orderBy(desc(sql`length(${brands.name})`))
        .limit(3),
      client
        .select({ id: categories.id, name: categories.name, slug: categories.slug })
        .from(categories)
        .where(and(eq(categories.isActive, true), sql`lower(${categories.name}) like ${needle}`))
        .limit(3),
      client
        .select({
          productId: productSearchIndex.productId,
          slug: productSearchIndex.slug,
          name: productSearchIndex.name,
          brandName: productSearchIndex.brandName,
          popularity: productSearchIndex.popularity,
        })
        .from(productSearchIndex)
        .where(and(eq(productSearchIndex.isSearchable, true), sql`lower(${productSearchIndex.name}) like ${needle}`))
        .orderBy(desc(productSearchIndex.popularity))
        .limit(4),
    ]);

    const suggestions: SuggestionItem[] = [...(input.history ?? [])];

    for (const row of brandRows) {
      suggestions.push({
        type: "BRAND",
        text: row.name,
        href: `/shop?brand=${row.slug}`,
        imageUrl: row.logoUrl,
        meta: "Brand",
        weight: 900,
      });
    }

    for (const row of categoryRows) {
      suggestions.push({
        type: "CATEGORY",
        text: row.name,
        href: `/category/${row.slug}`,
        imageUrl: null,
        meta: "Category",
        weight: 800,
      });
    }

    for (const row of productRows) {
      suggestions.push({
        type: "PRODUCT",
        text: row.name,
        href: `/product/${row.slug}`,
        imageUrl: null,
        meta: row.brandName ?? "Product",
        weight: 700 + Math.min(100, row.popularity ?? 0),
      });
    }

    for (const row of suggestionRows) {
      suggestions.push({
        type: row.kind === "TRENDING" ? "TRENDING_QUERY" : "SEARCH_QUERY",
        text: row.term,
        href: `/search?q=${encodeURIComponent(row.term)}`,
        imageUrl: null,
        meta: null,
        weight: 300 + Math.min(300, row.weight ?? 0),
      });
    }

    const deduped = dedupeSuggestions(suggestions);
    return {
      prefix,
      suggestions: deduped.slice(0, limit),
      tookMs: Date.now() - startedAt,
      partial: false,
    };
  } catch (error) {
    logger.warn("autocomplete failed; returning history only", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      prefix,
      suggestions: (input.history ?? []).slice(0, limit),
      tookMs: Date.now() - startedAt,
      partial: true,
    };
  }
}

function dedupeSuggestions(items: readonly SuggestionItem[]): SuggestionItem[] {
  const seen = new Set<string>();
  const out: SuggestionItem[] = [];
  for (const item of [...items].sort((a, b) => b.weight - a.weight)) {
    const key = item.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** Most-searched queries in the last week, for an empty search box. */
export async function trendingSuggestions(
  client: DbClient = db,
  limit = 8,
): Promise<SuggestionItem[]> {
  try {
    const rows = await client
      .select({
        query: searchQueryLogs.normalizedQuery,
        count: sql<number>`count(*)::int`,
      })
      .from(searchQueryLogs)
      .where(
        and(
          sql`${searchQueryLogs.createdAt} > now() - interval '7 days'`,
          sql`${searchQueryLogs.resultCount} > 0`,
        ),
      )
      .groupBy(searchQueryLogs.normalizedQuery)
      .orderBy(desc(sql`count(*)`))
      .limit(limit);

    return rows.map((row) => ({
      type: "TRENDING_QUERY" as const,
      text: row.query,
      href: `/search?q=${encodeURIComponent(row.query)}`,
      imageUrl: null,
      meta: `${row.count} searches`,
      weight: 200 + Math.min(200, row.count),
    }));
  } catch (error) {
    logger.warn("could not load trending suggestions", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * "Did you mean…?" for a submitted query that returned nothing.
 *
 * Separate from autocomplete because it runs the full pipeline: it needs the
 * spell correction that autocomplete deliberately skips.
 */
export async function suggestCorrections(
  query: string,
  options: { limit?: number; client?: DbClient } = {},
): Promise<SuggestionItem[]> {
  const client = options.client ?? db;
  const limit = Math.max(1, Math.min(options.limit ?? 5, 10));

  try {
    const processed = await buildProcessedQuery(query, { client });
    const items: SuggestionItem[] = [];

    for (const suggestion of processed.suggestedCorrections) {
      items.push({
        type: "SEARCH_QUERY",
        text: suggestion.to,
        href: `/search?q=${encodeURIComponent(suggestion.to)}`,
        imageUrl: null,
        meta: `${Math.round(suggestion.confidence * 100)}% confident`,
        weight: Math.round(suggestion.confidence * 1000),
      });
    }

    // Token-level corrections, for when one word in a longer query is the typo.
    for (const correction of processed.corrections) {
      items.push({
        type: "SEARCH_QUERY",
        text: correction.to,
        href: `/search?q=${encodeURIComponent(correction.to)}`,
        imageUrl: null,
        meta: `Corrected from "${correction.from}"`,
        weight: 500,
      });
    }

    return items.slice(0, limit);
  } catch (error) {
    logger.warn("correction suggestion failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Rebuild the materialised suggestion table.
 *
 * Sources, in priority order: observed queries that returned results (the best
 * predictor of what a shopper wants), then product names, then brands and
 * categories. Rebuilt wholesale rather than incrementally because the weight is
 * derived from aggregate counts, which change globally.
 */
export async function refreshSuggestionTable(
  options: { client?: DbClient; limit?: number } = {},
): Promise<{ rows: number }> {
  const client = options.client ?? db;
  const limit = Math.max(100, Math.min(options.limit ?? 5000, 50_000));

  const [queryRows, productRows, brandRows, categoryRows] = await Promise.all([
    client
      .select({
        query: searchQueryLogs.normalizedQuery,
        count: sql<number>`count(*)::int`,
      })
      .from(searchQueryLogs)
      .where(
        and(
          sql`${searchQueryLogs.resultCount} > 0`,
          sql`${searchQueryLogs.createdAt} > now() - interval '90 days'`,
        ),
      )
      .groupBy(searchQueryLogs.normalizedQuery)
      .orderBy(desc(sql`count(*)`))
      .limit(limit),
    client
      .select({
        productId: productSearchIndex.productId,
        name: productSearchIndex.name,
        popularity: productSearchIndex.popularity,
      })
      .from(productSearchIndex)
      .where(eq(productSearchIndex.isSearchable, true))
      .orderBy(desc(productSearchIndex.popularity))
      .limit(Math.min(limit, 2000)),
    client
      .select({ id: brands.id, name: brands.name })
      .from(brands)
      .where(eq(brands.isActive, true))
      .limit(500),
    client
      .select({ id: categories.id, name: categories.name })
      .from(categories)
      .where(eq(categories.isActive, true))
      .limit(500),
  ]);

  // A term may come from several sources; keep the highest weight and remember
  // which entity it points at so the UI can link straight through.
  const merged = new Map<
    string,
    { kind: string; weight: number; productId: string | null; brandId: string | null; categoryId: string | null }
  >();

  const put = (
    term: string,
    kind: string,
    weight: number,
    ids: { productId?: string | null; brandId?: string | null; categoryId?: string | null } = {},
  ) => {
    const folded = term.trim().toLowerCase();
    if (folded.length < 2) return;
    const existing = merged.get(folded);
    if (existing) {
      if (weight > existing.weight) {
        existing.weight = weight;
        existing.kind = kind;
      }
      existing.productId = existing.productId ?? ids.productId ?? null;
      existing.brandId = existing.brandId ?? ids.brandId ?? null;
      existing.categoryId = existing.categoryId ?? ids.categoryId ?? null;
      return;
    }
    merged.set(folded, {
      kind,
      weight,
      productId: ids.productId ?? null,
      brandId: ids.brandId ?? null,
      categoryId: ids.categoryId ?? null,
    });
  };

  for (const row of queryRows) put(row.query, "SEARCH_QUERY", Math.min(1000, row.count * 10));
  for (const row of productRows) put(row.name, "PRODUCT", Math.min(600, (row.popularity ?? 0) * 6), { productId: row.productId });
  for (const row of brandRows) put(row.name, "BRAND", 500, { brandId: row.id });
  for (const row of categoryRows) put(row.name, "CATEGORY", 450, { categoryId: row.id });

  const entries = [...merged.entries()].slice(0, limit);

  // Replaced wholesale inside one transaction so autocomplete never sees a
  // half-rebuilt table.
  await client.transaction(async (tx) => {
    await tx.delete(searchSuggestions);
    for (let index = 0; index < entries.length; index += 500) {
      const chunk = entries.slice(index, index + 500);
      await tx.insert(searchSuggestions).values(
        chunk.map(([term, meta]) => ({
          term,
          kind: meta.kind,
          productId: meta.productId,
          brandId: meta.brandId,
          categoryId: meta.categoryId,
          weight: meta.weight,
          isActive: true,
        })),
      );
    }
  });

  return { rows: entries.length };
}
