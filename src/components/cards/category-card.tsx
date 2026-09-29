import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { ProductImage } from "@/components/ui/product-image";
import { formatFromPrice } from "@/lib/format";
import { categoryPath } from "@/lib/storefront-paths";
import { cn } from "@/lib/utils";

export interface CategoryCardModel {
  slug: string;
  name: string;
  description: string;
  image: string;
  imageAlt?: string;
  fromPricePaise?: number | null;
  productCount?: number;
}

/**
 * Category tile. The whole card is one link so it is keyboard accessible
 * without a nested button.
 */
export function CategoryCard({
  category,
  href,
  size = "default",
  cta = "Shop",
  className,
}: {
  category: CategoryCardModel;
  href?: string;
  size?: "default" | "feature";
  cta?: string;
  className?: string;
}) {
  const destination = href ?? categoryPath(category.slug);
  const price =
    typeof category.fromPricePaise === "number" && category.fromPricePaise > 0
      ? formatFromPrice(category.fromPricePaise)
      : null;

  return (
    <Link
      href={destination}
      data-track="CATEGORY_CLICK"
      data-track-id={category.slug}
      data-track-label={category.name}
      className={cn(
        "group relative flex h-full w-full flex-col overflow-hidden rounded-card border-[1.5px] border-ink bg-sand text-left",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-flame",
        size === "feature" ? "min-h-[16rem] sm:min-h-[22rem]" : "min-h-[11rem] aspect-[4/5] sm:aspect-[4/3]",
        className,
      )}
    >
      <ProductImage
        src={category.image}
        alt={category.imageAlt || category.name}
        ratio="1:1"
        rounded="rounded-none"
        sizes={size === "feature" ? "(max-width: 1024px) 100vw, 50vw" : "(max-width: 640px) 50vw, 25vw"}
        className="absolute inset-0 h-full border-0"
        imageClassName="transition-transform duration-500 group-hover:scale-[1.04]"
      />
      <span className="absolute inset-0 bg-gradient-to-t from-ink/80 via-ink/25 to-ink/10" aria-hidden />
      <span className="relative mt-auto flex items-end justify-between gap-3 p-4 sm:p-5">
        <span className="min-w-0">
          <span className="block font-display text-lg font-extrabold uppercase leading-tight text-paper sm:text-xl">
            {category.name}
          </span>
          {category.description ? (
            <span className="mt-1 line-clamp-2 block text-xs leading-snug text-paper/80">{category.description}</span>
          ) : null}
          <span className="mt-2 inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.16em] text-paper">
            {cta}
            {price ? <span className="text-paper/70">· {price}</span> : null}
            {typeof category.productCount === "number" ? (
              <span className="sr-only">
                , {category.productCount} {category.productCount === 1 ? "product" : "products"}
              </span>
            ) : null}
          </span>
        </span>
        <span className="flex size-10 shrink-0 items-center justify-center rounded-pill border-[1.5px] border-paper/80 text-paper transition-colors duration-300 group-hover:border-flame group-hover:bg-flame group-hover:text-on-accent">
          <ArrowUpRight className="size-4" aria-hidden />
        </span>
      </span>
    </Link>
  );
}
