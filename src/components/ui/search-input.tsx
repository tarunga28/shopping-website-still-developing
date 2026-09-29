"use client";

import { Search, X } from "lucide-react";
import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export interface SearchInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "onChange"> {
  value: string;
  onValueChange: (value: string) => void;
  invalid?: boolean;
}

/** Search input with leading icon and clear action. */
export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(
  ({ className, value, onValueChange, placeholder = "Search…", ...props }, ref) => (
    <div className={cn("relative w-full", className)}>
      <Search
        className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-smoke"
        aria-hidden
      />
      <input
        ref={ref}
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onValueChange(event.target.value)}
        className={cn(
          "h-11 w-full rounded-pill border-[1.5px] border-clay bg-white/60 pl-11 pr-10 text-sm text-ink",
          "placeholder:text-smoke/70 transition-colors hover:border-smoke",
          "focus:border-ink focus:outline-2 focus:outline-offset-2 focus:outline-flame",
          "[&::-webkit-search-cancel-button]:hidden",
          props.invalid && "border-danger focus:outline-danger",
          props.disabled && "cursor-not-allowed opacity-50",
        )}
        {...props}
      />
      {value ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onValueChange("")}
          className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 text-smoke transition-colors hover:bg-sand hover:text-ink"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      ) : null}
    </div>
  ),
);
SearchInput.displayName = "SearchInput";
