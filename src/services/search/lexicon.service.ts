import "server-only";

import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { attributeDefinitions, attributeOptions, brands, categories, products } from "@/db/schema";
import type { DbClient } from "@/db/utils";
import { tokenize } from "@/lib/catalog/search-text";
import { indexLexicon, type Lexicon, type LexiconEntry, type LexiconIndex } from "@/lib/search/entities";

/**
 * The entity lexicon — what this store's brands, categories, and attributes are
 * called.
 *
 * Built from the catalog itself, never hard-coded. That matters for two reasons:
 * a merchant adding a brand should not need a code change for search to
 * recognise it, and a term that is ambiguous *in this catalog* (a brand named
 * "Polo" alongside polo shirts) is ambiguous here and nowhere else, so the
 * ambiguity count has to come from this data.
 *
 * Cached per process for a short window: the lexicon changes when the catalog
 * changes, not per request, and rebuilding it costs several queries.
 */

interface CacheEntry {
  builtAt: number;
  index: LexiconIndex;
  lexicon: Lexicon;
}

const CACHE_TTL_MS = 60_000;
let cache: CacheEntry | null = null;

/**
 * Build the lexicon from the database.
 *
 * Exposed separately from the cached accessor so tests and the indexing worker
 * can build a fresh copy deterministically.
 */
export async function buildLexicon(client: DbClient = db): Promise<Lexicon> {
  const entries: LexiconEntry[] = [];

  // Track how many distinct meanings a folded term has, so an ambiguous word is
  // scored down rather than applied as a hard filter.
  const meaningCount = new Map<string, Set<string>>();
  const noteMeaning = (term: string, meaning: string) => {
    const folded = term.trim().toLowerCase();
    if (!folded) return;
    const set = meaningCount.get(folded);
    if (set) set.add(meaning);
    else meaningCount.set(folded, new Set([meaning]));
  };

  const [brandRows, categoryRows, axisRows, optionRows, productCounts] = await Promise.all([
    client.select({ id: brands.id, name: brands.name }).from(brands).where(eq(brands.isActive, true)),
    client
      .select({ id: categories.id, name: categories.name, slug: categories.slug })
      .from(categories)
      .where(eq(categories.isActive, true)),
    client
      .select({ code: attributeDefinitions.code, name: attributeDefinitions.name, isSwatch: attributeDefinitions.isSwatch })
      .from(attributeDefinitions)
      .where(eq(attributeDefinitions.isActive, true)),
    client
      .select({
        code: attributeDefinitions.code,
        isSwatch: attributeDefinitions.isSwatch,
        label: attributeOptions.label,
      })
      .from(attributeOptions)
      .innerJoin(attributeDefinitions, eq(attributeOptions.definitionId, attributeDefinitions.id))
      .where(and(eq(attributeOptions.isActive, true), eq(attributeDefinitions.isActive, true))),
    countProductsByBrandAndCategory(client),
  ]);

  for (const brand of brandRows) {
    entries.push({
      term: brand.name.toLowerCase(),
      kind: "BRAND",
      value: brand.name,
      id: brand.id,
      productCount: productCounts.brands.get(brand.id) ?? 0,
    });
    noteMeaning(brand.name, `brand:${brand.id}`);
    // Each word of a multi-word brand is a weaker brand signal on its own.
    for (const token of tokenize(brand.name)) {
      entries.push({
        term: token,
        kind: "BRAND",
        value: brand.name,
        id: brand.id,
        productCount: Math.floor((productCounts.brands.get(brand.id) ?? 0) / 2),
      });
      noteMeaning(token, `brand:${brand.id}`);
    }
  }

  for (const category of categoryRows) {
    entries.push({
      term: category.name.toLowerCase(),
      kind: "CATEGORY",
      value: category.name,
      id: category.id,
      productCount: productCounts.categories.get(category.id) ?? 0,
    });
    noteMeaning(category.name, `category:${category.id}`);

    const slugWords = category.slug.replace(/-/g, " ");
    if (slugWords.toLowerCase() !== category.name.toLowerCase()) {
      entries.push({
        term: slugWords,
        kind: "CATEGORY",
        value: category.name,
        id: category.id,
        productCount: productCounts.categories.get(category.id) ?? 0,
      });
    }
    for (const token of tokenize(category.name)) {
      entries.push({
        term: token,
        kind: "CATEGORY",
        value: category.name,
        id: category.id,
        productCount: Math.floor((productCounts.categories.get(category.id) ?? 0) / 2),
      });
      noteMeaning(token, `category:${category.id}`);
    }
  }

  for (const option of optionRows) {
    const axis = option.code;
    // Colour and size are surfaced as their own filter dimensions rather than as
    // generic attributes, because that is how shoppers think about them.
    const kind = option.isSwatch || axis === "color" ? "COLOR" : axis === "size" ? "SIZE" : "ATTRIBUTE";
    entries.push({
      term: option.label.toLowerCase(),
      kind,
      value: option.label,
      axis,
    });
    noteMeaning(option.label, `${axis}:${option.label}`);
    for (const token of tokenize(option.label)) {
      entries.push({ term: token, kind, value: option.label, axis });
      noteMeaning(token, `${axis}:${option.label}`);
    }
  }

  // Axis names themselves ("storage", "material") are not entities; noting them
  // here only serves the ambiguity count.
  for (const axis of axisRows) noteMeaning(axis.name, `axis:${axis.code}`);

  // Apply the ambiguity counts. A term with three meanings is a third as likely
  // to be any one of them, and must not silently narrow the search.
  for (const entry of entries) {
    const meanings = meaningCount.get(entry.term);
    entry.ambiguity = meanings ? meanings.size : 1;
  }

  return { entries: dedupeEntries(entries) };
}

