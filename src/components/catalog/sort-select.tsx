"use client";

import { CATALOG_SORTS, SORT_LABELS, type CatalogSortKey } from "@/lib/catalog/constants";
import { buildCatalogHref, serializeFilters, type CatalogFilters } from "@/lib/catalog/params";
import { STOREFRONT_EVENTS, trackStorefrontEvent } from "@/lib/analytics";
import { useCatalogNav } from "./catalog-nav";

/**
 * Sort control. Works without JavaScript (a plain GET form to the same path
 * with the current filters as hidden fields) and is enhanced to navigate
 * immediately when JavaScript is available.
 */
export function SortSelect({ basePath, filters }: { basePath: string; filters: CatalogFilters }) {
  const { navigate } = useCatalogNav();
  const hidden = [...new URLSearchParams(serializeFilters({ ...filters, sort: "featured", page: 1 })).entries()];

  return (
    <form action={basePath} method="get" className="flex items-center gap-2">
      {hidden.map(([key, value]) => (
        <input key={`${key}:${value}`} type="hidden" name={key} value={value} />
      ))}
      <label htmlFor="catalog-sort" className="text-[11px] font-semibold uppercase tracking-[0.14em] text-smoke">
        Sort by
      </label>
      <select
        id="catalog-sort"
        name="sort"
        key={filters.sort}
        defaultValue={filters.sort}
        onChange={(event) => {
          const sort = event.target.value as CatalogSortKey;
          if (!CATALOG_SORTS.includes(sort)) return;
          trackStorefrontEvent({ name: STOREFRONT_EVENTS.SORT_CHANGED, consent: "analytics", payload: { sort } });
          navigate(buildCatalogHref(basePath, filters, { sort }));
        }}
        className="h-10 rounded-pill border-[1.5px] border-ink bg-paper px-4 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-flame"
      >
        {CATALOG_SORTS.map((key) => (
          <option key={key} value={key}>
            {SORT_LABELS[key]}
          </option>
        ))}
      </select>
      <noscript>
        <button type="submit" className="h-10 rounded-pill border-[1.5px] border-ink px-4 text-xs font-semibold uppercase">
          Apply
        </button>
      </noscript>
    </form>
  );
}
