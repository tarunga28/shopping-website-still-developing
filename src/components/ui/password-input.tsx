"use client";

import { Eye, EyeOff } from "lucide-react";
import { forwardRef, useState, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export interface PasswordInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  invalid?: boolean;
}

/** Password input with accessible visibility toggle. */
export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
  ({ className, invalid, ...props }, ref) => {
    const [visible, setVisible] = useState(false);

    return (
      <div className={cn("relative w-full", className)}>
        <input
          ref={ref}
          type={visible ? "text" : "password"}
          aria-invalid={invalid || undefined}
          className={cn(
            "h-11 w-full rounded-pill border-[1.5px] border-clay bg-white/60 px-5 pr-12 text-sm text-ink",
            "placeholder:text-smoke/70 transition-colors hover:border-smoke",
            "focus:border-ink focus:outline-2 focus:outline-offset-2 focus:outline-flame",
            "disabled:cursor-not-allowed disabled:opacity-50",
            invalid && "border-danger focus:outline-danger",
          )}
          {...props}
        />
        <button
          type="button"
          onClick={() => setVisible((previous) => !previous)}
          aria-label={visible ? "Hide password" : "Show password"}
          aria-pressed={visible}
          className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-smoke transition-colors hover:bg-sand hover:text-ink"
        >
          {visible ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
        </button>
      </div>
    );
  },
);
PasswordInput.displayName = "PasswordInput";