/**
 * Collapse duplicate (term, value, kind) triples.
 *
 * The same word can be reached from several sources; keeping every copy would
 * make the matcher report the same entity repeatedly and inflate its confidence.
 */
function dedupeEntries(entries: readonly LexiconEntry[]): LexiconEntry[] {
  const seen = new Map<string, LexiconEntry>();
  for (const entry of entries) {
    const key = `${entry.term}|${entry.kind}|${entry.value}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, { ...entry });
      continue;
    }
    // Keep the strongest evidence for the duplicated entry.
    existing.productCount = Math.max(existing.productCount ?? 0, entry.productCount ?? 0);
    existing.ambiguity = Math.max(existing.ambiguity ?? 1, entry.ambiguity ?? 1);
  }
  return [...seen.values()];
}

async function countProductsByBrandAndCategory(
  client: DbClient,
): Promise<{ brands: Map<string, number>; categories: Map<string, number> }> {
  const { sql } = await import("drizzle-orm");
  const rows = await client
    .select({
      brandId: products.brandId,
      categoryId: products.categoryId,
      count: sql<number>`count(*)::int`,
    })
    .from(products)
    .where(eq(products.status, "ACTIVE"))
    .groupBy(products.brandId, products.categoryId);

  const brands = new Map<string, number>();
  const categories = new Map<string, number>();
  for (const row of rows) {
    if (row.brandId) brands.set(row.brandId, (brands.get(row.brandId) ?? 0) + row.count);
    if (row.categoryId) categories.set(row.categoryId, (categories.get(row.categoryId) ?? 0) + row.count);
  }
  return { brands, categories };
}

/** Cached lexicon index. Pass `fresh: true` to bypass the cache. */
export async function getLexiconIndex(
  options: { fresh?: boolean; client?: DbClient } = {},
): Promise<LexiconIndex> {
  const now = Date.now();
  if (!options.fresh && cache && now - cache.builtAt < CACHE_TTL_MS) return cache.index;

  const lexicon = await buildLexicon(options.client ?? db);
  const index = indexLexicon(lexicon);
  cache = { builtAt: now, index, lexicon };
  return index;
}

/** Drop the cached lexicon. Called after a brand/category/attribute write. */
export function invalidateLexiconCache(): void {
  cache = null;
}

/** Entry count, for the admin dashboard and the health endpoint. */
export async function lexiconStats(client: DbClient = db): Promise<{
  entries: number;
  brands: number;
  categories: number;
  attributes: number;
}> {
  const lexicon = await buildLexicon(client);
  const count = (kind: string) => lexicon.entries.filter((entry) => entry.kind === kind).length;
  return {
    entries: lexicon.entries.length,
    brands: count("BRAND"),
    categories: count("CATEGORY"),
    attributes:
      count("ATTRIBUTE") + count("COLOR") + count("SIZE") + count("GENDER") + count("MATERIAL"),
  };
}
