import { Asterisk } from "lucide-react";
import { siteConfig } from "@/config/site";
import { cn } from "@/lib/utils";

/**
 * Brand components — centralized so a logo refresh touches exactly one file.
 */

export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("flex size-8 items-center justify-center rounded-lg bg-ink text-flame", className)}
    >
      <Asterisk className="size-5" strokeWidth={2.5} />
    </span>
  );
}

export function Logo({
  className,
  showMark = true,
  size = "md",
}: {
  className?: string;
  showMark?: boolean;
  size?: "sm" | "md" | "lg";
}) {
  const markSize = { sm: "size-6", md: "size-6", lg: "size-8" }[size];
  const textSize = { sm: "text-lg", md: "text-xl", lg: "text-2xl" }[size];

  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      {showMark ? (
        <Asterisk className={cn(markSize, "text-flame transition-transform duration-500 hover:rotate-180")} aria-hidden />
      ) : null}
      <span className={cn("font-display font-extrabold uppercase tracking-tight", textSize)}>
        {siteConfig.name}
        <sup className="ml-0.5 font-mono text-[8px] font-normal tracking-normal">®</sup>
      </span>
    </span>
  );
}
