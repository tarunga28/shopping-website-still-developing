import Link from "next/link";
import { X } from "lucide-react";
import { PRODUCT_TYPE_LABELS, typeToSlug } from "@/lib/catalog/constants";
import { activeFilterCount, buildCatalogHref, paiseToParam, type CatalogFilters } from "@/lib/catalog/params";

interface Chip {
  key: string;
  label: string;
  href: string;
}

const chipClass =
  "inline-flex min-h-8 items-center gap-1.5 rounded-pill border-[1.5px] border-ink bg-paper px-3 text-xs font-medium transition-colors hover:bg-ink hover:text-paper focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-flame";

/** Removable chips for every applied filter. Plain links: work without JS and are crawl-inert (noindex pages). */
export function ActiveFilters({ basePath, filters }: { basePath: string; filters: CatalogFilters }) {
  if (activeFilterCount(filters) === 0) return null;
  const chips: Chip[] = [];
  const remove = (patch: Partial<CatalogFilters>) => buildCatalogHref(basePath, filters, patch);

  if (filters.type) {
    chips.push({
      key: `type-${typeToSlug(filters.type)}`,
      label: PRODUCT_TYPE_LABELS[filters.type] ?? filters.type,
      href: remove({ type: null }),
    });
  }
  for (const size of filters.sizes) {
    chips.push({ key: `size-${size}`, label: `Size ${size}`, href: remove({ sizes: filters.sizes.filter((entry) => entry !== size) }) });
  }
  for (const color of filters.colors) {
    chips.push({ key: `color-${color}`, label: color, href: remove({ colors: filters.colors.filter((entry) => entry !== color) }) });
  }
  if (filters.minPricePaise !== null || filters.maxPricePaise !== null) {
    const min = filters.minPricePaise !== null ? `₹${paiseToParam(filters.minPricePaise)}` : null;
    const max = filters.maxPricePaise !== null ? `₹${paiseToParam(filters.maxPricePaise)}` : null;
    const label = min && max ? `${min} – ${max}` : min ? `From ${min}` : `Up to ${max}`;
    chips.push({ key: "price", label, href: remove({ minPricePaise: null, maxPricePaise: null }) });
  }
  if (filters.availableOnly) chips.push({ key: "available", label: "Available to order", href: remove({ availableOnly: false }) });

  const clearAll = remove({
    type: null,
    sizes: [],
    colors: [],
    minPricePaise: null,
    maxPricePaise: null,
    availableOnly: false,
  });

  return (
    <nav aria-label="Applied filters" className="mb-5">
      <ul className="flex flex-wrap items-center gap-2">
        {chips.map((chip) => (
          <li key={chip.key}>
            <Link href={chip.href} className={chipClass} data-track="FILTER_CLEARED" aria-label={`Remove filter: ${chip.label}`}>
              {chip.label}
              <X className="size-3" aria-hidden />
            </Link>
          </li>
        ))}
        <li>
          <Link
            href={clearAll}
            data-track="FILTER_CLEARED"
            className="px-2 text-xs font-semibold uppercase tracking-[0.14em] underline decoration-flame decoration-2 underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-flame"
          >
            Clear all
          </Link>
        </li>
      </ul>
    </nav>
  );
}
