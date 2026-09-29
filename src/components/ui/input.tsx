import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const inputVariants = cva(
  [
    "w-full rounded-full border-[1.5px] border-clay bg-white/60 text-ink",
    "placeholder:text-smoke/70 transition-colors duration-200",
    "hover:border-smoke focus:border-ink focus:outline-2 focus:outline-offset-2 focus:outline-flame",
    "disabled:cursor-not-allowed disabled:opacity-50",
  ].join(" "),
  {
    variants: {
      inputSize: {
        sm: "h-9 px-4 text-xs",
        md: "h-11 px-5 text-sm",
        lg: "h-13 px-6 text-base",
      },
      invalid: {
        true: "border-danger focus:outline-danger",
      },
    },
    defaultVariants: { inputSize: "md" },
  },
);

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "size">,
    VariantProps<typeof inputVariants> {}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, inputSize, invalid, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(inputVariants({ inputSize, invalid }), className)}
      aria-invalid={invalid || undefined}
      {...props}
    />
  ),
);
Input.displayName = "Input";
