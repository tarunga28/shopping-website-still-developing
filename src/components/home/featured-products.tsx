import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { SectionFallback } from "@/components/home/section-fallback";
import { Section, SectionHeader } from "@/components/layout/section";
import { EmptyProducts } from "@/components/ui/empty-state";
import { ProductCard } from "@/components/ui/product-card";
import { storefrontContent } from "@/content/storefront";
import { productPath } from "@/lib/storefront-paths";
import type { ProductSummary } from "@/types";
import type { SectionStatus } from "@/types/storefront";

export function FeaturedProducts({
  products,
  status = "ok",
  savedIds = [],
}: {
  products: ProductSummary[];
  status?: SectionStatus;
  savedIds?: string[];
}) {
  const copy = storefrontContent.featuredProducts;
  const saved = new Set(savedIds);

  if (status === "error") {
    return <SectionFallback id="shop" title="Featured pieces didn't load" />;
  }

  return (
    <Section id="shop">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <SectionHeader
          eyebrow={copy.eyebrow}
          title={
            <>
              {copy.titleLead}
              <br />
              {copy.titleAccent}
              <span className="text-flame">.</span>
            </>
          }
          description={copy.description}
          className="mb-0"
        />
        <Link
          href={copy.viewAll.href}
          className="mb-10 hidden min-h-11 items-center gap-2 rounded-pill border-[1.5px] border-ink px-5 text-[11px] font-semibold uppercase tracking-[0.16em] transition-colors hover:bg-ink hover:text-paper focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-flame sm:inline-flex md:mb-14"
        >
          {copy.viewAll.label}
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      </div>

      {products.length === 0 ? (
        <EmptyProducts />
      ) : (
        <ul className="grid grid-cols-2 gap-x-3 gap-y-8 sm:gap-x-5 lg:grid-cols-4">
          {products.map((product) => (
            <li key={product.id}>
              <ProductCard
                product={product}
                href={productPath(product.slug)}
                saved={saved.has(product.id)}
              />
            </li>
          ))}
        </ul>
      )}

      <Link
        href={copy.viewAll.href}
        className="mt-8 inline-flex min-h-11 items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] underline decoration-flame decoration-2 underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-flame sm:hidden"
      >
        {copy.viewAll.label}
        <ArrowRight className="size-3.5" aria-hidden />
      </Link>
    </Section>
  );
}
