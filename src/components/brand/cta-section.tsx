import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";
import { Container } from "@/components/ui/container";
import { cn } from "@/lib/utils";

/**
 * Reusable call-to-action band (used by the footer giant statement and
 * available for campaign surfaces).
 */
export function CtaSection({
  title,
  action,
  className,
  tone = "ink",
}: {
  title: ReactNode;
  action: { href: string; label: string };
  className?: string;
  tone?: "ink" | "paper";
}) {
  return (
    <div className={cn("px-5 py-14 sm:px-8 md:py-20 lg:px-12", className)}>
      <Container className="flex flex-col gap-8 px-0 md:flex-row md:items-end md:justify-between">
        <h2 className="max-w-3xl font-display text-5xl font-extrabold uppercase leading-[0.9] tracking-tight sm:text-6xl lg:text-7xl">
          {title}
        </h2>
        <Link
          href={action.href}
          className={cn(
            "group inline-flex w-fit items-center gap-2 rounded-pill border-[1.5px] px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.16em] transition-all",
            tone === "ink"
              ? "border-paper text-paper hover:border-flame hover:bg-flame hover:text-on-accent"
              : "border-ink text-ink hover:bg-ink hover:text-paper",
          )}
        >
          {action.label}
          <ArrowUpRight className="size-4 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" aria-hidden />
        </Link>
      </Container>
    </div>
  );
}
