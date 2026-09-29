import type { ReactNode } from "react";
import { Container } from "@/components/ui/container";
import { cn } from "@/lib/utils";

/** Shared section shell with editorial eyebrow + display heading. */

export function Section({
  id,
  className,
  children,
}: {
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className={cn("scroll-mt-24 py-16 md:py-24", className)}>
      <Container>{children}</Container>
    </section>
  );
}

export function SectionHeader({
  eyebrow,
  title,
  description,
  align = "left",
  tone = "ink",
  className,
}: {
  eyebrow: string;
  title: ReactNode;
  description?: string;
  align?: "left" | "center";
  tone?: "ink" | "paper";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mb-10 flex flex-col gap-4 md:mb-14",
        align === "center" && "items-center text-center",
        className,
      )}
    >
      <p
        className={cn(
          "font-mono text-[11px] font-medium uppercase tracking-[0.22em]",
          tone === "ink" ? "text-smoke" : "text-paper/60",
        )}
      >
        {eyebrow}
      </p>
      <h2
        className={cn(
          "font-display text-4xl font-extrabold uppercase leading-[0.95] tracking-tight sm:text-5xl lg:text-6xl",
          tone === "ink" ? "text-ink" : "text-paper",
        )}
      >
        {title}
      </h2>
      {description ? (
        <p className={cn("max-w-xl text-base leading-relaxed", tone === "ink" ? "text-smoke" : "text-paper/70")}>
          {description}
        </p>
      ) : null}
    </div>
  );
}
