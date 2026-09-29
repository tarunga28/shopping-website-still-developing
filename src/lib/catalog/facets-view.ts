import type { CatalogProductType } from "@/lib/catalog-rules";
import { PRODUCT_TYPE_LABELS, typeToSlug } from "./constants";
import type { CatalogFilters } from "./params";
import { paiseToParam } from "./params";

/** Structural mirror of the service's facet result (kept here so client code stays server-free). */
export interface RawFacets {
  types: { value: string; count: number }[];
  sizes: { value: string; label: string; count: number }[];
  colors: { value: string; label: string; count: number; swatch?: string | null }[];
  price: { minPaise: number; maxPaise: number } | null;
  availability: { available: number; total: number };
}

export interface FacetOptionView {
  value: string;
  label: string;
  count: number;
  swatch?: string | null;
}

/** What the filter UI renders. Only relevant groups are present. */
export interface FacetView {
  types: FacetOptionView[];
  sizes: FacetOptionView[];
  colors: FacetOptionView[];
  price: { minLabel: string; maxLabel: string } | null;
  availability: boolean;
}

export const NO_FACETS: FacetView = { types: [], sizes: [], colors: [], price: null, availability: false };

/**
 * Decide which filter groups are worth showing for the current listing.
 * A group with nothing to choose between (a single size, one colour, one type,
 * no price spread) is hidden — unless the customer already selected a value,
 * in which case it must stay visible so they can undo it.
 */
export function buildFacetView(facets: RawFacets, filters: CatalogFilters): FacetView {
  const withSelected = (
    options: FacetOptionView[],
    selected: string[],
    labelFor: (value: string) => string,
  ): FacetOptionView[] => {
    const have = new Set(options.map((option) => option.value));
    const extra = selected.filter((value) => !have.has(value)).map((value) => ({ value, label: labelFor(value), count: 0 }));
    return [...options, ...extra];
  };

  const typeOptions = withSelected(
    facets.types.map((type) => ({
      value: typeToSlug(type.value as CatalogProductType),
      label: PRODUCT_TYPE_LABELS[type.value as CatalogProductType] ?? type.value,
      count: type.count,
    })),
    filters.type ? [typeToSlug(filters.type)] : [],
    (value) => value,
  );
  const sizeOptions = withSelected(
    facets.sizes.map((size) => ({ value: size.value, label: size.label, count: size.count })),
    filters.sizes,
    (value) => value,
  );
  const colorOptions = withSelected(
    facets.colors.map((color) => ({ value: color.value, label: color.label, count: color.count, swatch: color.swatch })),
    filters.colors,
    (value) => value.replace(/\b\w/g, (letter) => letter.toUpperCase()),
  );

  const priceSelected = filters.minPricePaise !== null || filters.maxPricePaise !== null;
  const spread = facets.price && facets.price.maxPaise > facets.price.minPaise;

  return {
    types: typeOptions.length > 1 || filters.type ? typeOptions : [],
    sizes: sizeOptions.length > 1 || filters.sizes.length ? sizeOptions : [],
    colors: colorOptions.length > 1 || filters.colors.length ? colorOptions : [],
    price:
      facets.price && (spread || priceSelected)
        ? { minLabel: paiseToParam(facets.price.minPaise), maxLabel: paiseToParam(facets.price.maxPaise) }
        : priceSelected
          ? { minLabel: "", maxLabel: "" }
          : null,
    availability:
      filters.availableOnly ||
      (facets.availability.available > 0 && facets.availability.available < facets.availability.total),
  };
}

export function hasVisibleFacets(view: FacetView): boolean {
  return (
    view.types.length > 0 ||
    view.sizes.length > 0 ||
    view.colors.length > 0 ||
    view.price !== null ||
    view.availability
  );
}
