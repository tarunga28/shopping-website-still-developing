import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Analytics card — chart wrapper with consistent header/actions chrome.
 * The chart body is injected by the analytics milestone (e.g. sparkline,
 * bars) — this component owns the frame and loading contract.
 */
export function AnalyticsCard({
  title,
  description,
  icon: Icon,
  actions,
  children,
  className,
}: {
  title: string;
  description?: string;
  icon?: LucideIcon;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-label={title}
      className={cn("flex flex-col gap-4 rounded-card border-[1.5px] border-clay bg-cream p-5", className)}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          {Icon ? (
            <span className="flex size-8 items-center justify-center rounded-pill border-[1.5px] border-ink" aria-hidden>
              <Icon className="size-4" />
            </span>
          ) : null}
          <div>
            <h3 className="font-display text-base font-bold uppercase leading-tight">{title}</h3>
            {description ? <p className="mt-0.5 text-xs text-smoke">{description}</p> : null}
          </div>
        </div>
        {actions}
      </header>
      <div className="min-h-32">{children}</div>
    </section>
  );
}
