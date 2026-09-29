"use client";

import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

export interface DateInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  invalid?: boolean;
}

/**
 * Date input — styled native date control (reliable, locale-correct,
 * keyboard accessible). A full calendar picker can slot in later only if
 * a flow truly needs it.
 */
export const DateInput = forwardRef<HTMLInputElement, DateInputProps>(
  ({ className, ...props }, ref) => (
    <Input
      ref={ref}
      type="date"
      className={cn("[color-scheme:inherit]", className)}
      {...props}
    />
  ),
);
DateInput.displayName = "DateInput";
