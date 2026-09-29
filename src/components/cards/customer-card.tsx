import { Mail } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Customer card — admin customer listing rows.
 * Initials avatar keeps it light (no image upload requirement pre-launch).
 */
export function CustomerCard({
  customer,
  className,
}: {
  customer: {
    id: string;
    name: string;
    email: string;
    ordersCount: number;
    totalSpentPaise: number;
    segment?: "new" | "returning" | "vip";
    className?: string;
  };
  className?: string;
}) {
  const initials = customer.name
    .split(" ")
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const segmentVariant = { new: "info", returning: "soft", vip: "new" } as const;

  return (
    <article className={cn("flex items-center gap-4 rounded-card border-[1.5px] border-clay bg-cream p-5", className)}>
      <span
        aria-hidden
        className="flex size-11 shrink-0 items-center justify-center rounded-pill border-[1.5px] border-ink bg-flame font-display text-sm font-extrabold text-on-accent"
      >
        {initials}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-display text-base font-bold leading-tight">{customer.name}</p>
        <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-smoke">
          <Mail className="size-3 shrink-0" aria-hidden />
          {customer.email}
        </p>
      </div>
      <div className="hidden text-right sm:block">
        <p className="font-mono text-xs font-semibold">{customer.ordersCount} orders</p>
        <p className="mt-0.5 text-[11px] text-smoke">₹{(customer.totalSpentPaise / 100).toLocaleString("en-IN")}</p>
      </div>
      {customer.segment ? <Badge variant={segmentVariant[customer.segment]}>{customer.segment}</Badge> : null}
    </article>
  );
}
