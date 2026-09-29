import { Pagination, PaginationContent, PaginationItem, PaginationLink, PaginationNext, PaginationPrevious } from "@/components/ui/pagination";
import { MoreHorizontal } from "lucide-react";
import { buildCatalogHref, type CatalogFilters } from "@/lib/catalog/params";
import { buildPageWindow, type PaginationMeta } from "@/lib/catalog/pagination";

/**
 * Desktop: [Prev] 1 2 3 … 10 [Next]   ·   Mobile: [Prev] Page 2 of 10 [Next]
 * Every link keeps the active filters and sort; page 1 links to the clean URL.
 * Prev/next at the ends render as disabled (aria-disabled) elements, not dead links.
 */
export function CatalogPagination({
  basePath,
  filters,
  pagination,
}: {
  basePath: string;
  filters: CatalogFilters;
  pagination: PaginationMeta;
}) {
  const { page, totalPages } = pagination;
  if (totalPages <= 1) return null;
  const hrefFor = (target: number) => buildCatalogHref(basePath, filters, { page: target }, { resetPage: false });
  const hasPrev = page > 1;
  const hasNext = page < totalPages;

  return (
    <Pagination aria-label="Product pages" className="mt-10">
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious
            href={hasPrev ? hrefFor(page - 1) : undefined}
            disabled={!hasPrev}
            rel={hasPrev ? "prev" : undefined}
            data-track="PAGINATION_CLICKED"
            data-track-id={hasPrev ? String(page - 1) : undefined}
          />
        </PaginationItem>

        {/* Mobile */}
        <PaginationItem className="sm:hidden">
          <span className="px-3 font-mono text-xs" aria-current="page">
            Page {page} of {totalPages}
          </span>
        </PaginationItem>

        {/* Desktop */}
        {buildPageWindow(page, totalPages).map((item) =>
          typeof item === "number" ? (
            <PaginationItem key={item} className="hidden sm:block">
              <PaginationLink
                href={hrefFor(item)}
                isActive={item === page}
                aria-label={item === page ? `Page ${item}, current page` : `Go to page ${item}`}
                data-track="PAGINATION_CLICKED"
                data-track-id={String(item)}
              >
                {item}
              </PaginationLink>
            </PaginationItem>
          ) : (
            <PaginationItem key={item} className="hidden sm:block">
              <span aria-hidden className="flex size-10 items-center justify-center text-smoke">
                <MoreHorizontal className="size-4" />
              </span>
            </PaginationItem>
          ),
        )}

        <PaginationItem>
          <PaginationNext
            href={hasNext ? hrefFor(page + 1) : undefined}
            disabled={!hasNext}
            rel={hasNext ? "next" : undefined}
            data-track="PAGINATION_CLICKED"
            data-track-id={hasNext ? String(page + 1) : undefined}
          />
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}
