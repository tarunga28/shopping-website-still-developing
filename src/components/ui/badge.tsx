import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/**
 * Badge system — product marketing flags + order/POD status pills.
 * All styling centralized here; consumers pass semantic variants only.
 */
const badgeVariants = cva(
  "inline-flex w-fit items-center gap-1 rounded-pill px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em]",
  {
    variants: {
      variant: {
        /* Neutrals */
        default: "bg-ink text-paper",
        soft: "border-[1.5px] border-clay bg-cream text-smoke",
        outline: "border-[1.5px] border-ink bg-transparent text-ink",
        "outline-paper": "border-[1.5px] border-paper bg-transparent text-paper",

        /* Product flags */
        new: "bg-flame text-on-accent",
        bestseller: "bg-ink text-paper",
        sale: "bg-danger text-[#fff]",
        limited: "border-[1.5px] border-ink bg-cream text-ink",
        "sold-out": "bg-sand text-smoke line-through",
        "coming-soon": "border-[1.5px] border-dashed border-ink bg-transparent text-ink",

        /* Order / fulfillment states (never color-only: consumers add
           readable labels next to these pills) */
        processing: "border-[1.5px] border-info/60 bg-info/10 text-info",
        shipped: "border-[1.5px] border-warning/60 bg-warning/10 text-warning",
        delivered: "border-[1.5px] border-success/60 bg-success/10 text-success",
        cancelled: "border-[1.5px] border-danger/60 bg-danger/10 text-danger",

        /* Generic states */
        success: "border-[1.5px] border-success/60 bg-success/10 text-success",
        warning: "border-[1.5px] border-warning/60 bg-warning/10 text-warning",
        danger: "border-[1.5px] border-danger/60 bg-danger/10 text-danger",
        info: "border-[1.5px] border-info/60 bg-info/10 text-info",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

/** Order status → consistent pill. Shared by account + admin surfaces. */
export type OrderStatus = "processing" | "shipped" | "delivered" | "cancelled";

const statusLabel: Record<OrderStatus, string> = {
  processing: "Processing",
  shipped: "Shipped",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

export function StatusBadge({ status, className }: { status: OrderStatus; className?: string }) {
  return (
    <Badge variant={status} className={className}>
      {statusLabel[status]}
    </Badge>
  );
}

export { badgeVariants };
