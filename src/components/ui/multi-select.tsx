"use client";

import { Check, ChevronDown, X } from "lucide-react";
import { useId, useState } from "react";
import { cn } from "@/lib/utils";

export interface MultiSelectOption {
  value: string;
  label: string;
}

export interface MultiSelectProps {
  id?: string;
  options: MultiSelectOption[];
  value: string[];
  onValueChange: (value: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  className?: string;
}

/**
 * Lightweight multi-select built from a disclosure + listbox semantics.
 * Chosen deliberately over a heavy combobox dependency.
 */
export function MultiSelect({
  id,
  options,
  value,
  onValueChange,
  placeholder = "Select…",
  disabled = false,
  invalid = false,
  className,
}: MultiSelectProps) {
  const listId = useId();
  const [open, setOpen] = useState(false);

  const toggle = (optionValue: string) =>
    onValueChange(
      value.includes(optionValue)
        ? value.filter((entry) => entry !== optionValue)
        : [...value, optionValue],
    );

  const selectedLabels = options.filter((option) => value.includes(option.value)).map((o) => o.label);

  return (
    <div className={cn("relative w-full", className)}>
      <button
        type="button"
        id={id}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-invalid={invalid || undefined}
        onClick={() => setOpen((previous) => !previous)}
        className={cn(
          "flex min-h-11 w-full items-center justify-between gap-2 rounded-pill border-[1.5px] border-clay bg-white/60 px-5 py-2 text-left text-sm",
          "transition-colors hover:border-smoke focus:border-ink focus:outline-2 focus:outline-offset-2 focus:outline-flame",
          "disabled:cursor-not-allowed disabled:opacity-50",
          invalid && "border-danger",
        )}
      >
        <span className={cn("flex flex-wrap gap-1.5", selectedLabels.length === 0 && "text-smoke/70")}>
          {selectedLabels.length === 0
            ? placeholder
            : selectedLabels.map((label) => (
                <span
                  key={label}
                  className="inline-flex items-center gap-1 rounded-pill bg-sand px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink"
                >
                  {label}
                  <span
                    role="button"
                    tabIndex={-1}
                    aria-label={`Remove ${label}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      const option = options.find((entry) => entry.label === label);
                      if (option) toggle(option.value);
                    }}
                    className="rounded-full p-0.5 hover:bg-ink hover:text-paper"
                  >
                    <X className="size-2.5" aria-hidden />
                  </span>
                </span>
              ))}
        </span>
        <ChevronDown className={cn("size-4 shrink-0 text-smoke transition-transform", open && "rotate-180")} aria-hidden />
      </button>

      {open ? (
        <>
          <div className="fixed inset-0 z-[60]" aria-hidden onClick={() => setOpen(false)} />
          <ul
            id={listId}
            role="listbox"
            aria-multiselectable
            className="absolute z-[70] mt-2 max-h-60 w-full overflow-auto rounded-image border-[1.5px] border-ink bg-paper p-1.5 shadow-hard-sm"
          >
            {options.map((option) => {
              const selected = value.includes(option.value);
              return (
                <li
                  key={option.value}
                  role="option"
                  aria-selected={selected}
                  onClick={() => toggle(option.value)}
                  className={cn(
                    "flex cursor-pointer items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-sm transition-colors",
                    "hover:bg-sand",
                    selected && "font-semibold",
                  )}
                >
                  {option.label}
                  {selected ? <Check className="size-4 text-flame" aria-hidden /> : null}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </div>
  );
}
