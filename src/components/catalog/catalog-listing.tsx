import { ProductCard } from "@/components/ui/product-card";
import { serializeFilters, buildCatalogHref, activeFilterCount, type CatalogFilters } from "@/lib/catalog/params";
import { toProductSummary } from "@/lib/catalog/dto";
import type { ListingResult } from "@/services/catalog/listing.service";
import { ActiveFilters } from "./active-filters";
import { CategoryNavChips, CategoryNavList } from "./category-nav";
import { CatalogEmpty } from "./catalog-empty";
import { CatalogNavProvider, ResultsRegion } from "./catalog-nav";
import { CatalogPagination } from "./catalog-pagination";
import { CatalogViewTracker } from "./catalog-tracker";
import { FilterSidebar, MobileFilters } from "./filter-panel";
import { SortSelect } from "./sort-select";
import { hasVisibleFacets } from "@/lib/catalog/facets-view";

type OkListing = Extract<ListingResult, { status: "ok" }>;

function clearFiltersHref(basePath: string, filters: CatalogFilters): string {
  return buildCatalogHref(basePath, filters, {
    type: null,
    sizes: [],
    colors: [],
    minPricePaise: null,
    maxPricePaise: null,
    availableOnly: false,
  });
}

/**
 * The listing body shared by /shop, /category/[slug] and /collection/[slug].
 * A server component: only the filter panel, sort select and view tracker hydrate.
 */
export function CatalogListing({ listing, savedIds }: { listing: OkListing; savedIds: string[] }) {
  const { basePath, filters, pagination, products, facets, categoryNav, scope, scopeIsEmpty } = listing;
  const saved = new Set(savedIds);
  const filterCount = activeFilterCount(filters);
  const showFilters = hasVisibleFacets(facets) || filterCount > 0;
  const storeIsEmpty = products.length === 0 && scopeIsEmpty;

  if (storeIsEmpty) {
    return <CatalogEmpty scope={scope} scopeIsEmpty clearHref={basePath} />;
  }

  return (
    <CatalogNavProvider>
      <CatalogViewTracker
        surface={scope.kind}
        slug={scope.kind === "shop" ? null : scope.slug}
        total={pagination.total}
        page={pagination.page}
        filterCount={filterCount}
      />
      <div className="grid gap-8 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <aside aria-label="Browse and filter" className="hidden lg:block">
          {categoryNav ? <CategoryNavList nav={categoryNav} /> : null}
          {showFilters ? <FilterSidebar key={serializeFilters(filters)} basePath={basePath} filters={filters} facets={facets} /> : null}
        </aside>

        <div className="min-w-0">
          {categoryNav ? <CategoryNavChips nav={categoryNav} /> : null}

          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <p role="status" aria-live="polite" className="font-mono text-xs uppercase tracking-[0.14em] text-smoke">
              {pagination.total === 0
                ? "No products"
                : `Showing ${pagination.from}–${pagination.to} of ${pagination.total} ${pagination.total === 1 ? "product" : "products"}`}
            </p>
            <div className="flex items-center gap-3">
              {showFilters ? (
                <div className="lg:hidden">
                  <MobileFilters basePath={basePath} filters={filters} facets={facets} />
                </div>
              ) : null}
              <SortSelect basePath={basePath} filters={filters} />
            </div>
          </div>

          <ActiveFilters basePath={basePath} filters={filters} />

          <ResultsRegion>
            <h2 className="sr-only">Products</h2>
            {products.length === 0 ? (
              <CatalogEmpty scope={scope} scopeIsEmpty={scopeIsEmpty} clearHref={clearFiltersHref(basePath, filters)} />
            ) : (
              <ul className="grid grid-cols-2 gap-x-4 gap-y-8 md:grid-cols-3 md:gap-x-6 xl:grid-cols-4">
                {products.map((product, index) => (
                  <li key={product.id}>
                    <ProductCard product={toProductSummary(product)} saved={saved.has(product.id)} priority={index < 4} />
                  </li>
                ))}
              </ul>
            )}
          </ResultsRegion>

          <CatalogPagination basePath={basePath} filters={filters} pagination={pagination} />
        </div>
      </div>
    </CatalogNavProvider>
  );
}
