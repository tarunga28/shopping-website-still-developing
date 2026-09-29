import "server-only";
import { cache } from "react";
import { DEFAULT_PAGE_SIZE } from "@/lib/catalog/constants";
import type { PublicProductDTO } from "@/lib/catalog/dto";
import { buildFacetView, type FacetView } from "@/lib/catalog/facets-view";
import { buildPaginationMeta, type PaginationMeta } from "@/lib/catalog/pagination";
import {
  parseCatalogSearchParams,
  serializeFilters,
  type CatalogFilters,
  type ParsedCatalogParams,
} from "@/lib/catalog/params";
import { childrenOf, type PublicCategory } from "@/lib/catalog/category-tree";
import { errorContext, logger } from "@/lib/logger";
import { isSafeImageSrc } from "@/lib/safe-url";
import {
  getCachedCategories,
  getCachedCategoryCounts,
  getCachedFacets,
  getCachedProducts,
  resolveCategory,
  resolveCollection,
} from "./cached";
import { resolveCategoryFromTree, type CatalogQueryInput } from "./public-catalog.service";

/**
 * Everything a catalog listing page needs, resolved in one place for
 * /shop, /category/[slug] and /collection/[slug].
 *
 * Wrapped in React `cache` keyed by primitives so `generateMetadata` and the
 * page share a single load per request.
 */

export type ListingScope =
  | { kind: "shop" }
  | { kind: "category"; slug: string }
  | { kind: "collection"; slug: string };

export interface Crumb {
  label: string;
  href?: string;
}

export interface CategoryNavItem {
  slug: string;
  name: string;
  count: number;
  children: { slug: string; name: string; count: number }[];
}

export interface CategoryNavData {
  heading: string;
  /** Link one level up (a category page's parent), if any. */
  up: { name: string; href: string } | null;
  currentSlug: string | null;
  items: CategoryNavItem[];
}

export interface ListingHeading {
  title: string;
  description: string;
  eyebrow: string;
  image: { src: string; alt: string } | null;
  seoTitle: string;
  seoDescription: string;
  crumbs: Crumb[];
  jsonLdCrumbs: { name: string; path: string }[];
}

export type ListingResult =
  | { status: "not-found" }
  | { status: "redirect"; to: string; permanent: boolean }
  | { status: "error" }
  | {
      status: "ok";
      scope: ListingScope;
      basePath: string;
      parsed: ParsedCatalogParams;
      filters: CatalogFilters;
      products: PublicProductDTO[];
      pagination: PaginationMeta;
      facets: FacetView;
      categoryNav: CategoryNavData | null;
      heading: ListingHeading;
      /** True when the scope itself (ignoring filters) has no eligible products. */
      scopeIsEmpty: boolean;
    };

const SHOP_DESCRIPTION = "Discover our collection of original products designed for everyday use.";

function scopeBasePath(scope: ListingScope): string {
  if (scope.kind === "category") return `/category/${scope.slug}`;
  if (scope.kind === "collection") return `/collection/${scope.slug}`;
  return "/shop";
}

/** Keep the customer's filters when we redirect to a canonical path. */
function carry(basePath: string, filters: CatalogFilters, page = filters.page): string {
  const query = serializeFilters({ ...filters, page }, { includePage: true });
  return query ? `${basePath}?${query}` : basePath;
}

function buildCategoryNav(
  tree: PublicCategory[],
  counts: Record<string, { count: number }>,
  current: PublicCategory | null,
): CategoryNavData | null {
  const count = (id: string) => counts[id]?.count ?? 0;
  const item = (category: PublicCategory): CategoryNavItem => ({
    slug: category.slug,
    name: category.name,
    count: count(category.id),
    children: childrenOf(tree, category.id)
      .filter((child) => count(child.id) > 0)
      .map((child) => ({ slug: child.slug, name: child.name, count: count(child.id) })),
  });

  if (!current) {
    const roots = childrenOf(tree, null).filter((category) => count(category.id) > 0);
    return roots.length ? { heading: "Categories", up: null, currentSlug: null, items: roots.map(item) } : null;
  }

  const children = childrenOf(tree, current.id).filter((child) => count(child.id) > 0);
  const parent = current.parentId ? tree.find((category) => category.id === current.parentId) : undefined;
  if (children.length > 0) {
    return {
      heading: current.name,
      up: parent ? { name: parent.name, href: `/category/${parent.slug}` } : { name: "All categories", href: "/shop" },
      currentSlug: current.slug,
      items: children.map(item),
    };
  }
  if (parent) {
    const siblings = childrenOf(tree, parent.id).filter((sibling) => count(sibling.id) > 0);
    return {
      heading: parent.name,
      up: { name: `All ${parent.name}`, href: `/category/${parent.slug}` },
      currentSlug: current.slug,
      items: siblings.map(item),
    };
  }
  return null;
}

