import { Leaf, Printer, ShieldCheck, Truck, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Trust indicators — only verifiable claims about how the model works.
 */
const indicators: { icon: LucideIcon; label: string; description: string }[] = [
  { icon: Printer, label: "Printed to order", description: "Made after you order, never warehoused" },
  { icon: ShieldCheck, label: "Quality checked", description: "Each piece inspected before packing" },
  { icon: Truck, label: "Tracked shipping", description: "Pan-India delivery with live updates" },
  { icon: Leaf, label: "Zero overstock", description: "No mass production, no landfill fashion" },
];

export function TrustIndicators({
  variant = "row",
  className,
}: {
  variant?: "row" | "grid";
  className?: string;
}) {
  return (
    <ul
      className={cn(
        variant === "grid" ? "grid grid-cols-2 gap-3 lg:grid-cols-4" : "flex flex-wrap gap-x-6 gap-y-3",
        className,
      )}
    >
      {indicators.map(({ icon: Icon, label, description }) => (
        <li
          key={label}
          className={cn(
            "flex items-center gap-2.5",
            variant === "grid" && "rounded-card border-[1.5px] border-clay bg-cream p-4",
          )}
        >
          <Icon className="size-4 shrink-0 text-flame" aria-hidden />
          {variant === "grid" ? (
            <span>
              <span className="block text-xs font-semibold uppercase tracking-[0.1em]">{label}</span>
              <span className="mt-0.5 block text-[11px] leading-snug text-smoke">{description}</span>
            </span>
          ) : (
            <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-smoke">{label}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
