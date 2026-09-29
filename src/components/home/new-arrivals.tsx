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

/**
 * Newest published products. Sorting is applied by the catalog query
 * (publishedAt desc) before this component renders.
 */
export function NewArrivals({
  products,
  status = "ok",
  savedIds = [],
}: {
  products: ProductSummary[];
  status?: SectionStatus;
  savedIds?: string[];
}) {
  const copy = storefrontContent.newArrivals;
  const saved = new Set(savedIds);

  if (status === "error") {
    return <SectionFallback id="new-arrivals" title="New arrivals didn't load" />;
  }

  if (status === "empty" || products.length === 0) {
    return (
      <Section id="new-arrivals">
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
        />
        <EmptyProducts />
      </Section>
    );
  }

  return (
    <Section id="new-arrivals">
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
          className="hidden min-h-11 items-center gap-2 rounded-pill border-[1.5px] border-ink px-5 text-[11px] font-semibold uppercase tracking-[0.16em] transition-colors hover:bg-ink hover:text-paper focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-flame sm:inline-flex"
        >
          {copy.viewAll.label}
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      </div>

      <ul className="-mx-5 mt-10 flex snap-x snap-mandatory gap-4 overflow-x-auto px-5 pb-2 sm:-mx-8 sm:px-8 lg:mx-0 lg:grid lg:grid-cols-4 lg:gap-5 lg:overflow-visible lg:px-0">
        {products.map((product) => (
          <li key={product.id} className="w-[72vw] shrink-0 snap-start sm:w-[42vw] lg:w-auto">
            <ProductCard product={product} href={productPath(product.slug)} saved={saved.has(product.id)} />
          </li>
        ))}
      </ul>

      <Link
        href={copy.viewAll.href}
        className="mt-8 inline-flex min-h-11 items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] underline decoration-flame decoration-2 underline-offset-4 sm:hidden"
      >
        {copy.viewAll.label}
        <ArrowRight className="size-3.5" aria-hidden />
      </Link>
    </Section>
  );
}
