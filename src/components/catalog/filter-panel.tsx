"use client";

import Link from "next/link";
import { SlidersHorizontal } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { STOREFRONT_EVENTS, trackStorefrontEvent } from "@/lib/analytics";
import { PRODUCT_TYPE_SLUGS, type ProductTypeSlug } from "@/lib/catalog/constants";
import type { FacetOptionView, FacetView } from "@/lib/catalog/facets-view";
import {
  activeFilterCount,
  buildCatalogHref,
  paiseToParam,
  parsePriceParam,
  type CatalogFilters,
} from "@/lib/catalog/params";
import { typeToSlug } from "@/lib/catalog/constants";
import { useCatalogNav } from "./catalog-nav";

/**
 * Filter controls. One state model, two presentations:
 *  - desktop sidebar: applies as soon as a control changes ("instant")
 *  - mobile bottom sheet: edits a draft, applied with [Apply Filters]
 * Either way the result is a URL — the server re-validates and renders.
 */

interface Draft {
  type: ProductTypeSlug | "";
  sizes: string[];
  colors: string[];
  min: string;
  max: string;
  availableOnly: boolean;
}

function toDraft(filters: CatalogFilters): Draft {
  return {
    type: filters.type ? typeToSlug(filters.type) : "",
    sizes: filters.sizes,
    colors: filters.colors,
    min: filters.minPricePaise !== null ? paiseToParam(filters.minPricePaise) : "",
    max: filters.maxPricePaise !== null ? paiseToParam(filters.maxPricePaise) : "",
    availableOnly: filters.availableOnly,
  };
}

function priceError(value: string): boolean {
  return value.trim() !== "" && parsePriceParam(value) === null;
}

function toPatch(draft: Draft): Partial<CatalogFilters> {
  let min = parsePriceParam(draft.min);
  let max = parsePriceParam(draft.max);
  if (min !== null && max !== null && min > max) [min, max] = [max, min];
  return {
    type: draft.type ? PRODUCT_TYPE_SLUGS[draft.type] : null,
    sizes: draft.sizes,
    colors: draft.colors,
    minPricePaise: min,
    maxPricePaise: max,
    availableOnly: draft.availableOnly,
  };
}

function useFilterState(basePath: string, applied: CatalogFilters, instant: boolean, onApplied?: () => void) {
  const { navigate } = useCatalogNav();
  const [draft, setDraft] = useState<Draft>(() => toDraft(applied));

  function commit(next: Draft) {
    // Never navigate on an unparseable price; the field shows its own error.
    if (priceError(next.min) || priceError(next.max)) return;
    const patch = toPatch(next);
    navigate(buildCatalogHref(basePath, applied, patch));
    const count = activeFilterCount({ ...applied, ...patch });
    trackStorefrontEvent({
      name: count === 0 ? STOREFRONT_EVENTS.FILTER_CLEARED : STOREFRONT_EVENTS.FILTER_APPLIED,
      consent: "analytics",
      payload: {
        count,
        type: next.type || null,
        sizes: next.sizes.join(","),
        colors: next.colors.join(","),
        price: Boolean(patch.minPricePaise !== null || patch.maxPricePaise !== null),
        availableOnly: next.availableOnly,
      },
    });
    onApplied?.();
  }

  function update(patch: Partial<Draft>, options: { apply?: boolean } = {}) {
    const next = { ...draft, ...patch };
    setDraft(next);
    if (instant && options.apply !== false) commit(next);
  }

  function clear() {
    const empty: Draft = { type: "", sizes: [], colors: [], min: "", max: "", availableOnly: false };
    setDraft(empty);
    commit(empty);
  }

  return { draft, update, commit: () => commit(draft), clear };
}

function toggle(list: string[], value: string, on: boolean): string[] {
  return on ? [...new Set([...list, value])] : list.filter((entry) => entry !== value);
}

function Group({ legend, children }: { legend: string; children: React.ReactNode }) {
  return (
    <fieldset className="border-t border-clay pt-4">
      <legend className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-ink">{legend}</legend>
      {children}
    </fieldset>
  );
}

