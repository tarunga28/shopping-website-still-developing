"use client";

import { Minus, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

export interface NumberInputProps {
  value: number;
  onValueChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  invalid?: boolean;
  id?: string;
  "aria-label"?: string;
  className?: string;
}

/** Stepper input used for quantities (cart, order forms). */
export function NumberInput({
  value,
  onValueChange,
  min = 0,
  max = 99,
  step = 1,
  disabled = false,
  invalid = false,
  id,
  className,
  "aria-label": ariaLabel = "Quantity",
}: NumberInputProps) {
  const clamp = (next: number) => Math.min(max, Math.max(min, next));

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex h-11 items-center rounded-pill border-[1.5px] border-clay bg-white/60",
        invalid && "border-danger",
        className,
      )}
    >
      <button
        type="button"
        aria-label="Decrease"
        disabled={disabled || value <= min}
        onClick={() => onValueChange(clamp(value - step))}
        className="flex h-full w-10 items-center justify-center rounded-l-pill text-smoke transition-colors hover:bg-sand hover:text-ink disabled:pointer-events-none disabled:opacity-40"
      >
        <Minus className="size-4" aria-hidden />
      </button>
      <input
        id={id}
        type="text"
        inputMode="numeric"
        aria-invalid={invalid || undefined}
        disabled={disabled}
        value={value}
        onChange={(event) => {
          const parsed = Number.parseInt(event.target.value.replace(/\D/g, ""), 10);
          if (!Number.isNaN(parsed)) onValueChange(clamp(parsed));
        }}
        className="h-full w-10 border-0 bg-transparent text-center text-sm font-semibold outline-none disabled:opacity-50"
      />
      <button
        type="button"
        aria-label="Increase"
        disabled={disabled || value >= max}
        onClick={() => onValueChange(clamp(value + step))}
        className="flex h-full w-10 items-center justify-center rounded-r-pill text-smoke transition-colors hover:bg-sand hover:text-ink disabled:pointer-events-none disabled:opacity-40"
      >
        <Plus className="size-4" aria-hidden />
      </button>
    </div>
  );
}
