import "server-only";
import { unstable_cache } from "next/cache";
import { CATALOG_CACHE_TAG, CATALOG_REVALIDATE_SECONDS, TAXONOMY_REVALIDATE_SECONDS } from "@/lib/catalog/constants";
import {
  queryCategoryProductCounts,
  queryCategorySlugRedirect,
  queryCatalogFacets,
  queryCollectionSlugRedirect,
  queryPublicCategories,
  queryPublicCollectionBySlug,
  queryPublicCollections,
  queryPublicProducts,
  resolveCategoryFromTree,
  type CatalogQueryInput,
  type CategoryResolution,
} from "./public-catalog.service";

/**
 * Cached storefront reads.
 *
 * - Every entry is tagged `catalog`; admin writes call `invalidateCatalogCache()`
 *   which expires the tag immediately (price, status, category, collection,
 *   image and content changes are visible on the next request).
 * - `revalidate` is a safety net for anything that bypasses the admin
 *   (scheduled collection windows, imports, direct SQL).
 * - Only validated, normalized inputs reach here, so the key space is bounded
 *   by the URL contract. Free-form price ranges skip the cache entirely so
 *   arbitrary numbers cannot flood it.
 * - Personalised data (wishlist state) is never cached here.
 */

const tags = [CATALOG_CACHE_TAG];

function keyOf(input: CatalogQueryInput): string {
  return JSON.stringify({
    c: input.categoryIds ?? null,
    l: input.collectionId ?? null,
    f: input.filters ?? null,
    p: input.page ?? null,
    s: input.pageSize ?? null,
    q: input.search ?? null,
  });
}

function cacheable(input: CatalogQueryInput): boolean {
  const filters = input.filters;
  return !(filters && (filters.minPricePaise != null || filters.maxPricePaise != null)) && !input.search;
}

export function getCachedProducts(input: CatalogQueryInput) {
  if (!cacheable(input)) return queryPublicProducts(input);
  return unstable_cache(() => queryPublicProducts(input), ["catalog:products", keyOf(input)], {
    tags,
    revalidate: CATALOG_REVALIDATE_SECONDS,
  })();
}

export function getCachedFacets(input: CatalogQueryInput) {
  const scope: CatalogQueryInput = {
    categoryIds: input.categoryIds,
    collectionId: input.collectionId,
    filters: { type: input.filters?.type ?? null },
  };
  return unstable_cache(() => queryCatalogFacets(scope), ["catalog:facets", keyOf(scope)], {
    tags,
    revalidate: CATALOG_REVALIDATE_SECONDS,
  })();
}

export const getCachedCategories = unstable_cache(queryPublicCategories, ["catalog:categories"], {
  tags,
  revalidate: TAXONOMY_REVALIDATE_SECONDS,
});

export const getCachedCategoryCounts = unstable_cache(queryCategoryProductCounts, ["catalog:category-counts"], {
  tags,
  revalidate: CATALOG_REVALIDATE_SECONDS,
});

export const getCachedCollections = unstable_cache(queryPublicCollections, ["catalog:collections"], {
  tags,
  revalidate: CATALOG_REVALIDATE_SECONDS,
});

export function getCachedCollection(slug: string) {
  return unstable_cache(() => queryPublicCollectionBySlug(slug), ["catalog:collection", slug], {
    tags,
    revalidate: CATALOG_REVALIDATE_SECONDS,
  })();
}

/** Category lookup with old-slug redirects. Returns a small, serializable result. */
export async function resolveCategory(slug: string): Promise<CategoryResolution> {
  const tree = await getCachedCategories();
  const resolved = resolveCategoryFromTree(tree, slug);
  if (resolved.kind !== "missing") return resolved;
  const target = await unstable_cache(() => queryCategorySlugRedirect(tree, slug), ["catalog:category-redirect", slug], {
    tags,
    revalidate: TAXONOMY_REVALIDATE_SECONDS,
  })();
  return target ? { kind: "redirect", slug: target } : { kind: "missing" };
}

export type CollectionResolution =
  | { kind: "found"; collection: NonNullable<Awaited<ReturnType<typeof queryPublicCollectionBySlug>>> }
  | { kind: "redirect"; slug: string }
  | { kind: "missing" };

export async function resolveCollection(slug: string): Promise<CollectionResolution> {
  const collection = await getCachedCollection(slug);
  if (collection) return { kind: "found", collection };
  const target = await unstable_cache(() => queryCollectionSlugRedirect(slug), ["catalog:collection-redirect", slug], {
    tags,
    revalidate: TAXONOMY_REVALIDATE_SECONDS,
  })();
  return target ? { kind: "redirect", slug: target } : { kind: "missing" };
}
