import { Star, StarHalf } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Rating display — stars + numeric value + count.
 * Color is never the only signal: the numeric value is always present
 * for screen readers and the visual weight differs per filled state.
 */
export function Rating({
  value,
  count,
  size = "sm",
  className,
}: {
  /** 0–5, halves allowed. */
  value: number;
  count?: number;
  size?: "sm" | "md";
  className?: string;
}) {
  const rounded = Math.round(value * 2) / 2;
  const starSize = size === "sm" ? "size-3.5" : "size-4";

  return (
    <span className={cn("inline-flex items-center gap-1.5", className)} role="img" aria-label={`Rated ${value} out of 5${count ? ` from ${count} reviews` : ""}`}>
      <span className="flex" aria-hidden>
        {Array.from({ length: 5 }, (_, index) => {
          const position = index + 1;
          const full = rounded >= position;
          const half = !full && rounded >= position - 0.5;
          if (half) {
            return <StarHalf key={index} className={cn(starSize, "fill-flame text-flame")} />;
          }
          return (
            <Star
              key={index}
              className={cn(starSize, full ? "fill-flame text-flame" : "text-clay")}
            />
          );
        })}
      </span>
      <span className="font-mono text-[10px] font-medium text-smoke">
        {value.toFixed(1)}
        {count !== undefined ? ` (${count})` : ""}
      </span>
    </span>
  );
}