async function load(kind: ListingScope["kind"], slug: string, search: string): Promise<ListingResult> {
  const scope: ListingScope = kind === "shop" ? { kind } : ({ kind, slug } as ListingScope);
  const basePath = scopeBasePath(scope);
  const parsed = parseCatalogSearchParams(new URLSearchParams(search));
  const filters = parsed.filters;

  try {
    let query: CatalogQueryInput = { filters, pageSize: DEFAULT_PAGE_SIZE };
    let heading: ListingHeading;
    let currentCategory: PublicCategory | null = null;

    const tree = await getCachedCategories();

    if (scope.kind === "shop") {
      // /shop?category=hoodies → the clean /category/hoodies URL.
      if (filters.category) {
        const target = resolveCategoryFromTree(tree, filters.category);
        if (target.kind === "found") {
          return { status: "redirect", to: carry(`/category/${target.category.slug}`, { ...filters, category: null }), permanent: true };
        }
      }
      heading = {
        title: "Shop",
        eyebrow: "Catalogue",
        description: SHOP_DESCRIPTION,
        image: null,
        seoTitle: "Shop Original Print-on-Demand Products",
        seoDescription:
          "Browse original artwork printed on tees, hoodies, mugs, posters and more. Every piece is printed after you order.",
        crumbs: [{ label: "Home", href: "/" }, { label: "Shop" }],
        jsonLdCrumbs: [
          { name: "Home", path: "/" },
          { name: "Shop", path: "/shop" },
        ],
      };
    } else if (scope.kind === "category") {
      const resolved = await resolveCategory(scope.slug);
      if (resolved.kind === "missing") return { status: "not-found" };
      if (resolved.kind === "redirect") {
        return { status: "redirect", to: carry(`/category/${resolved.slug}`, filters), permanent: true };
      }
      currentCategory = resolved.category;
      query = { ...query, categoryIds: resolved.scopeIds };
      const crumbs: Crumb[] = [
        { label: "Home", href: "/" },
        { label: "Shop", href: "/shop" },
        ...resolved.ancestors.map((ancestor) => ({ label: ancestor.name, href: `/category/${ancestor.slug}` })),
        { label: resolved.category.name },
      ];
      heading = {
        title: resolved.category.name,
        eyebrow: "Category",
        description: resolved.category.description?.trim() || "",
        image: resolved.category.image && isSafeImageSrc(resolved.category.image.url)
          ? { src: resolved.category.image.url, alt: resolved.category.image.alt || resolved.category.name }
          : null,
        seoTitle: resolved.category.seoTitle?.trim() || resolved.category.name,
        seoDescription:
          resolved.category.seoDescription?.trim() ||
          resolved.category.description?.trim() ||
          `Shop ${resolved.category.name}, original designs printed after you order.`,
        crumbs,
        jsonLdCrumbs: [
          { name: "Home", path: "/" },
          { name: "Shop", path: "/shop" },
          ...resolved.ancestors.map((ancestor) => ({ name: ancestor.name, path: `/category/${ancestor.slug}` })),
          { name: resolved.category.name, path: `/category/${resolved.category.slug}` },
        ],
      };
    } else {
      const resolved = await resolveCollection(scope.slug);
      if (resolved.kind === "missing") return { status: "not-found" };
      if (resolved.kind === "redirect") {
        return { status: "redirect", to: carry(`/collection/${resolved.slug}`, filters), permanent: true };
      }
      const collection = resolved.collection;
      query = { ...query, collectionId: collection.id };
      heading = {
        title: collection.name,
        eyebrow: "Collection",
        description: collection.description,
        image: collection.image && isSafeImageSrc(collection.image.url) ? { src: collection.image.url, alt: collection.image.alt || collection.name } : null,
        seoTitle: collection.seoTitle?.trim() || collection.name,
        seoDescription:
          collection.seoDescription?.trim() ||
          collection.description ||
          `${collection.name}, a collection of original designs printed after you order.`,
        crumbs: [
          { label: "Home", href: "/" },
          { label: "Collections", href: "/collections" },
          { label: collection.name },
        ],
        jsonLdCrumbs: [
          { name: "Home", path: "/" },
          { name: "Collections", path: "/collections" },
          { name: collection.name, path: `/collection/${collection.slug}` },
        ],
      };
    }

    const [result, rawFacets, counts] = await Promise.all([
      getCachedProducts({ ...query, page: filters.page }),
      getCachedFacets(query),
      scope.kind === "collection" ? Promise.resolve({}) : getCachedCategoryCounts(),
    ]);

    const { total, totalPages } = result.pagination;
    if (filters.page > 1 && (total === 0 || filters.page > totalPages)) {
      // Out-of-range page (stale link, shrunken catalog, hostile value): step back into range.
      return { status: "redirect", to: carry(basePath, filters, total === 0 ? 1 : totalPages), permanent: false };
    }

    // "Nothing matches these filters" and "this category has nothing yet" are different messages.
    let scopeIsEmpty = false;
    if (total === 0) {
      scopeIsEmpty = filtersActive(filters)
        ? (await getCachedProducts({ ...query, filters: { sort: filters.sort }, page: 1, pageSize: 1 })).pagination.total === 0
        : true;
    }

    return {
      status: "ok",
      scope,
      basePath,
      parsed,
      filters,
      products: result.products,
      pagination: buildPaginationMeta({
        page: result.pagination.page,
        pageSize: result.pagination.pageSize,
        total,
        count: result.products.length,
      }),
      facets: buildFacetView(rawFacets, filters),
      categoryNav: scope.kind === "collection" ? null : buildCategoryNav(tree, counts as Record<string, { count: number }>, currentCategory),
      heading,
      scopeIsEmpty,
    };
  } catch (error) {
    // Technical details stay in server logs; the page shows a safe message.
    logger.error("Catalog listing failed", { scope: kind, slug, ...errorContext(error) });
    return { status: "error" };
  }
}

function filtersActive(filters: CatalogFilters): boolean {
  return (
    filters.type !== null ||
    filters.sizes.length > 0 ||
    filters.colors.length > 0 ||
    filters.minPricePaise !== null ||
    filters.maxPricePaise !== null ||
    filters.availableOnly
  );
}

export const loadCatalogListing = cache(load);

/** Flatten Next's `searchParams` object to a stable string for the cached loader. */
export function searchParamsToString(raw: Record<string, string | string[] | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value)) value.forEach((entry) => params.append(key, entry));
    else if (value !== undefined) params.append(key, value);
  }
  return params.toString();
}