function OptionRow({
  id,
  option,
  checked,
  onChange,
}: {
  id: string;
  option: FacetOptionView;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <li className="flex min-h-9 items-center gap-3">
      <Checkbox id={id} checked={checked} onCheckedChange={(value) => onChange(value === true)} />
      <Label htmlFor={id} className="flex flex-1 cursor-pointer items-center gap-2 text-sm normal-case tracking-normal text-ink">
        {option.swatch ? (
          <span aria-hidden className="size-3.5 rounded-full border border-ink/40" style={{ backgroundColor: option.swatch }} />
        ) : null}
        <span>{option.label}</span>
        {option.count > 0 ? <span className="ml-auto font-mono text-[11px] text-smoke">{option.count}</span> : null}
      </Label>
    </li>
  );
}

function FilterFields({
  idPrefix,
  facets,
  state,
  instant,
}: {
  idPrefix: string;
  facets: FacetView;
  state: ReturnType<typeof useFilterState>;
  instant: boolean;
}) {
  const { draft, update } = state;
  const minInvalid = priceError(draft.min);
  const maxInvalid = priceError(draft.max);

  return (
    <div className="space-y-5">
      {facets.types.length > 0 ? (
        <Group legend="Product type">
          <RadioGroup
            value={draft.type || "all"}
            onValueChange={(value) => update({ type: value === "all" ? "" : (value as Draft["type"]) })}
            aria-label="Product type"
            className="gap-1"
          >
            {[{ value: "all", label: "All types", count: 0 } as FacetOptionView, ...facets.types].map((option) => (
              <div key={option.value} className="flex min-h-9 items-center gap-3">
                <RadioGroupItem value={option.value} id={`${idPrefix}-type-${option.value}`} />
                <Label
                  htmlFor={`${idPrefix}-type-${option.value}`}
                  className="flex flex-1 cursor-pointer items-center text-sm normal-case tracking-normal text-ink"
                >
                  {option.label}
                  {option.count > 0 ? <span className="ml-auto font-mono text-[11px] text-smoke">{option.count}</span> : null}
                </Label>
              </div>
            ))}
          </RadioGroup>
        </Group>
      ) : null}

      {facets.price ? (
        <Group legend="Price (₹)">
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <Label htmlFor={`${idPrefix}-min`} className="sr-only">
                Minimum price in rupees
              </Label>
              <Input
                id={`${idPrefix}-min`}
                inputSize="sm"
                inputMode="decimal"
                autoComplete="off"
                placeholder={facets.price.minLabel ? `Min ${facets.price.minLabel}` : "Min"}
                value={draft.min}
                invalid={minInvalid}
                aria-describedby={minInvalid || maxInvalid ? `${idPrefix}-price-error` : undefined}
                onChange={(event) => update({ min: event.target.value }, { apply: false })}
                onBlur={() => instant && !minInvalid && !maxInvalid && state.commit()}
              />
            </div>
            <span aria-hidden className="text-smoke">
              —
            </span>
            <div className="flex-1">
              <Label htmlFor={`${idPrefix}-max`} className="sr-only">
                Maximum price in rupees
              </Label>
              <Input
                id={`${idPrefix}-max`}
                inputSize="sm"
                inputMode="decimal"
                autoComplete="off"
                placeholder={facets.price.maxLabel ? `Max ${facets.price.maxLabel}` : "Max"}
                value={draft.max}
                invalid={maxInvalid}
                aria-describedby={minInvalid || maxInvalid ? `${idPrefix}-price-error` : undefined}
                onChange={(event) => update({ max: event.target.value }, { apply: false })}
                onBlur={() => instant && !minInvalid && !maxInvalid && state.commit()}
              />
            </div>
          </div>
          {minInvalid || maxInvalid ? (
            <p id={`${idPrefix}-price-error`} role="alert" className="mt-2 text-xs text-danger">
              Enter a price like 500 or 1999.50.
            </p>
          ) : null}
        </Group>
      ) : null}

      {facets.sizes.length > 0 ? (
        <Group legend="Size">
          <ul className="grid grid-cols-2 gap-x-3">
            {facets.sizes.map((option) => (
              <OptionRow
                key={option.value}
                id={`${idPrefix}-size-${option.value}`}
                option={option}
                checked={draft.sizes.includes(option.value)}
                onChange={(checked) => update({ sizes: toggle(draft.sizes, option.value, checked) })}
              />
            ))}
          </ul>
        </Group>
      ) : null}

      {facets.colors.length > 0 ? (
        <Group legend="Color">
          <ul>
            {facets.colors.map((option) => (
              <OptionRow
                key={option.value}
                id={`${idPrefix}-color-${option.value.replace(/[^a-z0-9]+/g, "-")}`}
                option={option}
                checked={draft.colors.includes(option.value)}
                onChange={(checked) => update({ colors: toggle(draft.colors, option.value, checked) })}
              />
            ))}
          </ul>
        </Group>
      ) : null}

      {facets.availability ? (
        <Group legend="Availability">
          <ul>
            <OptionRow
              id={`${idPrefix}-available`}
              option={{ value: "available", label: "Available to order", count: 0 }}
              checked={draft.availableOnly}
              onChange={(checked) => update({ availableOnly: checked })}
            />
          </ul>
        </Group>
      ) : null}
    </div>
  );
}

