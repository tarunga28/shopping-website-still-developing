"use client";

import { LayoutGrid, List, SlidersHorizontal } from "lucide-react";
import { useMemo, useState } from "react";
import { FilterDrawer } from "@/components/catalog/filter-drawer";
import { Button } from "@/components/ui/button";
import { EmptySearch } from "@/components/ui/empty-state";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { ProductCard } from "@/components/ui/product-card";
import { ProductGridSkeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { ProductSummary } from "@/types";

export type SortKey = "featured" | "price-asc" | "price-desc" | "name" | "newest";

const sortLabels: Record<SortKey, string> = {
  featured: "Featured",
  "price-asc": "Price: low to high",
  "price-desc": "Price: high to low",
  name: "Name A–Z",
  newest: "Newest first",
};

function sortProducts(products: ProductSummary[], sort: SortKey): ProductSummary[] {
  const copy = [...products];
  switch (sort) {
    case "price-asc":
      return copy.sort((a, b) => a.pricePaise - b.pricePaise);
    case "price-desc":
      return copy.sort((a, b) => b.pricePaise - a.pricePaise);
    case "name":
      return copy.sort((a, b) => a.title.localeCompare(b.title));
    case "newest":
      return copy.sort((a, b) => (a.badge === "NEW" ? -1 : 0) - (b.badge === "NEW" ? -1 : 0));
    default:
      return copy;
  }
}

export interface ProductListingProps {
  products: ProductSummary[];
  title?: string;
  /** Show a brief skeleton while switching density — mirrors future fetch. */
  loading?: boolean;
}

/**
 * Reusable product listing chrome: toolbar (filters, sort, view toggle,
 * count), grid/list rendering, empty state and pagination.
 * Sorting works on the provided data; filtering activates with the
 * catalog database milestone.
 */
export function ProductListing({ products, title = "All products", loading = false }: ProductListingProps) {
  const [sort, setSort] = useState<SortKey>("featured");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [page] = useState(1);

  const sorted = useMemo(() => sortProducts(products, sort), [products, sort]);
  const pageSize = 12;
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));

  if (loading) {
    return <ProductGridSkeleton count={8} />;
  }

  return (
    <div className="space-y-8">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-y-[1.5px] border-ink py-3">
        <div className="flex items-center gap-3">
          <FilterDrawer
            trigger={
              <Button variant="outline" size="sm">
                <SlidersHorizontal className="size-3.5" aria-hidden />
                Filters
              </Button>
            }
          />
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-smoke" role="status">
            {sorted.length} {sorted.length === 1 ? "product" : "products"}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Select value={sort} onValueChange={(value) => setSort(value as SortKey)}>
            <SelectTrigger aria-label="Sort products" className="h-9 w-44 rounded-pill text-xs">
              <SelectValue placeholder="Sort" />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(sortLabels) as SortKey[]).map((key) => (
                <SelectItem key={key} value={key}>
                  {sortLabels[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div role="group" aria-label="Change layout" className="flex rounded-pill border-[1.5px] border-ink">
            {(
              [
                { key: "grid", icon: LayoutGrid, label: "Grid view" },
                { key: "list", icon: List, label: "List view" },
              ] as const
            ).map(({ key, icon: Icon, label }) => (
              <button
                key={key}
                type="button"
                aria-label={label}
                aria-pressed={view === key}
                onClick={() => setView(key)}
                className={cn(
                  "flex h-9 w-9 items-center justify-center transition-colors first:rounded-l-pill last:rounded-r-pill",
                  view === key ? "bg-ink text-paper" : "text-smoke hover:text-ink",
                )}
              >
                <Icon className="size-4" aria-hidden />
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Results */}
      {sorted.length === 0 ? (
        <EmptySearch />
      ) : (
        <div
          className={cn(
            view === "grid"
              ? "grid grid-cols-2 gap-x-3 gap-y-8 sm:gap-x-5 lg:grid-cols-3 xl:grid-cols-4"
              : "flex flex-col gap-8",
          )}
        >
          {sorted.map((product, index) => (
            <ProductCard key={product.id} product={product} layout={view} priority={index < 4} />
          ))}
        </div>
      )}

      {/* Pagination structure (single preview page today; real paging
          lands with the catalog database) */}
      <Pagination aria-label="Product pages" className="pt-4">
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious href="#" aria-disabled={page === 1} className={page === 1 ? "pointer-events-none opacity-40" : undefined} />
          </PaginationItem>
          {Array.from({ length: totalPages }, (_, i) => (
            <PaginationItem key={i}>
              <PaginationLink href="#" isActive={page === i + 1}>
                {i + 1}
              </PaginationLink>
            </PaginationItem>
          ))}
          <PaginationItem>
            <PaginationNext href="#" aria-disabled={page === totalPages} className={page === totalPages ? "pointer-events-none opacity-40" : undefined} />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  );
}
