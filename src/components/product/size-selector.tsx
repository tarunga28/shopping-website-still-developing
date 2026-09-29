"use client";

import type { ReactNode } from "react";
import type { PdpSizeOption } from "@/lib/catalog/pdp-dto";
import { isSelectable, type OptionState } from "@/lib/catalog/variant-selection";
import { cn } from "@/lib/utils";

/**
 * Reusable size picker. Only sizes that this product actually has are
 * rendered (a mug never shows XS–XXL), and a size the current colour lacks
 * or has run out of is disabled and cannot be chosen.
 */
export function SizeSelector({
  name = "size",
  sizes,
  selected,
  stateOf,
  onSelect,
  action,
}: {
  name?: string;
  sizes: readonly PdpSizeOption[];
  selected: string | null;
  stateOf: (key: string) => OptionState;
  onSelect: (key: string) => void;
  /** Slot for the size-guide button, aligned with the legend. */
  action?: ReactNode;
}) {
  const selectedLabel = sizes.find((size) => size.key === selected)?.label;
  return (
    <fieldset className="min-w-0">
      <legend className="float-left mb-3 max-w-full font-mono text-[10px] uppercase tracking-[0.18em] text-smoke">
        Size{selectedLabel ? <span className="ml-2 break-words font-semibold text-ink">{selectedLabel}</span> : null}
      </legend>
      {action ? <div className="float-right mb-3">{action}</div> : null}
      <div className="clear-both flex flex-wrap gap-2">
        {sizes.map((size) => {
          const state = stateOf(size.key);
          const disabled = !isSelectable(state);
          return (
            <label
              key={size.key}
              className={cn("relative inline-flex", disabled ? "cursor-not-allowed" : "cursor-pointer")}
            >
              <input
                type="radio"
                name={name}
                value={size.key}
                checked={size.key === selected}
                disabled={disabled}
                onChange={() => { if (!disabled) onSelect(size.key); }}
                aria-label={`Select size ${size.label}${disabled ? " (unavailable)" : ""}`}
                className="peer sr-only"
              />
              <span
                aria-hidden
                className={cn(
                  "flex h-11 min-w-12 items-center justify-center rounded-pill border-[1.5px] border-clay bg-white/60 px-4 text-xs font-semibold uppercase tracking-[0.08em] transition-colors",
                  "hover:border-ink peer-checked:border-ink peer-checked:bg-ink peer-checked:text-paper",
                  "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-flame",
                  disabled && "border-dashed text-smoke/60 line-through opacity-60 hover:border-clay",
                )}
              >
                {size.label}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