/** Desktop panel. Remount (via `key`) whenever the URL changes so it always mirrors it. */
export function FilterSidebar({
  basePath,
  filters,
  facets,
}: {
  basePath: string;
  filters: CatalogFilters;
  facets: FacetView;
}) {
  const state = useFilterState(basePath, filters, true);
  const idPrefix = useId();
  const active = activeFilterCount(filters);
  return (
    <form
      aria-label="Filter products"
      onSubmit={(event) => {
        event.preventDefault();
        state.commit();
      }}
    >
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-display text-lg font-extrabold uppercase">Filters</h2>
        {active > 0 ? (
          <Link
            href={buildCatalogHref(basePath, filters, {
              type: null,
              sizes: [],
              colors: [],
              minPricePaise: null,
              maxPricePaise: null,
              availableOnly: false,
            })}
            data-track="FILTER_CLEARED"
            className="text-xs font-semibold uppercase tracking-[0.14em] underline decoration-flame decoration-2 underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-flame"
          >
            Clear all
          </Link>
        ) : null}
      </div>
      <FilterFields idPrefix={`d${idPrefix}`} facets={facets} state={state} instant />
      <button type="submit" className="sr-only">
        Apply price
      </button>
    </form>
  );
}

/** Mobile/tablet bottom sheet. Draft state; nothing changes until Apply. */
export function MobileFilters({
  basePath,
  filters,
  facets,
}: {
  basePath: string;
  filters: CatalogFilters;
  facets: FacetView;
}) {
  const [open, setOpen] = useState(false);
  const active = activeFilterCount(filters);
  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <Button variant="outline" size="sm" aria-label={active ? `Filters, ${active} applied` : "Filters"}>
          <SlidersHorizontal className="size-3.5" aria-hidden />
          Filters
          {active > 0 ? (
            <span aria-hidden className="ml-1 rounded-pill bg-flame px-1.5 py-0.5 text-[10px] text-on-accent">
              {active}
            </span>
          ) : null}
        </Button>
      </DrawerTrigger>
      <DrawerContent side="bottom" className="flex max-h-[88vh] flex-col p-0">
        <MobileFilterBody basePath={basePath} filters={filters} facets={facets} close={() => setOpen(false)} />
      </DrawerContent>
    </Drawer>
  );
}

function MobileFilterBody({
  basePath,
  filters,
  facets,
  close,
}: {
  basePath: string;
  filters: CatalogFilters;
  facets: FacetView;
  close: () => void;
}) {
  const state = useFilterState(basePath, filters, false, close);
  const idPrefix = useId();
  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        state.commit();
      }}
    >
      <div className="px-6 pb-3 pt-6">
        <DrawerTitle className="text-xl">Filters</DrawerTitle>
        <DrawerDescription className="mt-1">Choose options, then apply. Results update the page address.</DrawerDescription>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4">
        <FilterFields idPrefix={`m${idPrefix}`} facets={facets} state={state} instant={false} />
      </div>
      <div className="flex gap-3 border-t border-clay bg-paper px-6 py-4">
        <Button type="button" variant="outline" className="flex-1" onClick={state.clear}>
          Clear All
        </Button>
        <Button type="submit" className="flex-1">
          Apply Filters
        </Button>
      </div>
    </form>
  );
}
