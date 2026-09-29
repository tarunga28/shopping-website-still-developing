import { ArrowRight } from "lucide-react";
import { Section, SectionHeader } from "@/components/layout/section";
import { ProductCard } from "@/components/ui/product-card";
import type { ProductSummary } from "@/types";

/**
 * New arrivals — horizontal rail of the freshest live catalog items.
 */
export function NewArrivals({ products }: { products: ProductSummary[] }) {
  if (products.length === 0) return null;
  const fresh = products.filter((product) => product.badge === "NEW");
  const picks = [...fresh, ...products.filter((product) => product.badge !== "NEW")].slice(0, 5);

  return (
    <Section id="new-arrivals" className="py-14 md:py-20">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <SectionHeader
          eyebrow="This week in the studio"
          title={
            <>
              New
              <br />
              arrivals<span className="text-flame">.</span>
            </>
          }
          className="mb-0"
        />
        <a
          href="/shop"
          className="group hidden items-center gap-2 rounded-pill border-[1.5px] border-ink px-5 py-2.5 text-[11px] font-semibold uppercase tracking-[0.16em] transition-all hover:bg-ink hover:text-paper sm:inline-flex"
        >
          View the full drop
          <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-1" aria-hidden />
        </a>
      </div>

      <ul className="-mx-5 mt-10 flex snap-x snap-mandatory gap-4 overflow-x-auto px-5 pb-4 sm:-mx-8 sm:gap-5 sm:px-8 lg:mx-0 lg:snap-none lg:overflow-visible lg:px-0 lg:pb-0">
        {picks.map((product, index) => (
          <li
            key={product.id}
            className={
              "w-[68vw] shrink-0 snap-start sm:w-[42vw] lg:w-auto lg:shrink " +
              (index === 0 ? "lg:basis-[24%] " : "lg:basis-[19%] ") +
              (index % 2 === 1 ? "lg:translate-y-8" : "")
            }
          >
            <ProductCard product={product} priority={index < 2} />
          </li>
        ))}
      </ul>

      <a
        href="/shop"
        className="group mt-10 inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-ink underline decoration-flame decoration-2 underline-offset-4 hover:text-flame sm:hidden"
      >
        View the full drop
        <ArrowRight className="size-3.5" aria-hidden />
      </a>
    </Section>
  );
}
