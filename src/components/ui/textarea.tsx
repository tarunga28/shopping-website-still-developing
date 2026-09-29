import { forwardRef, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
  success?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, invalid, success, ...props }, ref) => (
    <textarea
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        "w-full rounded-image border-[1.5px] border-clay bg-white/60 px-5 py-3.5 text-sm text-ink",
        "min-h-28 resize-y placeholder:text-smoke/70 transition-colors duration-200",
        "hover:border-smoke focus:border-ink focus:outline-2 focus:outline-offset-2 focus:outline-flame",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "data-[theme=dark]:bg-white/5",
        invalid && "border-danger focus:outline-danger",
        success && "border-success",
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";
