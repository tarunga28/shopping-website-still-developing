import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { LoaderCircle } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-pill",
    "text-xs font-semibold uppercase tracking-[0.14em]",
    "border-[1.5px] transition-all duration-300 ease-out",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-flame",
    "disabled:pointer-events-none disabled:opacity-50",
    "active:scale-[0.97]",
  ].join(" "),
  {
    variants: {
      variant: {
        primary: "border-ink bg-ink text-paper hover:border-flame hover:bg-flame hover:text-on-accent",
        secondary: "border-clay bg-sand text-ink hover:border-ink hover:bg-cream",
        accent: "border-flame bg-flame text-on-accent hover:border-ink hover:bg-ink hover:text-paper",
        outline: "border-ink bg-transparent text-ink hover:bg-ink hover:text-paper",
        "outline-paper": "border-paper bg-transparent text-paper hover:bg-paper hover:text-ink",
        ghost: "border-transparent bg-transparent text-ink hover:bg-sand/60",
        inverse: "border-paper bg-paper text-ink hover:bg-flame hover:border-flame hover:text-on-accent",
        danger: "border-danger bg-danger text-[#fff] hover:brightness-110",
        "outline-danger": "border-danger bg-transparent text-danger hover:bg-danger hover:text-[#fff]",
        success: "border-success bg-success text-[#fff] hover:brightness-110",
        link: "border-transparent bg-transparent px-0 text-ink underline decoration-flame decoration-2 underline-offset-4 hover:text-flame active:scale-100",
      },
      size: {
        xs: "h-8 px-3.5 text-[10px]",
        sm: "h-9 px-4",
        md: "h-11 px-6",
        lg: "h-13 px-8 text-sm",
        icon: "h-11 w-11 p-0",
        "icon-sm": "h-9 w-9 p-0",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** Render as a different element (e.g. Next `<Link>`) preserving styles. */
  asChild?: boolean;
  /** Shows a spinner, disables interaction and marks the control busy. */
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading = false, disabled, children, ...props }, ref) => {
    // Radix Slot requires exactly one element child — spinner injection
    // (an extra sibling node) is only valid in native-button mode.
    if (asChild) {
      return (
        <Slot
          ref={ref}
          className={cn(buttonVariants({ variant, size }), className)}
          aria-busy={loading || undefined}
          {...props}
        >
          {children}
        </Slot>
      );
    }

    return (
      <button
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {loading ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : null}
        {children}
      </button>
    );
  },
);
Button.displayName = "Button";

export { buttonVariants };

/** Standalone icon affordance with brand ring (header actions, toolbars). */
export const IconButton = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <Button
      ref={ref}
      variant={variant ?? "outline"}
      size={size ?? "icon-sm"}
      className={cn("bg-paper", className)}
      {...props}
    />
  ),
);
IconButton.displayName = "IconButton";
