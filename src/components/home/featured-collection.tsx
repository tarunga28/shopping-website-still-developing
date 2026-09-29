import Image from "next/image";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { SectionFallback } from "@/components/home/section-fallback";
import { Section, SectionHeader } from "@/components/layout/section";
import { ProductCard } from "@/components/ui/product-card";
import { EmptyState } from "@/components/ui/empty-state";
import { storefrontContent } from "@/content/storefront";
import { collectionPath, productPath } from "@/lib/storefront-paths";
import { plainText } from "@/lib/plain-text";
import type { ProductSummary } from "@/types";
import type { SectionStatus, StorefrontCollection } from "@/types/storefront";
import { LayoutGrid } from "lucide-react";

export function FeaturedCollection({
  collection,
  products,
  status = "ok",
  savedIds = [],
}: {
  collection: StorefrontCollection | null;
  products: ProductSummary[];
  status?: SectionStatus;
  savedIds?: string[];
}) {
  const copy = storefrontContent.featuredCollection;

  if (status === "error") {
    return <SectionFallback id="collection" title="The collection didn't load" />;
  }

  if (!collection) {
    return (
      <Section id="collection">
        <SectionHeader
          eyebrow={copy.eyebrow}
          title={
            <>
              {copy.emptyTitle}
              <span className="text-flame">.</span>
            </>
          }
          description={copy.emptyDescription}
        />
        <EmptyState icon={LayoutGrid} title="Nothing scheduled" description={copy.emptyDescription} />
      </Section>
    );
  }

  const href = collectionPath(collection.slug);
  const image = collection.image || copy.fallbackImage;
  const imageAlt = collection.image ? collection.imageAlt : copy.fallbackImageAlt;
  const saved = new Set(savedIds);
  const description = plainText(collection.description, 280);

  return (
    <Section id="collection">
      <div className="grid items-center gap-8 overflow-hidden rounded-panel border-[1.5px] border-ink bg-ink text-paper lg:grid-cols-2">
        <div className="relative aspect-[4/5] min-h-[16rem] sm:aspect-[5/4] lg:aspect-auto lg:h-full lg:min-h-[32rem]">
          <Image
            src={image}
            alt={imageAlt}
            fill
            sizes="(max-width: 1024px) 100vw, 50vw"
            className="object-cover"
          />
        </div>
        <div className="px-6 py-8 sm:px-10 sm:py-12 lg:pr-12">
          <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-paper/60">{copy.eyebrow}</p>
          <h2 className="mt-3 font-display text-4xl font-extrabold uppercase leading-[0.95] sm:text-5xl lg:text-6xl">
            {collection.name}
            <span className="text-flame">.</span>
          </h2>
          {description ? <p className="mt-4 max-w-md text-sm leading-relaxed text-paper/75 sm:text-base">{description}</p> : null}
          <Link
            href={href}
            data-track="COLLECTION_CLICK"
            data-track-id={collection.slug}
            data-track-label={collection.name}
            className="mt-8 inline-flex min-h-11 items-center gap-2 rounded-pill bg-flame px-6 text-[11px] font-semibold uppercase tracking-[0.14em] text-on-accent transition-colors hover:bg-paper hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-paper"
          >
            {copy.ctaLabel}
            <ArrowRight className="size-4" aria-hidden />
          </Link>
        </div>
      </div>

      {products.length > 0 ? (
        <ul className="mt-8 grid grid-cols-2 gap-x-3 gap-y-8 sm:gap-x-5 lg:grid-cols-4">
          {products.slice(0, 4).map((product) => (
            <li key={product.id}>
              <ProductCard product={product} href={productPath(product.slug)} saved={saved.has(product.id)} />
            </li>
          ))}
        </ul>
      ) : null}
    </Section>
  );
}
