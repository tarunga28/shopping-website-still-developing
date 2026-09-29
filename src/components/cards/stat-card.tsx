import { ArrowDownRight, ArrowUpRight, Minus, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Stat card — admin/analytics KPI tiles with trend signaling.
 * Trend is visualized with icon + text, not color alone (a11y).
 */
export function StatCard({
  label,
  value,
  icon: Icon,
  trend,
  hint,
  className,
}: {
  label: string;
  value: string;
  icon?: LucideIcon;
  trend?: { direction: "up" | "down" | "flat"; label: string; good?: "up" | "down" };
  hint?: string;
  className?: string;
}) {
  const TrendIcon =
    trend?.direction === "up" ? ArrowUpRight : trend?.direction === "down" ? ArrowDownRight : Minus;
  const trendGood =
    trend === undefined ? true : trend.good ? trend.direction === trend.good : trend.direction !== "down";

  return (
    <div className={cn("flex flex-col gap-3 rounded-card border-[1.5px] border-clay bg-cream p-5", className)}>
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-smoke">{label}</p>
        {Icon ? <Icon className="size-4 text-smoke" aria-hidden /> : null}
      </div>
      <p className="font-display text-3xl font-extrabold tracking-tight">{value}</p>
      {trend ? (
        <p
          className={cn(
            "flex items-center gap-1 text-xs font-medium",
            trendGood ? "text-success" : "text-danger",
          )}
        >
          <TrendIcon className="size-3.5" aria-hidden />
          {trend.label}
        </p>
      ) : null}
      {hint ? <p className="text-[11px] text-smoke">{hint}</p> : null}
    </div>
  );
}
