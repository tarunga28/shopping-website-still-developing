"use client";

import { NumberInput } from "@/components/ui/number-input";

/**
 * Quantity selector — branded wrapper over the stepper primitive so
 * commerce surfaces stay consistent (min 1, generous max).
 */
export function QuantitySelector({
  value,
  onValueChange,
  max = 10,
  disabled,
  id,
}: {
  value: number;
  onValueChange: (value: number) => void;
  max?: number;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <NumberInput
      id={id}
      aria-label="Select quantity"
      value={value}
      onValueChange={onValueChange}
      min={1}
      max={max}
      disabled={disabled}
    />
  );
}
