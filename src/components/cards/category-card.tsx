import { ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";
import { ProductImage } from "@/components/ui/product-image";
import { formatFromPrice } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ProductCategory } from "@/types";

/**
 * Visual category tile used in the homepage mosaic and (later) the
 * categories index. Wrap it in your own link/dialog trigger.
 */
export function CategoryCard({
  category,
  size = "default",
  className,
  children,
}: {
  category: ProductCategory;
  /** "feature" fills a 2×2 mosaic cell. */
  size?: "default" | "feature";
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "group relative block w-full overflow-hidden rounded-card border-[1.5px] border-ink bg-sand text-left",
        size === "feature" ? "aspect-square lg:aspect-auto lg:h-full" : "aspect-[4/3]",
        className,
      )}
    >
      <ProductImage
        src={category.image}
        alt={category.name}
        ratio="1:1"
        rounded="rounded-none"
        sizes={size === "feature" ? "(max-width: 1024px) 100vw, 50vw" : "(max-width: 640px) 50vw, 25vw"}
        className="absolute inset-0 border-0"
        imageClassName="group-hover:scale-[1.06]"
      />
      <div className="absolute inset-0 bg-gradient-to-t from-ink/75 via-ink/15 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 p-4 sm:p-5">
        <div>
          <p className="font-display text-lg font-extrabold uppercase leading-tight text-white sm:text-xl">
            {category.name}
          </p>
          <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-white/70">
            {formatFromPrice(category.fromPricePaise)}
          </p>
        </div>
        <span className="flex size-8 shrink-0 items-center justify-center rounded-pill border-[1.5px] border-white/70 text-white transition-all duration-300 group-hover:border-flame group-hover:bg-flame group-hover:text-on-accent">
          <ArrowUpRight className="size-4" aria-hidden />
        </span>
      </div>
      {size === "feature" ? <span className="sr-only">{category.description}</span> : null}
      {children}
    </div>
  );
}
