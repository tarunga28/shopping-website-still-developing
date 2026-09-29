"use client";

import type { PdpColorOption } from "@/lib/catalog/pdp-dto";
import { isSelectable, type OptionState } from "@/lib/catalog/variant-selection";
import { cn } from "@/lib/utils";

/**
 * Reusable colour picker. The swatch colour is the hex that came from the
 * colour system on the server (validated `#rrggbb`); nothing here accepts a
 * colour from the URL or the user. Selection is a native radio group, so
 * arrow keys, focus and screen readers work without custom key handling.
 */
export function ColorSelector({
  name = "color",
  colors,
  selected,
  stateOf,
  onSelect,
}: {
  name?: string;
  colors: readonly PdpColorOption[];
  selected: string | null;
  stateOf: (key: string) => OptionState;
  onSelect: (key: string) => void;
}) {
  const selectedLabel = colors.find((color) => color.key === selected)?.label;
  return (
    <fieldset className="min-w-0">
      <legend className="mb-3 max-w-full font-mono text-[10px] uppercase tracking-[0.18em] text-smoke">
        Color{selectedLabel ? <span className="ml-2 break-words font-semibold text-ink">{selectedLabel}</span> : null}
      </legend>
      <div className="flex flex-wrap gap-3">
        {colors.map((color) => {
          const state = stateOf(color.key);
          const disabled = !isSelectable(state);
          const checked = color.key === selected;
          const label = color.label.toLowerCase();
          return (
            <label
              key={color.key}
              title={disabled ? `${color.label} – unavailable` : color.label}
              className={cn("relative inline-flex", disabled ? "cursor-not-allowed" : "cursor-pointer")}
            >
              <input
                type="radio"
                name={name}
                value={color.key}
                checked={checked}
                disabled={disabled}
                onChange={() => { if (!disabled) onSelect(color.key); }}
                aria-label={`Select ${label} color${disabled ? " (unavailable)" : ""}`}
                className="peer sr-only"
              />
              <span
                aria-hidden
                className={cn(
                  "relative flex size-11 items-center justify-center rounded-full border-[1.5px] border-clay p-1 transition-all",
                  "peer-checked:border-ink peer-checked:ring-2 peer-checked:ring-ink peer-checked:ring-offset-2",
                  "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4 peer-focus-visible:outline-flame",
                  disabled && "opacity-45",
                )}
              >
                <span
                  className="size-full rounded-full border border-ink/15"
                  style={color.hex ? { backgroundColor: color.hex } : undefined}
                >
                  {color.hex ? null : (
                    <span className="flex size-full items-center justify-center bg-sand text-[11px] font-semibold uppercase text-ink">
                      {color.label.slice(0, 1)}
                    </span>
                  )}
                </span>
                {disabled ? (
                  <span className="absolute inset-1 rounded-full bg-[linear-gradient(135deg,transparent_46%,var(--color-ink)_46%,var(--color-ink)_54%,transparent_54%)]" />
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
